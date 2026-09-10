/**
 * 输出插件测试：Markdown 渲染、HTML 渲染（转义与自包含）、JSON 导出（引用索引）。
 * 直接测纯渲染函数，不需要 run 目录。
 */

import { describe, expect, it } from 'vitest'
import type { Report } from '../src/main/engine/types.ts'
import { escapeHtml, renderReportHtml, textToParagraphs } from '../src/plugins/output-html/index.ts'
import { buildExport } from '../src/plugins/output-json/index.ts'
import { formatDuration, renderReportMarkdown, sourceStatuses } from '../src/plugins/output-markdown/index.ts'

/** 一份覆盖各种情况的样例报告。 */
function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    runId: 'run-1',
    query: '测试查询',
    startedAt: '2026-02-14T10:00:00.000Z',
    finishedAt: '2026-02-14T10:00:03.500Z',
    durationMs: 3500,
    sources: [
      { url: 'https://a.com/1', title: '来源一' },
      { url: 'https://b.com/2', title: '来源二' },
      { url: 'https://c.com/3' },
    ],
    documents: [
      { url: 'https://a.com/1', sourceUrl: 'https://a.com/1', status: 200, title: '来源一', text: '正文内容', truncated: false },
    ],
    failures: [{ url: 'https://b.com/2', reason: 'HTTP 404', status: 404 }],
    synthesis: {
      title: '报告标题',
      summary: '摘要内容',
      sections: [
        { heading: '第一节', body: '正文一', citations: ['https://a.com/1'] },
        { heading: '第二节', body: '正文二 <script>alert(1)</script>', citations: ['https://b.com/2', 'https://unknown.com/x'] },
      ],
    },
    provenance: {
      engine: '0.1.0',
      pipeline: 'pipeline-default',
      search: 'search-duckduckgo',
      searchFallbackUsed: true,
      provider: 'provider-openai',
      organize: 'organize-extractive',
      outputs: ['output-markdown', 'output-html'],
      model: 'fake-model',
      usage: { promptTokens: 10, completionTokens: 20 },
      degraded: '主整理插件 organize-llm 失败',
      generatedAt: '2026-02-14T10:00:03.500Z',
    },
    ...overrides,
  }
}

describe('耗时格式化', () => {
  it('按量级选择单位', () => {
    expect(formatDuration(500)).toBe('500 ms')
    expect(formatDuration(3500)).toBe('3.5 s')
    expect(formatDuration(125_000)).toBe('2 分 5 秒')
  })
})

describe('来源抓取结局', () => {
  it('区分已抓取 / 失败 / 未抓取', () => {
    const statuses = sourceStatuses(makeReport())
    expect(statuses.get('https://a.com/1')).toEqual({ kind: 'fetched', chars: 4, truncated: false })
    expect(statuses.get('https://b.com/2')).toEqual({ kind: 'failed', reason: 'HTTP 404' })
    expect(statuses.get('https://c.com/3')).toBeUndefined()
  })
})

describe('Markdown 渲染', () => {
  it('包含标题、查询、来源清单与运行信息', () => {
    const markdown = renderReportMarkdown(makeReport())
    expect(markdown).toContain('# 报告标题')
    expect(markdown).toContain('测试查询')
    expect(markdown).toContain('## 第一节')
    expect(markdown).toContain('## 来源')
    expect(markdown).toContain('## 抓取失败')
    expect(markdown).toContain('## 运行信息')
    expect(markdown).toContain('3.5 s')
  })

  it('引用映射成全局来源编号', () => {
    const markdown = renderReportMarkdown(makeReport())
    // 第一节引用第 1 个来源
    expect(markdown).toContain('[#1](https://a.com/1)')
    expect(markdown).toContain('[#2](https://b.com/2)')
    // 不在来源清单里的引用退化为直接链接
    expect(markdown).toContain('[https://unknown.com/x](https://unknown.com/x)')
  })

  it('如实描述每个来源的抓取状态', () => {
    const markdown = renderReportMarkdown(makeReport())
    expect(markdown).toContain('已抓取正文 4 字')
    expect(markdown).toContain('抓取失败：HTTP 404')
    expect(markdown).toContain('未抓取（超出本次抓取上限）')
  })

  it('写明降级说明与「未经改写」的免责声明', () => {
    const markdown = renderReportMarkdown(makeReport())
    expect(markdown).toContain('降级说明')
    expect(markdown).toContain('主整理插件 organize-llm 失败')
    expect(markdown).toContain('关键结论请点开来源原文核对')
  })

  it('没有来源与没有小节时给出明确说明，而不是空白', () => {
    const markdown = renderReportMarkdown(makeReport({
      sources: [],
      documents: [],
      failures: [],
      synthesis: { title: 'T', summary: '', sections: [] },
    }))
    expect(markdown).toContain('（没有搜索到任何来源）')
    expect(markdown).toContain('本次没有生成任何小节')
  })
})

describe('HTML 渲染', () => {
  it('是自包含单文件：没有外部样式或脚本引用', () => {
    const html = renderReportHtml(makeReport())
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).not.toContain('<link ')
    expect(html).not.toContain('<script')
  })

  it('转义正文里的 HTML，避免注入', () => {
    const html = renderReportHtml(makeReport())
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('引用编号与来源清单一致', () => {
    const html = renderReportHtml(makeReport())
    expect(html).toContain('>#1</a>')
    expect(html).toContain('>#2</a>')
  })

  it('转义与分段工具函数', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
    expect(textToParagraphs('第一段\n\n第二段\n换行')).toBe('<p>第一段</p>\n<p>第二段<br>换行</p>')
    expect(textToParagraphs('   ')).toBe('')
  })
})

describe('JSON 导出', () => {
  it('给出每个来源被哪些小节引用，以及抓取结局', () => {
    const exported = buildExport(makeReport()) as {
      query: string
      sources: { url: string; index: number; fetchStatus: string; citedBySections: string[] }[]
    }
    expect(exported.query).toBe('测试查询')
    expect(exported.sources).toHaveLength(3)
    expect(exported.sources[0]).toMatchObject({
      index: 1,
      fetchStatus: 'fetched',
      citedBySections: ['第一节'],
    })
    expect(exported.sources[1]).toMatchObject({ fetchStatus: 'failed', citedBySections: ['第二节'] })
    expect(exported.sources[2]).toMatchObject({ fetchStatus: 'skipped', citedBySections: [] })
  })

  it('保留小节结构与 provenance', () => {
    const exported = buildExport(makeReport()) as {
      sections: { heading: string }[]
      provenance: { organize: string }
    }
    expect(exported.sections.map((section) => section.heading)).toEqual(['第一节', '第二节'])
    expect(exported.provenance.organize).toBe('organize-extractive')
  })
})
