/**
 * 抓取层重试测试。
 *
 * 这些用例来自一次真实故障：本机出口代理偶发丢掉 TLS 握手，
 * 而当时的代码一次失败就终止整轮研究。重试必须只针对「重发可能就好了」的故障。
 */

import { describe, expect, it } from 'vitest'
import { HttpFetchService, type FetchRetryInfo } from '../src/main/engine/fetch.ts'
import type { FetchedDocument, RawResponse } from '../src/main/engine/types.ts'

const URL_UNDER_TEST = 'https://example.com/page'

/** 记录调用次数、按脚本来决定每次结果的假 fetch。 */
function scriptedFetch(script: readonly (Response | Error)[]): {
  impl: typeof fetch
  calls: () => number
} {
  let index = 0
  const impl = (async () => {
    const step = script[Math.min(index, script.length - 1)]
    index += 1
    if (step instanceof Error) throw step
    return step
  }) as unknown as typeof fetch
  return { impl, calls: () => index }
}

/** 一个正常的 HTML 响应。 */
function okResponse(body = '<p>hello</p>', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/** 构造被测服务。 */
function service(impl: typeof fetch, maxRetries: number, onRetry?: (info: FetchRetryInfo) => void): HttpFetchService {
  return new HttpFetchService({
    timeoutMs: 5000,
    maxBytes: 100_000,
    userAgent: 'test-agent',
    maxRetries,
    retryBaseDelayMs: 1,
    fetchImpl: impl,
    ...(onRetry === undefined ? {} : { onRetry }),
  })
}

/** 模拟一次连接层失败（TLS 握手被丢）。 */
function tlsDrop(): Error {
  return Object.assign(
    new TypeError('fetch failed'),
    { cause: new Error('Client network socket disconnected before secure TLS connection was established') },
  )
}

describe('抓取重试', () => {
  it('瞬时连接失败后重试并成功', async () => {
    const { impl, calls } = scriptedFetch([tlsDrop(), tlsDrop(), okResponse('<p>成功了</p>')])
    const retries: FetchRetryInfo[] = []
    const raw = await service(impl, 2, (info) => retries.push(info)).fetchRaw(URL_UNDER_TEST)

    expect(calls()).toBe(3)
    expect(raw.body).toContain('成功了')
    expect(retries).toHaveLength(2)
    expect(retries[0]?.attempt).toBe(1)
    expect(retries[0]?.maxAttempts).toBe(3)
    expect(retries[0]?.reason).toContain('TLS')
  })

  it('重试次数用尽后仍然失败，并抛出最后一次的错误', async () => {
    const { impl, calls } = scriptedFetch([tlsDrop(), tlsDrop(), tlsDrop(), okResponse()])
    await expect(service(impl, 2).fetchRaw(URL_UNDER_TEST)).rejects.toThrowError(/网络请求失败/)
    expect(calls()).toBe(3) // 首次 + 2 次重试
  })

  it('maxRetries 为 0 时一次即止', async () => {
    const { impl, calls } = scriptedFetch([tlsDrop(), okResponse()])
    await expect(service(impl, 0).fetchRaw(URL_UNDER_TEST)).rejects.toThrowError(/网络请求失败/)
    expect(calls()).toBe(1)
  })

  it('5xx 与 429 会重试，4xx 不会', async () => {
    const server = scriptedFetch([okResponse('boom', 503), okResponse('好了')])
    expect((await service(server.impl, 2).fetchRaw(URL_UNDER_TEST)).body).toContain('好了')
    expect(server.calls()).toBe(2)

    const limited = scriptedFetch([okResponse('slow down', 429), okResponse('好了')])
    expect((await service(limited.impl, 2).fetchRaw(URL_UNDER_TEST)).body).toContain('好了')
    expect(limited.calls()).toBe(2)

    // 404 是请求本身的问题，重试没有意义
    const notFound = scriptedFetch([okResponse('nope', 404), okResponse('好了')])
    await expect(service(notFound.impl, 2).fetchRaw(URL_UNDER_TEST)).rejects.toThrowError(/HTTP 404/)
    expect(notFound.calls()).toBe(1)
  })

  it('不支持的内容类型不重试', async () => {
    const pdf = (async () => new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch
    let calls = 0
    const counted = (async () => {
      calls += 1
      return pdf(new Request(URL_UNDER_TEST))
    }) as unknown as typeof fetch
    await expect(service(counted, 2).fetchRaw(URL_UNDER_TEST)).rejects.toThrowError(/不支持的内容类型/)
    expect(calls).toBe(1)
  })

  it('用户取消时不重试', async () => {
    const controller = new AbortController()
    const { impl, calls } = scriptedFetch([
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      okResponse(),
    ])
    controller.abort(new Error('用户点了取消'))
    await expect(service(impl, 2).fetchRaw(URL_UNDER_TEST, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    })
    expect(calls()).toBe(0) // 一开始就中止，连请求都不发
  })

  it('fetchText 也走重试，并抽取正文', async () => {
    const { impl, calls } = scriptedFetch([
      tlsDrop(),
      okResponse('<html><head><title>标题</title></head><body><p>正文内容</p></body></html>'),
    ])
    const document: FetchedDocument = await service(impl, 2).fetchText(URL_UNDER_TEST)
    expect(calls()).toBe(2)
    expect(document.title).toBe('标题')
    expect(document.text).toBe('正文内容')
  })

  it('无效 URL 在进入重试循环前就失败，不会被重试', async () => {
    const { impl, calls } = scriptedFetch([okResponse()])
    await expect(service(impl, 3).fetchRaw('not-a-url')).rejects.toThrowError(/无效的 URL/)
    expect(calls()).toBe(0)
  })
})

describe('配置变更后抓取参数立即生效', () => {
  it('按新配置重建服务会采用新的重试次数', async () => {
    // 全程失败，用请求次数反映重试策略
    const noRetry = scriptedFetch([tlsDrop()])
    await expect(service(noRetry.impl, 0).fetchRaw(URL_UNDER_TEST)).rejects.toThrowError()
    expect(noRetry.calls()).toBe(1)

    const withRetry = scriptedFetch([tlsDrop()])
    await expect(service(withRetry.impl, 2).fetchRaw(URL_UNDER_TEST)).rejects.toThrowError()
    expect(withRetry.calls()).toBe(3)
  })
})

/** 让 RawResponse 类型在测试里被引用到。 */
export type { RawResponse }
