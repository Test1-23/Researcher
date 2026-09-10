/**
 * 带稳定错误码的类型化错误。
 *
 * 界面根据 `code` 决定提示与建议操作，因此 code 是契约的一部分，不要随意改动字符串。
 */

/** 全部错误码。界面可以安全地 switch，但必须容忍未知码。 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'PLUGIN_INVALID'
  | 'PLUGIN_DUPLICATE'
  | 'PLUGIN_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'SEARCH_UNAVAILABLE'
  | 'SEARCH_FAILED'
  | 'LLM_UNAVAILABLE'
  | 'LLM_FAILED'
  | 'LLM_BAD_JSON'
  | 'FETCH_FAILED'
  | 'RATE_LIMITED'
  | 'OUTPUT_FAILED'
  | 'CANCELLED'
  | 'INTERNAL'

/** 引擎的统一错误类型。 */
export class ResearcherError extends Error {
  readonly code: ErrorCode

  constructor(message: string, code: ErrorCode = 'INTERNAL', options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined)
    this.name = 'ResearcherError'
    this.code = code
  }
}

/** HTTP 状态相关错误会带上状态码，便于管线记录到 fetchFailures。 */
export class FetchError extends ResearcherError {
  readonly status: number | undefined
  readonly url: string

  constructor(message: string, url: string, status?: number, options?: { cause?: unknown }) {
    const code: ErrorCode = status === 429 ? 'RATE_LIMITED' : 'FETCH_FAILED'
    super(message, code, options)
    this.name = 'FetchError'
    this.url = url
    this.status = status
  }
}

/** 上游返回 429 时使用，供重试逻辑识别。 */
export class RateLimitError extends ResearcherError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'RATE_LIMITED', options)
    this.name = 'RateLimitError'
  }
}

/** true 表示这是取消导致的错误（而非真实失败）。 */
export function isCancellation(error: unknown): boolean {
  return error instanceof ResearcherError && error.code === 'CANCELLED'
}

/** 若信号已中止则抛出取消错误。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw cancelled(signal)
}

/** 构造取消错误，保留调用方的原始中止原因。 */
export function cancelled(signal?: AbortSignal, fallback?: unknown): ResearcherError {
  return new ResearcherError('运行已取消', 'CANCELLED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** 判断是否是 fetch/AbortSignal 的中止异常。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** 把任意异常规整成 ResearcherError，未知异常归为 INTERNAL。 */
export function toResearcherError(error: unknown, fallbackMessage = '未知错误'): ResearcherError {
  if (error instanceof ResearcherError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ResearcherError(message.length > 0 ? message : fallbackMessage, 'INTERNAL', { cause: error })
}
