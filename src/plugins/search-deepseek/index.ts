/**
 * DeepSeek 原生 web_search 搜索后端。
 *
 * 走 DeepSeek 的 Anthropic 兼容 Messages 端点，使用其原生 `web_search_20250305` 工具：
 * 一次搜索是一次带工具的模型调用，返回结构化结果块而不是需要抓页面猜结构的 HTML。
 * 复用同一个 DeepSeek API key，因此用户配置一次即可同时用于搜索与大模型。
 *
 * 参考 DSH 的 `web-search-deepseek` 实现（同一套端点与工具协议）。
 */

import { resolveApiKey, sectionPositiveInt, sectionString } from '../../main/engine/config.ts'
import { isAbortError, RateLimitError, ResearcherError, toResearcherError } from '../../main/engine/errors.ts'
import { definePlugin } from '../../main/engine/registry.ts'
import type {
  AvailabilityContext,
  PluginContext,
  PluginManifest,
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchSource,
} from '../../main/engine/types.ts'

/** 默认端点：DeepSeek 的 Anthropic 兼容 API（注意与 chat/completions 的 base 不同）。 */
export const DEEPSEEK_SEARCH_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** 默认模型。 */
export const DEEPSEEK_SEARCH_DEFAULT_MODEL = 'deepseek-chat'

/** Anthropic 协议版本头。 */
export const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01'

/** 单次请求内 web_search 工具的最大调用次数。 */
const DEFAULT_MAX_USES = 5

/** 为触发原生搜索而发送的提示词。 */
function searchPrompt(query: string): string {
  return `Perform a web search for the query: ${query}`
}

// ───────────────────────── 响应形状（只声明用得到的字段） ─────────────────────────

interface Citation {
  readonly url?: string
  readonly cited_text?: string
}

interface TextBlock {
  readonly type?: string
  readonly text?: string
  readonly citations?: readonly Citation[]
}

interface SearchResultItem {
  readonly type?: string
  readonly url?: string
  readonly title?: string
  readonly page_age?: string
}

interface SearchResultBlock {
  readonly type?: string
  readonly content?: readonly SearchResultItem[]
}

type ContentBlock = TextBlock & SearchResultBlock

interface MessagesResponse {
  readonly content?: readonly ContentBlock[]
  readonly error?: { readonly message?: string } | string
  readonly message?: string
}

/**
 * 从 `text` 块的 citations 里取出 `url → 引用片段` 映射。
 *
 * Anthropic 协议的 `web_search_result` 项通常只带 url/title/page_age，没有摘要；
 * 真正的摘要在正文块的 citation 里，按 url 关联（首次出现优先）。
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const citation of block.citations ?? []) {
      const url = citation.url
      const text = citation.cited_text
      if (typeof url !== 'string' || url.length === 0) continue
      if (typeof text !== 'string' || text.length === 0) continue
      if (!map.has(url)) map.set(url, text)
    }
  }
  return map
}

/**
 * 把 Messages 响应映射成归一化来源列表。
 * 按 url 去重（max_uses > 1 时同一 URL 可能跨多次搜索重复出现）。
 */
export function mapDeepSeekSearchResponse(response: MessagesResponse): SearchSource[] {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter((block) => block.type === 'web_search_tool_result')
  if (resultBlocks.length === 0) {
    throw new ResearcherError(
      'DeepSeek 没有返回 web_search_tool_result 块：这次请求可能没有触发原生联网搜索。'
      + '请确认所选模型支持 web_search 工具，或改用 search-duckduckgo。',
      'SEARCH_FAILED',
    )
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: SearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result') continue
      const url = item.url
      if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
      seen.add(url)
      const snippet = snippets.get(url)
      sources.push({
        url,
        ...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
        ...(snippet === undefined ? {} : { snippet }),
        ...(typeof item.page_age === 'string' && item.page_age.length > 0 ? { publishedAt: item.page_age } : {}),
      })
    }
  }
  return sources
}

/** DeepSeek 原生搜索插件。 */
export class DeepSeekSearchProvider implements SearchProvider {
  readonly id = 'search-deepseek'
  readonly kind = 'search' as const

