/**
 * 整理插件测试。
 *
 * 前半是纯函数（句子抽取、JSON 校验）；后半用真实的内置 organize-llm 插件跑
 * 「输出非法 JSON → 追加修复提示重试 → 仍失败则降级」这条完整路径。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, deepMerge } from '../src/main/engine/config.ts'
import { SimpleEventBus } from '../src/main/engine/events.ts'
import { Kernel } from '../src/main/engine/kernel.ts'
import { PluginRegistry } from '../src/main/engine/registry.ts'
import type { AppConfig, PluginManifest } from '../src/main/engine/types.ts'
import { parseOrganizeJson, buildMaterial } from '../src/plugins/organize-llm/index.ts'
import { stripCodeFence } from '../src/main/engine/json.ts'
import { extractKeySentences, hostnameOf, splitSentences } from '../src/plugins/organize-extractive/index.ts'
import { htmlOutputPlugin } from '../src/plugins/output-html/index.ts'
import { markdownOutputPlugin } from '../src/plugins/output-markdown/index.ts'
import { defaultPipelinePlugin } from '../src/plugins/pipeline-default/index.ts'
import { staticFetch } from './helpers/fake-fetch.ts'
import { FakeLlm, FakeSearch, SAMPLE_SOURCES, manifestOf } from './helpers/fakes.ts'

describe('句子抽取', () => {
  it('按中英文句末标点与换行切分，丢掉过短碎片', () => {
    const sentences = splitSentences(
      '这是一个用于演示的足够长的中文句子。短。Another long enough sentence here! 第三句同样也是足够长的句子。',
    )
    expect(sentences).toHaveLength(3)
    expect(sentences[0]).toBe('这是一个用于演示的足够长的中文句子。')
    expect(sentences).not.toContain('短。')
  })

  it('取前 N 句，句子之间以空格连接', () => {
    const text = '第一句是足够长的中文句子。第二句同样也是足够长的句子。第三句依旧也是足够长的。'
    expect(extractKeySentences(text, 2, 1000))
      .toBe('第一句是足够长的中文句子。 第二句同样也是足够长的句子。')
    expect(extractKeySentences(text, 10, 1000))
      .toBe('第一句是足够长的中文句子。 第二句同样也是足够长的句子。 第三句依旧也是足够长的。')
  })

  it('超过字符上限时截断并加省略号', () => {
    const clipped = extractKeySentences('这是一个特别长的句子'.repeat(6), 3, 10)
    expect(clipped).toBe(`${'这是一个特别长的句子'.repeat(6).slice(0, 10)}…`)
  })

  it('全是短句时退回非空片段，绝不返回空摘录', () => {
    // 中文短句密集的页面：一个片段都达不到长度门槛
    const text = '短句一。短句二。短句三。'
    expect(splitSentences(text)).toEqual([])
    expect(extractKeySentences(text, 2, 100)).toBe('短句一。 短句二。')
  })

  it('空文本返回空串', () => {
    expect(extractKeySentences('   ', 3, 100)).toBe('')
  })

  it('站点名兜底去掉 www 前缀', () => {
    expect(hostnameOf('https://www.example.com/a/b')).toBe('example.com')
    expect(hostnameOf('https://sub.example.com')).toBe('sub.example.com')
    expect(hostnameOf('不是 URL')).toBe('不是 URL')
  })
})

describe('模型输出 JSON 校验', () => {
  const allowed = new Set(['https://a.com/1', 'https://b.com/2'])

  it('解析合法输出', () => {
    const parsed = parseOrganizeJson(JSON.stringify({
      title: '标题',
      summary: '摘要',
      sections: [{ heading: '小节', body: '正文', citations: ['https://a.com/1'] }],
    }), allowed)
    expect(parsed.title).toBe('标题')
    expect(parsed.sections[0]?.citations).toEqual(['https://a.com/1'])
  })

  it('剥掉 markdown 代码块与前后解释文字', () => {
    const text = '好的，结果如下：\n```json\n{"title":"T","summary":"S","sections":[{"heading":"H","body":"B","citations":[]}]}\n```\n希望有帮助。'
    expect(stripCodeFence(text)).toContain('"title"')
    expect(parseOrganizeJson(text, allowed).title).toBe('T')
  })

  it('丢弃资料里不存在的引用 URL（模型编造引用）', () => {
    const parsed = parseOrganizeJson(JSON.stringify({
      title: 'T',
      summary: 'S',
      sections: [{ heading: 'H', body: 'B', citations: ['https://a.com/1', 'https://编造.com/x', 'https://b.com/2'] }],
    }), allowed)
    expect(parsed.sections[0]?.citations).toEqual(['https://a.com/1', 'https://b.com/2'])
  })

  it('引用去重', () => {
    const parsed = parseOrganizeJson(JSON.stringify({
      title: 'T', summary: 'S',
      sections: [{ heading: 'H', body: 'B', citations: ['https://a.com/1', 'https://a.com/1'] }],
    }), allowed)
    expect(parsed.sections[0]?.citations).toEqual(['https://a.com/1'])
  })

  it.each([
    ['不是 JSON', '完全不是 JSON 的一段话'],
    ['没有 sections', '{"title":"T","summary":"S"}'],
    ['sections 为空', '{"title":"T","summary":"S","sections":[]}'],
    ['sections 里没有可用项', '{"sections":[{"heading":"","body":""}]}'],
  ])('非法输出抛 LLM_BAD_JSON：%s', (_name, text) => {
    expect(() => parseOrganizeJson(text, allowed)).toThrowError(
      expect.objectContaining({ code: 'LLM_BAD_JSON' }),
    )
  })

  it('缺标题时给默认标题，小节缺标题时给占位标题', () => {
    const parsed = parseOrganizeJson('{"summary":"S","sections":[{"body":"只有正文"}]}', allowed)
    expect(parsed.title).toBe('研究报告')
    expect(parsed.sections[0]?.heading).toBe('（无标题）')
  })
})

describe('提示词资料拼装', () => {
  const input = {
    query: 'q',
    sources: SAMPLE_SOURCES,
    documents: [
      { url: 'https://example.com/a', sourceUrl: 'https://example.com/a', status: 200, title: '文档 A', text: 'A'.repeat(500), truncated: false },
    ],
    failures: [{ url: 'https://example.com/b', reason: 'HTTP 404' }],
  }

  it('带上 url、标题与正文摘录，并尊重单源上限', () => {
    const material = buildMaterial(input, { maxSources: 8, maxCharsPerSource: 100, maxTotalChars: 10_000 })
    expect(material).toContain('url: https://example.com/a')
    expect(material).toContain('标题：文档 A')
    expect(material).toContain('已截断')
    expect(material.length).toBeLessThan(1000)
  })

  it('抓取失败的来源退回摘要，并如实标注', () => {
    const material = buildMaterial(
      { ...input, documents: [] },
      { maxSources: 8, maxCharsPerSource: 100, maxTotalChars: 10_000 },
    )
    expect(material).toContain('关于 A 的摘要')
    expect(material).toContain('抓取失败，且没有摘要')
  })

  it('只取前 maxSources 条', () => {
    const material = buildMaterial(input, { maxSources: 1, maxCharsPerSource: 100, maxTotalChars: 10_000 })
    expect(material).toContain('example.com/a')
    expect(material).not.toContain('example.com/b')
  })
})

describe('LLM 整理的重试与降级（真实插件）', () => {
  const roots: string[] = []
  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'researcher-organize-'))
    roots.push(root)
    return root
  }

  async function runWithLlm(reply: (index: number) => string) {
    const root = await makeRoot()
    const llm = new FakeLlm('provider-fake', { reply: (_request, index) => reply(index) })
    const registry = new PluginRegistry()
    registry.registerAll([
      defaultPipelinePlugin,
      markdownOutputPlugin,
      htmlOutputPlugin,
      manifestOf(llm),
      manifestOf(new FakeSearch('search-fake', { sources: SAMPLE_SOURCES })),
      // 真实的内置整理插件
      ...(await import('../src/plugins/index.ts')).BUILT_IN_PLUGINS.filter((manifest: PluginManifest) =>
        manifest.kind === 'organize'),
    ])
    const config = deepMerge(DEFAULT_CONFIG, {
      pipeline: { id: 'pipeline-default' },
      search: { id: 'search-fake', maxSources: 4, maxFetch: 2 },
      provider: { id: 'provider-fake' },
      organize: { id: 'organize-llm', fallback: 'organize-extractive' },
      output: { ids: ['output-markdown'] },
    }) as AppConfig
    const kernel = new Kernel({
      registry,
      config,
      dataRoot: root,
      mirrorLogsToConsole: false,
      fetchService: staticFetch({ 'https://example.com/a': '<p>正文一</p>', 'https://example.com/b': '<p>正文二</p>' }),
    })
    const outcome = await kernel.run({ query: '测试' }, new SimpleEventBus())
    return { outcome, llm }
  }

  it('第一次输出非法 JSON 时追加修复提示重试，第二次成功', async () => {
    const valid = JSON.stringify({
      title: '模型报告',
      summary: '模型摘要',
      sections: [{ heading: '第一节', body: '正文', citations: ['https://example.com/a'] }],
    })
    const { outcome, llm } = await runWithLlm((index) => (index === 0 ? '抱歉，我不会输出 JSON' : valid))

    expect(llm.calls).toHaveLength(2)
    expect(outcome.report.synthesis.title).toBe('模型报告')
    expect(outcome.report.synthesis.meta?.attempts).toBe(2)
    expect(outcome.report.provenance.organize).toBe('organize-llm')
    // 用上了模型整理，就不该被标记降级
    expect(outcome.report.provenance.degraded).toBeUndefined()
    // 第二次请求带上了修复指令
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain('不是合法的')
  })

  it('两次都失败时降级到抽取式，并在报告里写明原因', async () => {
    const { outcome, llm } = await runWithLlm(() => '依然不是 JSON')
    expect(llm.calls).toHaveLength(2)
    expect(outcome.report.provenance.organize).toBe('organize-extractive')
    expect(outcome.report.provenance.degraded).toContain('organize-llm')
    expect(outcome.report.synthesis.meta?.degraded).toContain('organize-llm')
    // 降级后仍然产出了带引用的报告
    expect(outcome.report.synthesis.sections.length).toBeGreaterThan(0)
  })

  it('模型编造的引用会被过滤掉', async () => {
    const { outcome } = await runWithLlm(() => JSON.stringify({
      title: 'T',
      summary: 'S',
      sections: [{ heading: 'H', body: 'B', citations: ['https://a.com/1', 'https://example.com/a'] }],
    }))
    expect(outcome.report.synthesis.sections[0]?.citations).toEqual(['https://example.com/a'])
  })

  it('收尾清理临时目录', async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    expect(roots).toHaveLength(0)
  })
})
