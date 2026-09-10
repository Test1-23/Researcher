/**
 * 机器可读的 JSON 输出插件。
 *
 * 内核本身已经写了一份 `report.json`（原文快照，用于排查与溯源）；
 * 这个插件产出的是**面向下游消费**的 `export.json`：在报告之外附一份引用索引，
 * 说明每个来源被哪些小节引用、抓取结局如何，方便其它程序直接接。
 */

import { definePlugin } from '../../main/engine/registry.ts'
import type { Artifact, OutputPlugin, PluginContext, PluginManifest, Report } from '../../main/engine/types.ts'

/** 一个来源的导出条目。 */
interface ExportedSource {
  readonly index: number
  readonly url: string
  readonly title: string | undefined
  readonly snippet: string | undefined
  readonly publishedAt: string | undefined
  readonly fetchStatus: 'fetched' | 'failed' | 'skipped'
  readonly fetchDetail: string | undefined
  readonly citedBySections: readonly string[]
}

/** 构造导出对象。 */
export function buildExport(report: Report): unknown {
  const citedBy = new Map<string, string[]>()
  for (const section of report.synthesis.sections) {
    for (const url of section.citations) {
      const list = citedBy.get(url) ?? []
      list.push(section.heading)
      citedBy.set(url, list)
    }
  }

  const fetchedBySource = new Map<string, { chars: number; truncated: boolean }>()
  for (const document of report.documents) {
    fetchedBySource.set(document.sourceUrl ?? document.url, { chars: document.text.length, truncated: document.truncated })
  }
  const failedBySource = new Map(report.failures.map((failure) => [failure.url, failure.reason]))

  const sources: ExportedSource[] = report.sources.map((source, position) => {
    const fetched = fetchedBySource.get(source.url)
    const failure = failedBySource.get(source.url)
    const status: ExportedSource['fetchStatus'] = fetched !== undefined ? 'fetched' : failure !== undefined ? 'failed' : 'skipped'
    return {
      index: position + 1,
      url: source.url,
      title: source.title,
      snippet: source.snippet,
      publishedAt: source.publishedAt,
      fetchStatus: status,
      fetchDetail: fetched !== undefined
        ? `${fetched.chars} 字${fetched.truncated ? '（已截断）' : ''}`
        : failure,
      citedBySections: citedBy.get(source.url) ?? [],
    }
  })

  return {
    query: report.query,
    generatedAt: report.provenance.generatedAt,
    title: report.synthesis.title,
    summary: report.synthesis.summary,
    sections: report.synthesis.sections,
    sources,
    provenance: report.provenance,
    runId: report.runId,
  }
}

/** JSON 输出插件。 */
export class JsonOutput implements OutputPlugin {
  readonly id = 'output-json'
  readonly kind = 'output' as const
  readonly format = 'json'

  async render(report: Report, ctx: PluginContext, _signal?: AbortSignal): Promise<readonly Artifact[]> {
    return [await ctx.store.writeJson('export.json', buildExport(report))]
  }
}

/** 插件清单。 */
export const jsonOutputPlugin: PluginManifest = definePlugin({
  id: 'output-json',
  kind: 'output',
  version: '0.1.0',
  title: 'JSON 导出',
  description: '输出 export.json：结构化报告 + 引用索引（每个来源被哪些小节引用、抓取结局），便于下游程序消费。',
  entry: new JsonOutput(),
})