  /** 只做本地检查：有 key 且端点合法即视为可用，绝不发网络请求。 */
  available(ctx: AvailabilityContext): boolean {
    const baseUrl = sectionString(ctx.section, 'baseUrl', DEEPSEEK_SEARCH_DEFAULT_BASE_URL)
    return resolveApiKey(ctx.section, 'DEEPSEEK_API_KEY') !== undefined && URL.canParse(baseUrl)
  }

  async search(request: SearchRequest, ctx: PluginContext, signal?: AbortSignal): Promise<SearchResult> {
    const section = ctx.config.section(this.id)
    const baseUrl = sectionString(section, 'baseUrl', DEEPSEEK_SEARCH_DEFAULT_BASE_URL).replace(/\/+$/, '')
    const model = sectionString(section, 'model', DEEPSEEK_SEARCH_DEFAULT_MODEL)
    const maxUses = sectionPositiveInt(section, 'maxUses', DEFAULT_MAX_USES)
    const maxTokens = sectionPositiveInt(section, 'maxTokens', 4096)

    const apiKey = resolveApiKey(section, 'DEEPSEEK_API_KEY')
    if (apiKey === undefined) {
      throw new ResearcherError(
        'DeepSeek 搜索缺少 API key：请在设置中填写，或把 DEEPSEEK_API_KEY 放进环境变量，'
        + '否则请把搜索插件切换为 search-duckduckgo（免 key）。',
        'SEARCH_UNAVAILABLE',
      )
    }

    const endpoint = `${baseUrl}/messages`
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [{
        role: 'user' as const,
        content: [{ type: 'text' as const, text: searchPrompt(request.query) }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    }

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          // 官方端点认 x-api-key；Anthropic 兼容代理可能认 Bearer，两个都发。
          'x-api-key': apiKey,
          authorization: `Bearer ${apiKey}`,
          'anthropic-version': DEEPSEEK_DEFAULT_API_VERSION,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': ctx.fetch.userAgent,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (signal?.aborted === true) throw toResearcherError(error, 'DeepSeek 搜索已取消')
      if (isAbortError(error)) throw new ResearcherError(`DeepSeek 搜索请求超时或被中断：${message(error)}`, 'SEARCH_FAILED', { cause: error })
      throw new ResearcherError(
        `无法连接 DeepSeek 搜索端点 ${endpoint}：${message(error)}。请在设置中检查搜索插件的 Endpoint。`,
        'SEARCH_FAILED',
        { cause: error },
      )
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response)
      if (response.status === 429) {
        throw new RateLimitError(`DeepSeek 搜索被限流（HTTP 429）${detail}`, { cause: undefined })
      }
      throw new ResearcherError(
        `DeepSeek 搜索失败（HTTP ${response.status}）${detail}。端点：${endpoint}`,
        'SEARCH_FAILED',
      )
    }

    let payload: MessagesResponse
    try {
      payload = await response.json() as MessagesResponse
    } catch (error) {
      throw new ResearcherError(`DeepSeek 返回了无法解析的响应体：${message(error)}`, 'SEARCH_FAILED', { cause: error })
    }

    const parsed = mapDeepSeekSearchResponse(payload)
    const limit = request.maxResults
    const sources = limit === undefined ? parsed : parsed.slice(0, limit)
    return {
      providerId: this.id,
      sources,
      truncated: sources.length < parsed.length,
    }
  }
}

/** 尽力从错误响应里取出可读细节。 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (text.length === 0) return ''
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
      const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
      if (typeof detail === 'string' && detail.length > 0) return `：${detail}`
    } catch {
      return `：${text.slice(0, 200)}`
    }
    return ''
  } catch {
    return ''
  }
}

/** 从任意异常取可读信息。 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 插件清单。 */
export const deepSeekSearchPlugin: PluginManifest = definePlugin({
  id: 'search-deepseek',
  kind: 'search',
  version: '0.1.0',
  title: 'DeepSeek 原生搜索',
  description: '通过 DeepSeek 的 Anthropic 兼容 Messages 端点调用原生 web_search 工具，复用同一个 API key。',
  entry: new DeepSeekSearchProvider(),
})
