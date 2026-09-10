/**
 * Markdown 输出插件。
 *
 * 产物是人类可读、可 diff、可粘贴进任何编辑器的纯文本；引用编号与末尾「来源」列表一一对应。
 */

import { definePlugin } from '../../main/engine/registry.ts'
import type { Artifact, OutputPlugin, PluginContext, PluginManifest, Report, ReportSection } from '../../main/engine/types.ts'

/** 转义 markdown 链接文本里的方括号。 */
function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, '\\$&').replace(/\s*\n\s*/g, ' ')
}

/** 人类可读的耗时。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

/** 每个来源的抓取结局。 */
export type SourceStatus =
  | {
      readonly kind: 'fetched'
      readonly chars: number
      readonly truncated: boolean
      /** 实际使用的抽取实现，逐篇标注——读者要能判断这段正文可不可信。 */
      readonly extraction?: string
      readonly fallbackReason?: string
    }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'skipped' }

/** 按 url 算出每个来源的抓取结局。 */
export function sourceStatuses(report: Report): ReadonlyMap<string, SourceStatus> {
  const map = new Map<string, SourceStatus>()
  for (const document of report.documents) {
    const key = document.sourceUrl ?? document.url
    map.set(key, {
      kind: 'fetched',
      chars: document.text.length,
      truncated: document.truncated,
      ...(document.extraction === undefined ? {} : { extraction: document.extraction }),
      ...(document.extractionFallbackReason === undefined
        ? {}
        : { fallbackReason: document.extractionFallbackReason }),
    })
  }
  for (const failure of report.failures) {
    if (!map.has(failure.url)) map.set(failure.url, { kind: 'failed', reason: failure.reason })
  }
  return map
}

/** 把报告渲染成 Markdown。 */
export function renderReportMarkdown(report: Report): string {
  const statuses = sourceStatuses(report)
  const citationIndex = new Map<string, number>()
  report.sources.forEach((source, index) => citationIndex.set(source.url, index + 1))

  const lines: string[] = []
  lines.push(`# ${report.synthesis.title}`, '')
  lines.push(`> **查询**：${report.query}`)
  lines.push(`> **生成时间**：${report.startedAt}（用时 ${formatDuration(report.durationMs)}）`)
  lines.push(`> **整理方式**：${report.provenance.organize}${report.provenance.model === undefined ? '' : ` · 模型 ${report.provenance.model}`}`)
  lines.push(`> **搜索方式**：${report.provenance.search}${report.provenance.searchFallbackUsed ? '（主搜索插件不可用，已降级）' : ''}`)
  if (report.provenance.degraded !== undefined) {
    lines.push(`> **降级说明**：${report.provenance.degraded}`)
  }
  if (report.provenance.usage !== undefined) {
    lines.push(`> **token 用量**：输入 ${report.provenance.usage.promptTokens} · 输出 ${report.provenance.usage.completionTokens}`)
  }
  lines.push('')

  if (report.synthesis.summary.length > 0) {
    lines.push('## 摘要', '', report.synthesis.summary, '')
  }

  for (const section of report.synthesis.sections) {
    lines.push(...renderSection(section, citationIndex))
  }

  if (report.synthesis.sections.length === 0) {
    lines.push('> 本次没有生成任何小节：没有取得可用的正文或摘要。', '')
  }

  lines.push(...renderMaterialsOverview(report))

  lines.push('## 来源', '')
  if (report.sources.length === 0) {
    lines.push('（没有搜索到任何来源）', '')
  } else {
    report.sources.forEach((source, index) => {
      const title = source.title !== undefined && source.title.length > 0 ? source.title : source.url
      lines.push(`${index + 1}. [${escapeLinkText(title)}](${source.url}) — ${describeStatus(statuses.get(source.url))}`)
      if (source.publishedAt !== undefined) lines.push(`   - 发布/抓取时间：${source.publishedAt}`)
    })
    lines.push('')
  }

  if (report.failures.length > 0) {
    lines.push('## 抓取失败', '')
    for (const failure of report.failures) {
      lines.push(`- ${failure.url} — ${failure.reason}`)
    }
    lines.push('')
  }

  if (report.outputFailures !== undefined && report.outputFailures.length > 0) {
    lines.push('## 未生成的格式', '')
    lines.push('以下输出格式在渲染时失败，因此本次没有产出对应文件：', '')
    for (const failure of report.outputFailures) {
      lines.push(`- ${failure.plugin} — ${failure.reason}`)
    }
    lines.push('')
  }

  lines.push('## 运行信息', '')
  lines.push(`- 引擎版本：${report.provenance.engine}`)
  lines.push(`- 主流程：${report.provenance.pipeline}`)
  lines.push(`- 搜索插件：${report.provenance.search}`)
  if (report.provenance.provider !== undefined) lines.push(`- 大模型插件：${report.provenance.provider}`)
  lines.push(`- 整理插件：${report.provenance.organize}`)
  lines.push(`- 输出插件：${report.provenance.outputs.join('、')}`)
  lines.push(`- run id：${report.runId}`)
  lines.push('')
  lines.push(...renderAgentic(report))
  lines.push('> 本报告的正文由上述整理插件生成。引用编号对应「来源」列表；'
    + '大模型整理可能概括失准，关键结论请点开来源原文核对。')
  lines.push('')

  return lines.join('\n')
}

