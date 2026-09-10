/**
 * 资料文件输出插件的测试。
 *
 * 资料文件是这次调研的**证据本体**，所以两条性质最重要：
 *   · 论断能精确指回来源（id 对得上）
 *   · 被过滤的条目也保留在清单里并写明原因——筛必有漏，藏起来比漏掉更糟
 */

import { describe, expect, it } from 'vitest'
import { buildMaterialsJson, MaterialsOutput, renderMaterialsMarkdown } from '../src/plugins/output-materials/index.ts'
import type { Report, ReportMaterials } from '../src/main/engine/types.ts'
import { makeContext } from './helpers/fake-context.ts'
import { FakeFetch } from './helpers/fake-fetch.ts'
import { FakeLlm, FakeSearch } from './helpers/fakes.ts'

/** 一份带地图与语料的报告。 */
function makeReport(materials?: ReportMaterials): Report {
  return {
    runId: 'r1',
    query: 'WebGPU 支持现状',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    sources: [],
    documents: [],
    failures: [],
    synthesis: { title: 'T', summary: 'S', sections: [] },
    provenance: {
      engine: '0.1.0',
      pipeline: 'pipeline-research',
      search: 'search-duckduckgo',
      searchFallbackUsed: false,
      organize: 'pipeline-research',
      outputs: ['output-materials'],
      template: 'report',
      generatedAt: '2026-01-01T00:00:01.000Z',
    },
    ...(materials === undefined ? {} : { materials }),
  }
}

/** 一份典型的资料数据。 */
function makeMaterials(): ReportMaterials {
  return {
    themes: [
      {
        id: 'n-abc',
        topic: '浏览器支持',
        summary: '主流引擎已实现，移动端仍有差距',
        claims: [
          { text: 'Chrome 与 Edge 已完整支持', quote: 'Chrome 和 Edge 已完整支持', sourceIds: ['s001'] },
          { text: '移动端覆盖不足', sourceIds: ['s002'] },
        ],
        sourceIds: ['s001', 's002'],
      },
      {
        id: 'n-def',
        topic: '性能特征',
        summary: '计算负载收益更明显',
        claims: [],
        sourceIds: ['s002'],
      },
    ],
    gaps: ['缺少移动端实测数据'],
    conflicts: [{ topic: '性能', positions: ['甲说更快', '乙说更慢'] }],
    sources: [
      { id: 's001', url: 'https://a.com/1', title: '甲文', status: 'full', extraction: 'readability', relevance: 'kept' },
      { id: 's002', url: 'https://b.com/2', title: '乙文', status: 'full', extraction: 'plain-text', extractionFallbackReason: 'Readability 只取到 100 字，低于闸门 500 字', relevance: 'kept' },
      { id: 's003', url: 'https://c.com/3', title: '广告页', status: 'full', extraction: 'readability', relevance: 'irrelevant', filterReason: '模型判定与主题无关' },
      { id: 's004', url: 'https://d.com/4', title: '抓不到的页', status: 'snippet-only', relevance: 'kept', filterReason: '抓取失败：HTTP 403' },
    ],
  }
}

/** 造一个测试上下文。 */
function context(): ReturnType<typeof makeContext> {
  return makeContext({
    llm: new FakeLlm('fake-llm'),
    search: new FakeSearch('fake-search'),
    fetch: new FakeFetch(() => ({ status: 404, body: 'nope' })),
  })
}

describe('资料文件的 Markdown 渲染', () => {
  it('包含概览、主题、盲区、分歧与语料清单', () => {
    const markdown = renderMaterialsMarkdown(makeReport(makeMaterials()), makeMaterials())

    expect(markdown).toContain('# 资料文件：WebGPU 支持现状')
    expect(markdown).toContain('语料 **4** 条')
    expect(markdown).toContain('主题 **2** 个')
    expect(markdown).toContain('### 浏览器支持')
    expect(markdown).toContain('## 尚未覆盖的方面')
    expect(markdown).toContain('缺少移动端实测数据')
    expect(markdown).toContain('## 存在分歧的问题')
    expect(markdown).toContain('甲说更快')
    expect(markdown).toContain('## 语料清单')
  })

  it('论断带逐字引文，并指回来源编号', () => {
    const markdown = renderMaterialsMarkdown(makeReport(makeMaterials()), makeMaterials())
    expect(markdown).toContain('- Chrome 与 Edge 已完整支持')
    expect(markdown).toContain('  > Chrome 和 Edge 已完整支持')
    expect(markdown).toContain('来源：[s001]')
  })

  it('逐篇标注抽取实现，回退的附上原因', () => {
    const markdown = renderMaterialsMarkdown(makeReport(makeMaterials()), makeMaterials())
    expect(markdown).toContain('已抓取正文 · Readability')
    expect(markdown).toContain('纯文本回退（Readability 只取到 100 字')
  })

  it('被过滤与抓取失败的条目仍留在清单里，并写明原因', () => {
    const markdown = renderMaterialsMarkdown(makeReport(makeMaterials()), makeMaterials())
    expect(markdown).toContain('广告页')
    expect(markdown).toContain('**已过滤：模型判定与主题无关**')
    expect(markdown).toContain('抓不到的页')
    expect(markdown).toContain('未抓到正文：抓取失败：HTTP 403')
  })

  it('没有主题时明确说明，而不是留一片空白', () => {
    const materials: ReportMaterials = { ...makeMaterials(), themes: [], gaps: [], conflicts: [] }
    const markdown = renderMaterialsMarkdown(makeReport(materials), materials)
    expect(markdown).toContain('本次没有归纳出主题')
    expect(markdown).toContain('## 语料清单')
  })
})

describe('资料文件的 JSON 导出', () => {
  it('带概览统计与「每条语料被哪些主题引用」', () => {
    const exported = buildMaterialsJson(makeReport(makeMaterials()), makeMaterials()) as {
      overview: Record<string, number>
      sources: { id: string; citedByThemes: string[] }[]
      query: string
      template: string
    }
    expect(exported.query).toBe('WebGPU 支持现状')
    expect(exported.template).toBe('report')
    expect(exported.overview).toMatchObject({
      sourceCount: 4,
      fullTextCount: 3,
      themeCount: 2,
      gapCount: 1,
      conflictCount: 1,
    })
    expect(exported.sources.find((source) => source.id === 's001')?.citedByThemes).toEqual(['浏览器支持'])
    expect(exported.sources.find((source) => source.id === 's003')?.citedByThemes).toEqual([])
  })
})

describe('资料文件插件', () => {
  it('写出 materials.md 与 materials.json 两个产物', async () => {
    const { ctx, store } = context()
    const artifacts = await new MaterialsOutput().render(makeReport(makeMaterials()), ctx)

    expect(artifacts.map((artifact) => artifact.path).sort()).toEqual(['materials.json', 'materials.md'])
    expect(store.files.get('materials.md')).toContain('# 资料文件')
    expect(JSON.parse(store.files.get('materials.json') ?? '{}')).toHaveProperty('themes')
  })

  it('没有资料内容时返回空数组，而不是失败', async () => {
    const { ctx } = context()
    const artifacts = await new MaterialsOutput().render(makeReport(undefined), ctx)
    expect(artifacts).toEqual([])
  })
})
