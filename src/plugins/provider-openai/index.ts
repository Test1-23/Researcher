/**
 * OpenAI 兼容的大模型适配器。
 *
 * 一套实现覆盖 DeepSeek、OpenAI、以及任何 OpenAI 兼容端点（vLLM / Ollama / 网关）：
 * 换后端只需要改 base_url、model 与 key，不需要改代码——这正是 provider 作为插件的目的。
 */

import { resolveApiKey, sectionNumber, sectionPositiveInt, sectionString } from '../../main/engine/config.ts'
import { cancelled, isAbortError, RateLimitError, ResearcherError } from '../../main/engine/errors.ts'
import { definePlugin } from '../../main/engine/registry.ts'
import type {
  AvailabilityContext,
  CompleteRequest,
  CompleteResult,
  LlmProvider,
  PluginContext,
  PluginManifest,
  TokenUsage,
} from '../../main/engine/types.ts'

/** 默认端点：DeepSeek 的 OpenAI 兼容接口。 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/** 默认模型。 */
export const OPENAI_DEFAULT_MODEL = 'deepseek-chat'

/** 429 / 5xx 时的最大尝试次数（含首次）。 */
const MAX_ATTEMPTS = 2

/** 首次退避时长，之后线性递增。 */
const BASE_BACKOFF_MS = 1200

interface ChatCompletionResponse {
  readonly model?: string
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null }
    readonly finish_reason?: string
  }[]
  readonly usage?: {
    readonly prompt_tokens?: number
    readonly completion_tokens?: number
  }
  readonly error?: { readonly message?: string } | string
  readonly message?: string
}

/** OpenAI 兼容 provider。 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id = 'provider-openai'
  readonly kind = 'provider' as const

  /** 只做本地检查：有 key、端点合法、model 非空即视为可用。 */
  available(ctx: AvailabilityContext): boolean {
    const baseUrl = sectionString(ctx.section, 'baseUrl', OPENAI_DEFAULT_BASE_URL)
    const model = sectionString(ctx.section, 'model', OPENAI_DEFAULT_MODEL)
    return resolveApiKey(ctx.section, 'DEEPSEEK_API_KEY') !== undefined
      && URL.canParse(baseUrl)
      && model.length > 0
  }

  async complete(request: CompleteRequest, ctx: PluginContext, signal?: AbortSignal): Promise<CompleteResult> {
    const section = ctx.config.section(this.id)
    const baseUrl = sectionString(section, 'baseUrl', OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '')
    const model = sectionString(section, 'model', OPENAI_DEFAULT_MODEL)
    const temperature = request.temperature ?? sectionNumber(section, 'temperature', 0.2)
    const maxTokens = request.maxTokens ?? sectionPositiveInt(section, 'maxTokens', 4096)

    const apiKey = resolveApiKey(section, 'DEEPSEEK_API_KEY')
    if (apiKey === undefined) {
      throw new ResearcherError(
        '大模型插件缺少 API key：请在设置中填写，或把 DEEPSEEK_API_KEY 放进环境变量。',
        'LLM_UNAVAILABLE',
      )
    }

    const endpoint = `${baseUrl}/chat/completions`
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      temperature,
      max_tokens: maxTokens,
    }
    if (request.json === true) body['response_format'] = { type: 'json_object' }

    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted === true) throw cancelled(signal)
      try {
        return await this.dispatch(endpoint, apiKey, body, model, ctx, signal)
      } catch (error) {
        lastError = error
        // 只有限流与上游 5xx 值得重试；参数错误、鉴权失败重试没有意义。
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) throw error
        ctx.log.warn(`${this.id} 第 ${attempt} 次请求失败（${describe(error)}），退避后重试`)
        await sleep(BASE_BACKOFF_MS * attempt, signal)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ResearcherError('大模型请求失败', 'LLM_FAILED')
  }

  /** 发一次请求并解析结果。 */
  private async dispatch(
    endpoint: string,
    apiKey: string,
    body: Record<string, unknown>,
    model: string,
    ctx: PluginContext,
    signal?: AbortSignal,
  ): Promise<CompleteResult> {
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': ctx.fetch.userAgent,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted === true) throw cancelled(signal, error)
      if (isAbortError(error)) {
        throw new ResearcherError(`大模型请求超时或被中断：${describe(error)}`, 'LLM_FAILED', { cause: error })
      }
      throw new ResearcherError(
        `无法连接大模型端点 ${endpoint}：${describe(error)}。请在设置中检查 Base URL。`,
        'LLM_FAILED',
        { cause: error },
      )
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response)
      const text = `大模型请求失败（HTTP ${response.status}）${detail}。端点：${endpoint}`
      if (response.status === 429) throw new RateLimitError(text)
      throw new ResearcherError(text, 'LLM_FAILED')
    }

    let payload: ChatCompletionResponse
    try {
      payload = await response.json() as ChatCompletionResponse
    } catch (error) {
      throw new ResearcherError(`大模型返回了无法解析的响应体：${describe(error)}`, 'LLM_FAILED', { cause: error })
    }

    const choice = payload.choices?.[0]
    const text = choice?.message?.content
    if (typeof text !== 'string' || text.length === 0) {
      const reason = choice?.finish_reason
      throw new ResearcherError(
        `大模型没有返回内容${reason !== undefined ? `（finish_reason=${reason}）` : ''}。`
        + '若为 length，请调大该插件的 maxTokens。',
        'LLM_FAILED',
      )
    }

    const usage: TokenUsage | undefined = payload.usage === undefined
      ? undefined
      : {
          promptTokens: payload.usage.prompt_tokens ?? 0,
          completionTokens: payload.usage.completion_tokens ?? 0,
        }

    return {
      text,
      model: typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : model,
      ...(usage === undefined ? {} : { usage }),
    }
  }
}

/** 限流与上游 5xx 可以重试。 */
function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError) return true
  if (error instanceof ResearcherError && error.code === 'LLM_FAILED') {
    // 只有带 HTTP 5xx 字样的失败才重试
    return /HTTP 5\d\d/.test(error.message)
  }
  return false
}

/** 尽力从错误响应里取出可读细节。 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const raw = await response.text()
    if (raw.length === 0) return ''
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string }
      const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
      if (typeof detail === 'string' && detail.length > 0) return `：${detail}`
    } catch {
      return `：${raw.slice(0, 200)}`
    }
    return ''
  } catch {
    return ''
  }
}

/** 可被取消打断的等待。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelled(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelled(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 从任意异常取可读信息。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 插件清单。 */
export const openAiProviderPlugin: PluginManifest = definePlugin({
  id: 'provider-openai',
  kind: 'provider',
  version: '0.1.0',
  title: 'OpenAI 兼容大模型',
  description: '任何 OpenAI 兼容的 /chat/completions 端点：DeepSeek（默认）、OpenAI、vLLM、Ollama 或自建网关。',
  entry: new OpenAiCompatibleProvider(),
})
