/**
 * 内核自带的网页抓取服务。
 *
 * 抓取是通用管道能力（不是领域逻辑），因此由内核提供而不是做成插件；
 * 搜索/整理插件通过 `ctx.fetch` 使用它，超时、体积上限与内容类型策略只有一处实现。
 */

import { cancelled, FetchError, isAbortError, ResearcherError, throwIfAborted } from './errors.ts'
import { extractText } from './html.ts'
import type { FetchedDocument, FetchService, RawResponse } from './types.ts'

/** 可以当作文本处理的内容类型。 */
const TEXTUAL_CONTENT_TYPE =
  /^(?:text\/|application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml|javascript))/i

const JSON_CONTENT_TYPE = /(?:json|javascript)/i

/** 一次重试的通知，交给内核写进运行日志，让「这次为什么慢」有据可查。 */
export interface FetchRetryInfo {
  readonly url: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly reason: string
  readonly delayMs: number
}

/** 构造参数。 */
export interface HttpFetchOptions {
  readonly timeoutMs: number
  readonly maxBytes: number
  /** 抽取后正文的字符上限，超出则截断。默认 20000。 */
  readonly maxTextChars?: number
  /** 瞬时故障的重试次数（不含首次）。默认 0，即不重试。 */
  readonly maxRetries?: number
  /** 首次退避时长，之后翻倍。默认 600ms。 */
  readonly retryBaseDelayMs?: number
  readonly userAgent: string
  /** 注入点：测试可替换 fetch 实现，默认使用全局 fetch。 */
  readonly fetchImpl?: typeof fetch
  /** 发生重试时回调，用于写日志。 */
  readonly onRetry?: (info: FetchRetryInfo) => void
}

/**
 * GET 抓取服务。
 *
 * 对**瞬时**故障（连接被重置、TLS 握手被丢、超时、429、5xx）做有限重试。
 * 这不是锦上添花：本机曾出现过出口代理偶发丢掉 TLS 握手，一次不重试就让整轮研究失败。
 */
export class HttpFetchService implements FetchService {
  readonly userAgent: string
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly maxTextChars: number
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number
  private readonly fetchImpl: typeof fetch
  private readonly onRetry: ((info: FetchRetryInfo) => void) | undefined

  constructor(options: HttpFetchOptions) {
    this.userAgent = options.userAgent
    this.timeoutMs = options.timeoutMs
    this.maxBytes = options.maxBytes
    this.maxTextChars = options.maxTextChars ?? 20_000
    this.maxRetries = Math.max(0, options.maxRetries ?? 0)
    this.retryBaseDelayMs = Math.max(1, options.retryBaseDelayMs ?? 600)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.onRetry = options.onRetry
  }

