/**
 * 自包含 HTML 输出插件。
 *
 * 产物是一个单文件 HTML（内联 CSS，无外部依赖），双击即可用浏览器打开或直接打印/另存 PDF。
 * 它不 import 任何其它插件：每个输出插件都要能独立被替换掉。
 */

import { definePlugin } from '../../main/engine/registry.ts'
import type { Artifact, OutputPlugin, PluginContext, PluginManifest, Report } from '../../main/engine/types.ts'

/** HTML 转义。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 把纯文本正文转成段落（空行分段，单换行 <br>）。 */
export function textToParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

/** 人类可读的耗时。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

/** 内联样式：不依赖任何外部资源。 */
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 3rem 1.5rem 6rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  line-height: 1.75; color: #1f2328; background: #ffffff;
  max-width: 52rem; margin-inline: auto;
}
h1 { font-size: 1.9rem; line-height: 1.3; margin: 0 0 1rem; }
h2 { font-size: 1.25rem; margin: 2.5rem 0 0.75rem; padding-bottom: .4rem; border-bottom: 1px solid #e4e7eb; }
p { margin: 0 0 1rem; }
a { color: #0b62d0; text-decoration: none; word-break: break-all; }
a:hover { text-decoration: underline; }
.meta { background: #f6f8fa; border: 1px solid #e4e7eb; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 2rem; font-size: .9rem; }
.meta div { margin: .2rem 0; }
.meta .label { display: inline-block; min-width: 6.5rem; color: #5b6470; }
.citations { font-size: .85rem; color: #5b6470; margin: -.4rem 0 1.5rem; }
.sources { list-style: none; padding: 0; counter-reset: src; }
.sources li { counter-increment: src; margin: 0 0 1rem; padding-left: 2.2rem; position: relative; font-size: .92rem; }
.sources li::before {
  content: "[" counter(src) "]"; position: absolute; left: 0; top: 0;
  color: #5b6470; font-variant-numeric: tabular-nums;
}
.status { display: block; color: #5b6470; font-size: .85rem; }
.status.failed { color: #b42318; }
.warn { background: #fff8e6; border: 1px solid #f0d9a0; border-radius: 8px; padding: .75rem 1rem; font-size: .9rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e4e7eb; color: #5b6470; font-size: .85rem; }
@media print { body { padding: 0; max-width: none; } .meta { background: none; } }
`

/** 把报告渲染成单文件 HTML。 */
export function renderReportHtml(report: Report): string {
  const citationIndex = new Map<string, number>()
  report.sources.forEach((source, index) => citationIndex.set(source.url, index + 1))

  const fetchedBySource = new Map<string, { chars: number; truncated: boolean }>()
  for (const document of report.documents) {
    fetchedBySource.set(document.sourceUrl ?? document.url, { chars: document.text.length, truncated: document.truncated })
  }
  const failedBySource = new Map(report.failures.map((failure) => [failure.url, failure.reason]))

  const meta: string[] = [
    `<div><span class="label">查询</span>${escapeHtml(report.query)}</div>`,
    `<div><span class="label">生成时间</span>${escapeHtml(report.startedAt)}（用时 ${escapeHtml(formatDuration(report.durationMs))}）</div>`,
    `<div><span class="label">整理方式</span>${escapeHtml(report.provenance.organize)}${report.provenance.model === undefined ? '' : ` · 模型 ${escapeHtml(report.provenance.model)}`}</div>`,
    `<div><span class="label">搜索方式</span>${escapeHtml(report.provenance.search)}${report.provenance.searchFallbackUsed ? '（主搜索插件不可用，已降级）' : ''}</div>`,
  ]
  if (report.provenance.degraded !== undefined) {
    meta.push(`<div><span class="label">降级说明</span>${escapeHtml(report.provenance.degraded)}</div>`)
  }
  if (report.provenance.usage !== undefined) {
    meta.push(`<div><span class="label">token 用量</span>输入 ${report.provenance.usage.promptTokens} · 输出 ${report.provenance.usage.completionTokens}</div>`)
  }

  const parts: string[] = []
  parts.push('<!doctype html>')
  parts.push('<html lang="zh-CN"><head><meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  parts.push(`<title>${escapeHtml(report.synthesis.title)}</title>`)
  parts.push(`<style>${STYLE}</style>`)
  parts.push('</head><body>')
  parts.push(`<h1>${escapeHtml(report.synthesis.title)}</h1>`)
  parts.push(`<div class="meta">${meta.join('\n')}</div>`)

  if (report.synthesis.summary.length > 0) {
    parts.push('<h2>摘要</h2>')
    parts.push(textToParagraphs(report.synthesis.summary))
  }

  if (report.synthesis.sections.length === 0) {
    parts.push('<p class="warn">本次没有生成任何小节：没有取得可用的正文或摘要。</p>')
  }
  for (const section of report.synthesis.sections) {
    parts.push(`<h2>${escapeHtml(section.heading)}</h2>`)
    parts.push(textToParagraphs(section.body))
    if (section.citations.length > 0) {
      const links = section.citations.map((url) => {
        const number = citationIndex.get(url)
        const label = number === undefined ? escapeHtml(url) : `#${number}`
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${label}</a>`
      })
      parts.push(`<p class="citations">引用：${links.join(' · ')}</p>`)
    }
  }

  parts.push('<h2>来源</h2>')
  if (report.sources.length === 0) {
    parts.push('<p>（没有搜索到任何来源）</p>')
  } else {
    parts.push('<ol class="sources">')
    for (const source of report.sources) {
      const title = source.title !== undefined && source.title.length > 0 ? source.title : source.url
      const fetched = fetchedBySource.get(source.url)
      const failure = failedBySource.get(source.url)
      let status: string
      if (fetched !== undefined) {
        status = `<span class="status">已抓取正文 ${fetched.chars} 字${fetched.truncated ? '（已截断）' : ''}</span>`
      } else if (failure !== undefined) {
        status = `<span class="status failed">抓取失败：${escapeHtml(failure)}</span>`
      } else {
        status = '<span class="status">未抓取（超出本次抓取上限）</span>'
      }
      parts.push(`<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(title)}</a>${status}</li>`)
    }
    parts.push('</ol>')
  }

  if (report.failures.length > 0) {
    parts.push('<h2>抓取失败</h2><ul>')
    for (const failure of report.failures) {
      parts.push(`<li>${escapeHtml(failure.url)} — ${escapeHtml(failure.reason)}</li>`)
    }
    parts.push('</ul>')
  }

  parts.push('<h2>运行信息</h2><ul>')
  parts.push(`<li>引擎版本：${escapeHtml(report.provenance.engine)}</li>`)
  parts.push(`<li>主流程：${escapeHtml(report.provenance.pipeline)}</li>`)
  parts.push(`<li>搜索插件：${escapeHtml(report.provenance.search)}</li>`)
  if (report.provenance.provider !== undefined) parts.push(`<li>大模型插件：${escapeHtml(report.provenance.provider)}</li>`)
  parts.push(`<li>整理插件：${escapeHtml(report.provenance.organize)}</li>`)
  parts.push(`<li>输出插件：${escapeHtml(report.provenance.outputs.join('、'))}</li>`)
  parts.push(`<li>run id：${escapeHtml(report.runId)}</li>`)
  parts.push('</ul>')

  parts.push('<footer>本报告的正文由上述整理插件生成。引用编号对应「来源」列表；'
    + '大模型整理可能概括失准，关键结论请点开来源原文核对。</footer>')
  parts.push('</body></html>')

  return parts.join('\n')
}

/** HTML 输出插件。 */
export class HtmlOutput implements OutputPlugin {
  readonly id = 'output-html'
  readonly kind = 'output' as const
  readonly format = 'html'

  async render(report: Report, ctx: PluginContext, _signal?: AbortSignal): Promise<readonly Artifact[]> {
    return [await ctx.store.writeText('report.html', renderReportHtml(report), this.format)]
  }
}

/** 插件清单。 */
export const htmlOutputPlugin: PluginManifest = definePlugin({
  id: 'output-html',
  kind: 'output',
  version: '0.1.0',
  title: 'HTML 报告',
  description: '输出单文件 report.html：内联 CSS、无外部依赖，可直接打开、分享或打印成 PDF。',
  entry: new HtmlOutput(),
})
