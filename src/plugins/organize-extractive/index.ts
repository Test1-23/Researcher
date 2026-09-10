/**
 * 抽取式整理（零依赖，无需 API key）。
 *
 * 它不做任何「生成」：只是把各来源的开头关键句原样摘录出来，按来源分节。
 * 存在的意义有两个：
 *   1. 没有任何 key 时，整条 pipeline 依然能端到端跑通并产出报告；
 *   2. 当 LLM 整理失败（例如模型两次都给出非法 JSON）时作为降级目标，避免整次运行白跑。
 *
 * 因为不经过改写，它的产出不会引入模型幻觉，但也不构成对来源的概括。
 */

import { sectionPositiveInt } from '../../main/engine/config.ts'
import { definePlugin } from '../../main/engine/registry.ts'
import type {
  AvailabilityContext,
  FetchedDocument,
  OrganizeInput,
  OrganizeOutput,
  Organizer,
  PluginContext,
  PluginManifest,
  ReportSection,
} from '../../main/engine/types.ts'

/** 句末标点（中英文）。 */
const SENTENCE_END = /(?<=[。！？!?；;])\s*|\n+/

/** 太短的「句子」多半是导航文字或标题残片，丢弃。 */
const MIN_SENTENCE_LENGTH = 12

/** 按句切分，并丢掉短于 minLength 的碎片。 */
export function splitSentences(text: string, minLength: number = MIN_SENTENCE_LENGTH): string[] {
  return text
    .split(SENTENCE_END)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= minLength)
}

/**
 * 取前 limit 句，总长度不超过 maxChars。
 *
 * 先按「像句子」的片段取；中文短句密集的页面可能一个都不满足长度门槛，
 * 这时退回到所有非空片段——只要还有正文，就绝不返回空摘录。
 */
export function extractKeySentences(text: string, limit: number, maxChars: number): string {
  const preferred = splitSentences(text)
  const candidates = preferred.length > 0 ? preferred : splitSentences(text, 1)

  const picked: string[] = []
  let total = 0
  for (const sentence of candidates) {
    if (picked.length >= limit) break
    // 至少要有一句，否则超长单句会导致空正文
    if (picked.length > 0 && total + sentence.length > maxChars) break
    picked.push(sentence)
    total += sentence.length
  }

  const joined = picked.join(' ')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
}

/** 从 URL 取一个可读的站点名，用作没有标题时的兜底。 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url
  }
}

/** 抽取式整理插件。 */
export class ExtractiveOrganizer implements Organizer {
  readonly id = 'organize-extractive'
  readonly kind = 'organize' as const

  /** 纯本地处理，永远可用——这正是它能当降级目标的原因。 */
  available(_ctx: AvailabilityContext): boolean {
    return true
  }

  async organize(input: OrganizeInput, ctx: PluginContext, _signal?: AbortSignal): Promise<OrganizeOutput> {
    const section = ctx.config.section(this.id)
    const sentencesPerSource = sectionPositiveInt(section, 'sentencesPerSource', 4)
    const maxExcerptChars = sectionPositiveInt(section, 'maxExcerptChars', 700)

    // 正文按「来源 URL」索引：重定向后 doc.url 可能与来源不同，用 sourceUrl 对应回去。
    const documentBySource = new Map<string, FetchedDocument>()
    for (const document of input.documents) {
      const key = document.sourceUrl ?? document.url
      if (!documentBySource.has(key)) documentBySource.set(key, document)
    }

    const sections: ReportSection[] = []
    for (const source of input.sources) {
      const document = documentBySource.get(source.url)
      const heading = firstNonEmpty(document?.title, source.title, hostnameOf(source.url))
      let body = ''
      if (document !== undefined && document.text.length > 0) {
        body = extractKeySentences(document.text, sentencesPerSource, maxExcerptChars)
      }
      if (body.length === 0 && source.snippet !== undefined) {
        body = source.snippet.slice(0, maxExcerptChars)
      }
      // 既没有正文也没有摘要就不硬凑一节，宁缺毋滥
      if (body.length === 0) continue
      sections.push({ heading, body, citations: [source.url] })
    }

    const summary = this.buildSummary(input, sections.length)
    const title = `关于「${input.query}」的资料汇编`

    return {
      title,
      summary,
      sections,
      meta: { pluginId: this.id },
    }
  }

  /** 诚实交代这一次到底拿到了什么、以及节内容是怎么来的。 */
  private buildSummary(input: OrganizeInput, sectionCount: number): string {
    const parts = [`围绕「${input.query}」共收集到 ${input.sources.length} 个来源`]
    parts.push(`成功抓取正文 ${input.documents.length} 篇`)
    if (input.failures.length > 0) parts.push(`抓取失败 ${input.failures.length} 篇`)
    if (sectionCount < input.sources.length) {
      parts.push(`${input.sources.length - sectionCount} 个来源既无正文也无摘要`)
    }
    return `${parts.join('，')}。`
      + '以下各节由「抽取式整理」生成：直接摘录各来源的开头若干句，未经大模型改写或概括，'
      + '因此不代表对来源内容的判断，请以原文为准。'
  }
}

/** 取第一个非空字符串。 */
function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim()
  }
  return '（无标题）'
}

/** 插件清单。 */
export const extractiveOrganizerPlugin: PluginManifest = definePlugin({
  id: 'organize-extractive',
  kind: 'organize',
  version: '0.1.0',
  title: '抽取式整理（免 key）',
  description: '按来源摘录开头关键句，不调用大模型：零配置可跑通，也用作 LLM 整理失败时的降级目标。',
  entry: new ExtractiveOrganizer(),
})