  /**
   * 抓取原始响应体，不做正文抽取。
   * 需要自己解析页面结构的插件（例如搜索后端）用这个。
   */
  async fetchRaw(rawUrl: string, signal?: AbortSignal): Promise<RawResponse> {
    throwIfAborted(signal)
    const url = parseHttpUrl(rawUrl)
    const maxAttempts = this.maxRetries + 1

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attemptRaw(url, rawUrl, signal)
      } catch (error) {
        // 取消永远不重试：用户点了取消，不该再偷偷发一次请求。
        if (signal?.aborted === true) throw cancelled(signal, error)
        if (attempt >= maxAttempts || !isRetryable(error)) throw error

        const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 120)
        this.onRetry?.({
          url: rawUrl,
          attempt,
          maxAttempts,
          reason: retryReason(error),
          delayMs,
        })
        await backoff(delayMs, signal)
      }
    }
  }

  /** 发一次请求；重试策略在外面。 */
  private async attemptRaw(url: URL, rawUrl: string, signal?: AbortSignal): Promise<RawResponse> {
    // 超时与调用方取消合成一个信号：取消要立刻生效，超时也不能无限等。
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: combined,
      })
    } catch (error) {
      // 调用方取消与超时都是 AbortError，必须区分：取消不是失败。
      if (signal?.aborted === true) throw cancelled(signal, error)
      if (isAbortError(error)) {
        throw new FetchError(`抓取超时（>${this.timeoutMs}ms）`, rawUrl, undefined, { cause: error })
      }
      throw new FetchError(`网络请求失败：${errorMessage(error)}`, rawUrl, undefined, { cause: error })
    }

    if (!response.ok) {
      await drain(response)
      throw new FetchError(
        `HTTP ${response.status}${response.statusText.length > 0 ? ` ${response.statusText}` : ''}`,
        rawUrl,
        response.status,
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.length > 0 && !TEXTUAL_CONTENT_TYPE.test(contentType)) {
      await drain(response)
      throw new FetchError(`不支持的内容类型：${contentType.split(';')[0]?.trim() ?? contentType}`, rawUrl, response.status)
    }

    const body = await readCapped(response, this.maxBytes)
    return {
      url: response.url.length > 0 ? response.url : rawUrl,
      status: response.status,
      contentType,
      body: body.text,
      truncated: body.truncated,
    }
  }

  /**
   * 抓取一个 URL 并抽取正文。
   *
   * 非 2xx、超时、超过体积上限、不支持的内容类型都抛 {@link FetchError}
   * （调用方据此记录 fetchFailures，单个来源失败不影响整次运行）。
   */
  async fetchText(rawUrl: string, signal?: AbortSignal): Promise<FetchedDocument> {
    const raw = await this.fetchRaw(rawUrl, signal)

    if (JSON_CONTENT_TYPE.test(raw.contentType)) {
      const clipped = raw.body.length > this.maxTextChars
      return {
        url: raw.url,
        status: raw.status,
        text: clipped ? raw.body.slice(0, this.maxTextChars) : raw.body,
        truncated: raw.truncated || clipped,
      }
    }

    const extracted = extractText(raw.body)
    const clipped = extracted.text.length > this.maxTextChars
    return {
      url: raw.url,
      status: raw.status,
      ...(extracted.title === undefined ? {} : { title: extracted.title }),
      text: clipped ? extracted.text.slice(0, this.maxTextChars) : extracted.text,
      truncated: raw.truncated || clipped,
    }
  }
}

/** 只接受 http/https 的绝对 URL。 */
function parseHttpUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new FetchError(`无效的 URL：${rawUrl}`, rawUrl)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError(`不支持的协议：${url.protocol}`, rawUrl)
  }
  return url
}

/** 丢弃不需要读取的响应体，避免连接泄漏。 */
async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* 已经结束或无法取消都无所谓 */
  }
}

/** 最多读取 maxBytes 字节，超出即停止并标记截断。 */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    const remaining = maxBytes - total
    if (buffer.byteLength >= remaining) {
      const keep = Math.max(remaining, 0)
      if (keep > 0) chunks.push(buffer.subarray(0, keep))
      total += keep
      truncated = true
      break
    }
    chunks.push(buffer)
    total += buffer.byteLength
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

/**
 * 是否值得重试。
 *
 * 只看「重发一次可能就好了」的故障：连接层失败（含 TLS 握手被丢）、超时、429、5xx。
 * 4xx 是请求本身的问题，重试只会白费一次往返。
 * 无效 URL / 不支持的协议在进入重试循环之前就已抛出，因此不会走到这里。
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof FetchError)) return false
  if (error.status === undefined) return true // 网络层失败或超时
  if (error.status === 429) return true
  return error.status >= 500
}

/** 可被取消打断的退避等待。 */
function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelled(signal))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelled(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 取一条适合写进日志的失败原因。
 *
 * FetchError 的消息已经是给人看的（例如「网络请求失败：<底层原因>」），
 * 所以直接用它；再去解一层 cause 反而会把真正的细节丢掉。
 */
function retryReason(error: unknown): string {
  if (error instanceof ResearcherError) return error.message
  return errorMessage(error)
}

/** 从任意异常里取一条可读信息。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message.length > 0) return cause.message
    return error.message
  }
  return String(error)
}
