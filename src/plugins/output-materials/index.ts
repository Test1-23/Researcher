/**
 * 资料文件输出插件。
 *
 * 产出两份东西：
 *   · `materials.md`   —— 人能读的证据汇编：有哪些主题、每个主题说了什么、
 *                          逐字引文、还缺什么、哪里有分歧、以及语料清单
 *   · `materials.json` —— 同一份内容的机器可读版本
 *
 * 它与 `output-markdown` 的区别是刻意的：报告是**成品**（按模板组织的正文），
 * 资料文件是**证据本体**（地图 + 语料）。要核对某个结论时看资料文件，
 * 要看结论本身时看报告。把两者混在一起会让报告失去形状。
 */

import { definePlugin } from '../../main/engine/registry.ts'
import type {
  Artifact,
  MaterialSource,
  OutputPlugin,
  PluginContext,
  PluginManifest,
  Report,
  ReportMaterials,
} from '../../main/engine/types.ts'

/** 抓取状态的说明文字。 */
function describeStatus(source: MaterialSource): string {
  if (source.status === 'full') {
    const via = source.extraction === 'readability'
      ? 'Readability'
      : source.extraction === 'plain-text'
        ? '纯文本回退'
        : '未知实现'
    const why = source.extractionFallbackReason === undefined ? '' : `（${source.extractionFallbackReason}）`
    return `已抓取正文 · ${via}${why}`
  }
  return source.filterReason === undefined ? '未抓到正文' : `未抓到正文：${source.filterReason}`
}

/** 语料在文档里的编号，与论断引用的 sourceIds 对应。 */
function labelOf(sourceId: string): string {
  return `[${sourceId}]`
}

/** 渲染成人能读的 Markdown。 */
export function renderMaterialsMarkdown(report: Report, materials: ReportMaterials): string {
  const cited = new Set(materials.themes.flatMap((theme) => theme.sourceIds))
  const lines: string[] = []

  lines.push(`# 资料文件：${report.query}`, '')
  lines.push(`> 生成时间：${report.provenance.generatedAt}`)
  lines.push(
    `> 主流程：${report.provenance.pipeline}`
    + (report.provenance.template === undefined ? '' : ` · 模板 ${report.provenance.template}`),
  )
  lines.push('')

  // ── 概览 ──
  const full = materials.sources.filter((source) => source.status === 'full').length
  lines.push('## 概览', '')
  lines.push(`- 语料 **${materials.sources.length}** 条，其中抓到正文 **${full}** 条`)
  lines.push(`- 主题 **${materials.themes.length}** 个`)
  if (materials.gaps.length > 0) {
    lines.push(`- 尚未覆盖的方面 **${materials.gaps.length}** 个：${materials.gaps.join('；')}`)
  }
  if (materials.conflicts.length > 0) {
    lines.push(`- 存在分歧的问题 **${materials.conflicts.length}** 处（见下）`)
  }
  lines.push('')

  // ── 主题 ──
  lines.push('## 主题', '')
  if (materials.themes.length === 0) {
    lines.push('本次没有归纳出主题（默认主流程不建地图，只有语料清单）。', '')
  }
  for (const theme of materials.themes) {
    lines.push(`### ${theme.topic}`, '')
    if (theme.summary.length > 0) lines.push(theme.summary, '')

    for (const claim of theme.claims) {
      lines.push(`- ${claim.text}`)
      if (claim.quote !== undefined) lines.push(`  > ${claim.quote}`)
      if (claim.sourceIds.length > 0) {
        lines.push(`  来源：${claim.sourceIds.map(labelOf).join(' ')}`)
      }
    }
    if (theme.claims.length === 0 && theme.sourceIds.length > 0) {
      lines.push(`来源：${theme.sourceIds.map(labelOf).join(' ')}`)
    }
    lines.push('')
  }

  // ── 分歧 ──
  if (materials.conflicts.length > 0) {
    lines.push('## 存在分歧的问题', '')
    for (const conflict of materials.conflicts) {
      lines.push(`### ${conflict.topic}`, '')
      for (const position of conflict.positions) lines.push(`- ${position}`)
      lines.push('')
    }
  }

  // ── 盲区 ──
  if (materials.gaps.length > 0) {
    lines.push('## 尚未覆盖的方面', '')
    for (const gap of materials.gaps) lines.push(`- ${gap}`)
    lines.push('')
  }

  // ── 语料清单 ──
  lines.push('## 语料清单', '')
  for (const source of materials.sources) {
    const title = source.title.length > 0 ? source.title : source.url
    const flags: string[] = []
    if (source.relevance !== 'kept') flags.push(`**已过滤：${source.filterReason ?? source.relevance}**`)
    if (cited.has(source.id)) flags.push('被主题引用')
    lines.push(
      `- ${labelOf(source.id)} [${title}](${source.url}) — ${describeStatus(source)}`
      + (flags.length === 0 ? '' : ` · ${flags.join(' · ')}`),
    )
  }
  lines.push('')

  lines.push('---', '')
  lines.push('> 本文件是这次调研的**证据本体**：主题与论断来自模型对语料的归纳，引文为逐字摘录。')
  lines.push('> 被过滤的条目也保留在清单里并标注原因——筛必有漏，藏起来比漏掉更糟。')
  lines.push('')

  return lines.join('\n')
}

/** 机器可读的版本：额外带上「每条语料被哪些主题引用」。 */
export function buildMaterialsJson(report: Report, materials: ReportMaterials): unknown {
  const cited = new Map<string, string[]>()
  for (const theme of materials.themes) {
    for (const sourceId of theme.sourceIds) {
      const list = cited.get(sourceId) ?? []
      list.push(theme.topic)
      cited.set(sourceId, list)
    }
  }

  return {
    query: report.query,
    generatedAt: report.provenance.generatedAt,
    runId: report.runId,
    pipeline: report.provenance.pipeline,
    template: report.provenance.template,
    overview: {
      sourceCount: materials.sources.length,
      fullTextCount: materials.sources.filter((source) => source.status === 'full').length,
      themeCount: materials.themes.length,
      gapCount: materials.gaps.length,
      conflictCount: materials.conflicts.length,
    },
    themes: materials.themes,
    gaps: materials.gaps,
    conflicts: materials.conflicts,
    sources: materials.sources.map((source) => ({
      ...source,
      citedByThemes: cited.get(source.id) ?? [],
    })),
  }
}

/** 资料文件输出插件。 */
export class MaterialsOutput implements OutputPlugin {
  readonly id = 'output-materials'
  readonly kind = 'output' as const
  readonly format = 'materials'

  async render(report: Report, ctx: PluginContext, _signal?: AbortSignal): Promise<readonly Artifact[]> {
    const materials = report.materials
    if (materials === undefined) {
      // 没有证据本体时不算失败，只是没有可写的东西
      ctx.log.debug('本次报告没有资料文件内容（materials），跳过')
      return []
    }

    return [
      await ctx.store.writeText('materials.md', renderMaterialsMarkdown(report, materials), 'markdown'),
      await ctx.store.writeJson('materials.json', buildMaterialsJson(report, materials)),
    ]
  }
}

/** 插件清单。 */
export const materialsOutputPlugin: PluginManifest = definePlugin({
  id: 'output-materials',
  kind: 'output',
  version: '0.1.0',
  title: '资料文件',
  description: '输出 materials.md + materials.json：证据本体（主题、逐字引文、盲区、分歧、语料清单含抽取实现）。',
  entry: new MaterialsOutput(),
})
