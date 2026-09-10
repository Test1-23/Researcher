/**
 * 可控的抓取服务替身。
 *
 * 用它替换内核的 HttpFetchService，就能在完全不联网的前提下测试
 * 「搜索 → 抓取 → 抽取正文」这条真实链路。
 */

import { FetchError } from '../../src/main/engine/errors.ts'
import { extractText } from '../../src/main/engine/html.ts'
import type { FetchedDocument, FetchService, RawResponse } from '../../src/main/engine/types.ts'
import { DUCKDUCKGO_FIXTURE, DUCKDUCKGO_PAGES } from '../../fixtures/duckduckgo.ts'

/** 一次假响应。 */
export interface FakeResponse {
  readonly status?: number
  readonly contentType?: string
  readonly body: string
}

/** 按 URL 决定返回什么；返回 Error 表示网络层失败。 */
export type FakeFetchHandler = (url: string) => FakeResponse | Error

/** 记录所有请求的假抓取服务。 */
export class FakeFetch implements FetchService {
  readonly userAgent = 'researcher-test/0.0.0'
  readonly requests: string[] = []
  private readonly handler: FakeFetchHandler

  constructor(handler: FakeFetchHandler) {
    this.handler = handler
  }

  async fetchRaw(url: string, signal?: AbortSignal): Promise<RawResponse> {
    if (signal?.aborted === true) throw new FetchError('已取消', url)
    this.requests.push(url)
    const result = this.handler(url)
    if (result instanceof Error) throw result
    const status = result.status ?? 200
    if (status >= 400) throw new FetchError(`HTTP ${status}`, url, status)
    return {
      url,
      status,
      contentType: result.contentType ?? 'text/html; charset=utf-8',
      body: result.body,
      truncated: false,
    }
  }

  async fetchText(url: string, signal?: AbortSignal): Promise<FetchedDocument> {
    const raw = await this.fetchRaw(url, signal)
    const extracted = extractText(raw.body)
    return {
      url: raw.url,
      status: raw.status,
      ...(extracted.title === undefined ? {} : { title: extracted.title }),
      text: extracted.text,
      truncated: raw.truncated,
    }
  }
}

/** 固定映射的便捷构造：URL → 正文，其余 URL 一律 404。 */
export function staticFetch(pages: Readonly<Record<string, string>>): FakeFetch {
  return new FakeFetch((url) => {
    const body = pages[url]
    return body === undefined ? { status: 404, body: 'not found' } : { body }
  })
}

// 夹具放在 tests/ 之外（fixtures/），因为示例脚本也要用同一份录制数据。
export { DUCKDUCKGO_FIXTURE, DUCKDUCKGO_PAGES } from '../../fixtures/duckduckgo.ts'

/** 只走夹具、不联网的抓取实现：DDG 结果页与文章页都来自录制数据。 */
export function fixtureFetch(): FakeFetch {
  return new FakeFetch((url) => {
    if (url.startsWith('https://html.duckduckgo.com/')) return { body: DUCKDUCKGO_FIXTURE }
    const page = DUCKDUCKGO_PAGES[url]
    return page === undefined ? { status: 404, body: 'not found' } : { body: page }
  })
}

