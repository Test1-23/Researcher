/**
 * DuckDuckGo 搜索后端（免 key 兜底）。
 *
 * 它抓取 DDG 的 html 端点并解析结果页。不是官方 API，因此抗风控能力一般——
 * 它的定位是「没有任何 API key 时也能把整条链路跑通」，而不是主力搜索。
 * 解析逻辑单独导出，测试用固定夹具覆盖，不需要联网。
 */

import { sectionString } from '../../main/engine/config.ts'
import { decodeEntities, htmlToText } from '../../main/engine/html.ts'
import { isCancellation, ResearcherError, toResearcherError } from '../../main/engine/errors.ts'
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

/** DDG 的 html 端点。 */
export const DUCKDUCKGO_DEFAULT_BASE_URL = 'https://html.duckduckgo.com/html/'

/**
 * 把 DDG 的结果链接还原成真实 URL。
 *
 * DDG 会把结果包成 `//duckduckgo.com/l/?uddg=<编码后的真实地址>`；
 * 站内链接与广告（y.js 之类）不是可引用来源，直接丢弃。
 */
export function normalizeDuckDuckGoUrl(raw: string): string | undefined {
  const decoded = decodeEntities(raw).trim()
  if (decoded.length === 0) return undefined

  const candidate = decoded.startsWith('//') ? `https:${decoded}` : decoded
  let url: URL
  try {
    url = new URL(candidate, 'https://duckduckgo.com')
  } catch {
    return undefined
  }

  const uddg = url.searchParams.get('uddg')
  if (uddg !== null && uddg.length > 0) {
    try {
      const target = new URL(uddg)
      return target.protocol === 'http:' || target.protocol === 'https:' ? target.toString() : undefined
    } catch {
      return undefined
    }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  // duckduckgo.com 自己的页面（广告跳转、站内导航）不是来源
  if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return undefined
  return url.toString()
}

/**
 * 解析 DDG 结果页。
 *
 * 只依赖两个语义类名 `result__a`（标题链接）与 `result__snippet`（摘要），
 * 按出现顺序配对；页面结构微调不会立刻让解析全废。
 */
export function parseDuckDuckGoHtml(html: string): SearchSource[] {
  const order: string[] = []
  const byUrl = new Map<string, { title?: string; snippet?: string }>()

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const attributes = match[1]
    const inner = match[2]

    const classMatch = /\bclass\s*=\s*"([^"]*)"/i.exec(attributes) ?? /\bclass\s*=\s*'([^']*)'/i.exec(attributes)
    const className = classMatch?.[1] ?? ''
    const isTitleLink = /(^|\s)result__a(\s|$)/.test(className)
    const isSnippet = /(^|\s)result__snippet(\s|$)/.test(className)
    if (!isTitleLink && !isSnippet) continue

    const hrefMatch = /\bhref\s*=\s*"([^"]*)"/i.exec(attributes) ?? /\bhref\s*=\s*'([^']*)'/i.exec(attributes)
    if (hrefMatch === null) continue

    const url = normalizeDuckDuckGoUrl(hrefMatch[1])
    if (url === undefined) continue

    let entry = byUrl.get(url)
    if (entry === undefined) {
      entry = {}
      byUrl.set(url, entry)
      order.push(url)
    }

    const text = htmlToText(inner)
    if (text.length === 0) continue
    if (isTitleLink && entry.title === undefined) entry.title = text
    if (isSnippet && entry.snippet === undefined) entry.snippet = text
  }

  return order.map((url) => {
    const entry = byUrl.get(url) ?? {}
    return {
      url,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.snippet === undefined ? {} : { snippet: entry.snippet }),
    }
  })
}

/** 免 key 的 DuckDuckGo 搜索插件。 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly id = 'search-duckduckgo'
  readonly kind = 'search' as const

  /** 不需要任何凭据，永远可用。 */
  available(_ctx: AvailabilityContext): boolean {
    return true
  }

  async search(request: SearchRequest, ctx: PluginContext, signal?: AbortSignal): Promise<SearchResult> {
    const section = ctx.config.section(this.id)
    const baseUrl = sectionString(section, 'baseUrl', DUCKDUCKGO_DEFAULT_BASE_URL)

    let endpoint: string
    try {
      const url = new URL(baseUrl)
      url.searchParams.set('q', request.query)
      // kl=wt-wt 表示不限地区，避免按 IP 猜测语言而返回不一致的结果
      if (!url.searchParams.has('kl')) url.searchParams.set('kl', 'wt-wt')
      endpoint = url.toString()
    } catch (error) {
      throw toResearcherError(error, `DuckDuckGo 的 baseUrl 不合法：${baseUrl}`)
    }

    let html: string
    try {
      const response = await ctx.fetch.fetchRaw(endpoint, signal)
      html = response.body
    } catch (error) {
      if (isCancellation(error)) throw error
      // 用 SEARCH_FAILED 而不是把抓取层的 FETCH_FAILED 直接透出去：
      // 界面需要知道「是搜索这一步失败了」，才能给出换后端的建议。
      throw new ResearcherError(
        `DuckDuckGo 搜索失败：${toResearcherError(error).message}。`
        + '这个后端通过抓取 DuckDuckGo 结果页工作，某些网络环境（例如机房 IP）会被它直接拒绝连接。'
        + '若你有 DeepSeek API key，请在设置中把主搜索插件改回 search-deepseek。',
        'SEARCH_FAILED',
        { cause: error },
      )
    }

    const parsed = parseDuckDuckGoHtml(html)
    if (parsed.length === 0) {
      ctx.log.warn('DuckDuckGo 未解析出任何结果；可能被风控拦截，或查询确实没有结果')
    }

    const limit = request.maxResults
    const sources = limit === undefined ? parsed : parsed.slice(0, limit)
    return {
      providerId: this.id,
      sources,
      truncated: sources.length < parsed.length,
    }
  }
}

/** 插件清单。 */
export const duckDuckGoPlugin: PluginManifest = definePlugin({
  id: 'search-duckduckgo',
  kind: 'search',
  version: '0.1.0',
  title: 'DuckDuckGo（免 key）',
  description: '抓取 DuckDuckGo 结果页，无需 API key，作为零配置兜底搜索后端。',
  entry: new DuckDuckGoSearchProvider(),
})
