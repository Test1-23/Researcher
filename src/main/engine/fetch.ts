/**
 * 内核自带的网页抓取服务。
 *
 * 抓取是通用管道能力（不是领域逻辑），因此由内核提供而不是做成插件；
 * 搜索/整理插件通过 `ctx.fetch` 使用它，超时、体积上限与内容类型策略只有一处实现。
 */

import { cancelled, FetchError, isAbortError, throwIfAborted } from './errors.ts'
import { extractText } from './html.ts'
import type { FetchedDocument, FetchService, RawResponse } from './types.ts'

/** 可以当作文本处理的内容类型。 */
const TEXTUAL_CONTENT_TYPE =
  /^(?:text\/|application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml|javascript))/i

const JSON_CONTENT_TYPE = /(?:json|javascript)/i

/** 构造参数。 */
export interface HttpFetchOptions {
  readonly timeoutMs: number
  readonly maxBytes: number
  /** 抽取后正文的字符上限，超出则截断。默认 20000。 */
  readonly maxTextChars?: number
  readonly userAgent: string
  /** 注入点：测试可替换 fetch 实现，默认使用全局 fetch。 */
  readonly fetchImpl?: typeof fetch
}

/** GET 抓取服务。 */
export class HttpFetchService implements FetchService {
  readonly userAgent: string
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly maxTextChars: number
  private readonly fetchImpl: typeof fetch

  constructor(options: HttpFetchOptions) {
    this.userAgent = options.userAgent
    this.timeoutMs = options.timeoutMs
    this.maxBytes = options.maxBytes
    this.maxTextChars = options.maxTextChars ?? 20_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * 抓取原始响应体，不做正文抽取。
   * 需要自己解析页面结构的插件（例如搜索后端）用这个。
   */
  async fetchRaw(rawUrl: string, signal?: AbortSignal): Promise<RawResponse> {
    throwIfAborted(signal)
    const url = parseHttpUrl(rawUrl)

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

/** 从任意异常里取一条可读信息。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message.length > 0) return cause.message
    return error.message
  }
  return String(error)
}
