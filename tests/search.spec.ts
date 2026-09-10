/**
 * 搜索插件测试：DuckDuckGo 结果页解析、DeepSeek 原生搜索响应映射。
 * 全部用固定夹具，不发网络请求。
 */

import { describe, expect, it } from 'vitest'
import { citationSnippets, mapDeepSeekSearchResponse } from '../src/plugins/search-deepseek/index.ts'
import { normalizeDuckDuckGoUrl, parseDuckDuckGoHtml } from '../src/plugins/search-duckduckgo/index.ts'
import { DUCKDUCKGO_FIXTURE } from './helpers/fake-fetch.ts'

describe('DuckDuckGo URL 归一化', () => {
  it('从 uddg 跳转参数里取出真实地址', () => {
    expect(normalizeDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=1'))
      .toBe('https://example.com/a')
    expect(normalizeDuckDuckGoUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fb'))
      .toBe('https://example.com/b')
  })

  it('直接给出的绝对地址照常接受', () => {
    expect(normalizeDuckDuckGoUrl('https://example.com/c')).toBe('https://example.com/c')
    expect(normalizeDuckDuckGoUrl('//example.com/d')).toBe('https://example.com/d')
  })

  it('丢弃站内链接、广告与非 http 协议', () => {
    expect(normalizeDuckDuckGoUrl('https://duckduckgo.com/y.js?ad=1')).toBeUndefined()
    expect(normalizeDuckDuckGoUrl('javascript:void(0)')).toBeUndefined()
    expect(normalizeDuckDuckGoUrl('')).toBeUndefined()
    expect(normalizeDuckDuckGoUrl('//duckduckgo.com/l/?uddg=not-a-url')).toBeUndefined()
  })

  it('解码 HTML 实体后再解析（&amp; 不能破坏查询串）', () => {
    expect(normalizeDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp%3Fa%3D1%26b%3D2&amp;rut=x'))
      .toBe('https://example.com/p?a=1&b=2')
  })
})

describe('DuckDuckGo 结果页解析', () => {
  it('解析出标题与摘要，并跳过广告位', () => {
    const sources = parseDuckDuckGoHtml(DUCKDUCKGO_FIXTURE)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({
      url: 'https://example.com/alpha',
      title: 'Alpha 官方文档',
      snippet: 'Alpha 是一个用于演示的示例项目，提供基础能力。',
    })
    expect(sources[1]?.title).toBe('Beta 入门指南')
    expect(sources.map((source) => source.url)).not.toContain('https://duckduckgo.com/y.js?ad=1')
  })

  it('空页面或无关页面返回空数组，而不是抛错', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([])
    expect(parseDuckDuckGoHtml('<html><body><p>没有结果</p></body></html>')).toEqual([])
  })

  it('同一 URL 出现多次时不重复，且各自补齐信息', () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">标题</a>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">摘要</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">重复标题</a>`
    const sources = parseDuckDuckGoHtml(html)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toEqual({ url: 'https://example.com/x', title: '标题', snippet: '摘要' })
  })

  it('容忍 class 属性里附带其它类名与单引号属性', () => {
    const html = `<a class='result__a js-link' href='https://example.com/q'>Q</a>`
    expect(parseDuckDuckGoHtml(html)[0]?.url).toBe('https://example.com/q')
  })
})

describe('DeepSeek 原生搜索响应映射', () => {
  const response = {
    content: [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.com/1', title: 'A1', page_age: '2026-01-02' },
          { type: 'web_search_result', url: 'https://b.com/2', title: 'B2' },
          { type: 'web_search_result', url: 'https://a.com/1', title: '重复' },
          { type: 'web_search_result', title: '没有 url' },
        ],
      },
      {
        type: 'text',
        text: '这是正文。',
        citations: [
          { url: 'https://a.com/1', cited_text: 'A1 的引用片段' },
          { url: 'https://b.com/2', cited_text: 'B2 的引用片段' },
          { url: 'https://a.com/1', cited_text: '后出现的同 URL 引用应被忽略' },
        ],
      },
    ],
  }

  it('按 url 去重，并把 citation 里的片段接到对应来源上', () => {
    const sources = mapDeepSeekSearchResponse(response)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({
      url: 'https://a.com/1',
      title: 'A1',
      snippet: 'A1 的引用片段',
      publishedAt: '2026-01-02',
    })
    expect(sources[1]?.snippet).toBe('B2 的引用片段')
  })

  it('没有搜索结果块时抛出可操作错误', () => {
    expect(() => mapDeepSeekSearchResponse({ content: [{ type: 'text', text: '我没搜' }] }))
      .toThrowError(/web_search_tool_result/)
  })

  it('citationSnippets 首次出现优先', () => {
    const map = citationSnippets([
      { type: 'text', citations: [{ url: 'https://x.com', cited_text: '第一次' }] },
      { type: 'text', citations: [{ url: 'https://x.com', cited_text: '第二次' }] },
      { type: 'text', citations: [{ url: '', cited_text: '无效' }] },
    ])
    expect(map.get('https://x.com')).toBe('第一次')
    expect(map.size).toBe(1)
  })
})