/**
 * 资料地图概要。
 *
 * 只放**骨架**——主题标题、盲区、分歧；完整的论断与逐字引文在 `materials.md` 里。
 * 目的是让读报告的人知道证据的形状，而不是把同一份内容在两处铺开。
 */
function renderMaterialsOverview(report: Report): string[] {
  const materials = report.materials
  if (materials === undefined || materials.themes.length === 0) return []

  const lines: string[] = ['## 资料地图概要', '']
  lines.push(`本次归纳出 ${materials.themes.length} 个主题：`, '')
  for (const theme of materials.themes) {
    const summary = theme.summary.length > 0 ? ` — ${theme.summary}` : ''
    lines.push(`- **${theme.topic}**（${theme.sourceIds.length} 条来源）${summary}`)
  }
  lines.push('')

  if (materials.gaps.length > 0) {
    lines.push(`**尚未覆盖**：${materials.gaps.join('；')}`, '')
  }
  if (materials.conflicts.length > 0) {
    lines.push('**存在分歧**：', '')
    for (const conflict of materials.conflicts) {
      lines.push(`- ${conflict.topic}：${conflict.positions.join(' / ')}`)
    }
    lines.push('')
  }
  lines.push('> 完整的论断、逐字引文与语料清单见同目录的 `materials.md`。', '')
  return lines
}

/**
 * 代理式运行观测。
 *
 * 这一段的意义是让读者**判断这份产出值多少信任**：搜了几轮、地图多大、
 * 覆盖了多少、模型调了多少次、每个任务是因为什么停下来的。
 * 数据本来就在 provenance 里，但不铺开就等于没有。
 */
function renderAgentic(report: Report): string[] {
  const agentic = report.provenance.agentic
  if (agentic === undefined) return []

  const outcomeText = agentic.outcome === 'converged'
    ? '已收敛'
    : agentic.outcome === 'stalled'
      ? '卡住后收工'
      : '撞上护栏后收工'

  const lines: string[] = ['### 本次调研过程', '']
  lines.push(`- 收敛情况：${outcomeText}（${agentic.outcomeMessage}）`)
  lines.push(`- 不动点迭代：${agentic.iterations} 轮`)
  lines.push(`- 搜索：${agentic.searchRounds} 轮；地图 ${agentic.mapNodes} 个主题 / ${agentic.gaps} 个盲区 / ${agentic.conflicts} 处分歧`)
  lines.push(`- 写作：${agentic.toolCalls} 次工具调用`)
  lines.push(`- 大模型：${agentic.llmCalls} 次调用（输入 ${agentic.promptTokens} / 输出 ${agentic.completionTokens} token）`)
  lines.push(`- 正文抽取：Readability ${agentic.extraction.readability} 篇 / 回退纯文本 ${agentic.extraction.plainText} 篇`)
  if (agentic.reused !== undefined) {
    lines.push(
      `- 复用了话题缓存：${agentic.reused.sources} 条来源 / ${agentic.reused.mapNodes} 个主题`
      + `（更新于 ${agentic.reused.updatedAt}）`,
    )
  }
  lines.push('')
  lines.push('| 任务 | 步数 | 满足 | 为什么停 |')
  lines.push('|---|---|---|---|')
  for (const task of agentic.tasks) {
    lines.push(`| ${task.name} | ${task.steps} | ${task.satisfied ? '是' : '否'} | ${task.reason} |`)
  }
  lines.push('')
  return lines
}

/** 渲染一节，并把引用映射成全局编号。 */
function renderSection(section: ReportSection, citationIndex: ReadonlyMap<string, number>): string[] {
  const lines: string[] = [`## ${section.heading}`, '', section.body, '']
  const links: string[] = []
  for (const url of section.citations) {
    const number = citationIndex.get(url)
    links.push(number === undefined ? `[${escapeLinkText(url)}](${url})` : `[#${number}](${url})`)
  }
  if (links.length > 0) lines.push(`**引用**：${links.join(' · ')}`, '')
  return lines
}

/** 描述一个来源的抓取结局。 */
function describeStatus(status: SourceStatus | undefined): string {
  if (status === undefined || status.kind === 'skipped') return '未抓取（超出本次抓取上限）'
  if (status.kind === 'failed') return `抓取失败：${status.reason}`
  const via = status.extraction === 'readability'
    ? ' · Readability'
    : status.extraction === 'plain-text'
      ? ` · 纯文本回退${status.fallbackReason === undefined ? '' : `（${status.fallbackReason}）`}`
      : ''
  return `已抓取正文 ${status.chars} 字${status.truncated ? '（已截断）' : ''}${via}`
}

/** Markdown 输出插件。 */
export class MarkdownOutput implements OutputPlugin {
  readonly id = 'output-markdown'
  readonly kind = 'output' as const
  readonly format = 'markdown'

  async render(report: Report, ctx: PluginContext, _signal?: AbortSignal): Promise<readonly Artifact[]> {
    return [await ctx.store.writeText('report.md', renderReportMarkdown(report), this.format)]
  }
}

/** 插件清单。 */
export const markdownOutputPlugin: PluginManifest = definePlugin({
  id: 'output-markdown',
  kind: 'output',
  version: '0.1.0',
  title: 'Markdown 报告',
  description: '输出 report.md：带引用编号、来源清单与运行信息的纯文本报告。',
  entry: new MarkdownOutput(),
})
