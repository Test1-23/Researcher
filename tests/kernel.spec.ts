/**
 * 内核的端到端测试。
 *
 * 关键的一条是「零 key 跑通」：用真实的内置注册表（DeepSeek 搜索无 key 会自动降级到
 * DuckDuckGo，整理自动降级到抽取式），只把网络层换成夹具，验证整条链路真的能产出报告。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, deepMerge } from '../src/main/engine/config.ts'
import { ResearcherError } from '../src/main/engine/errors.ts'
import { SimpleEventBus } from '../src/main/engine/events.ts'
import { FileRunStore } from '../src/main/engine/run-store.ts'
import { Kernel } from '../src/main/engine/kernel.ts'
import { PluginRegistry } from '../src/main/engine/registry.ts'
import type { AppConfig, EventBus, FetchService, PluginManifest, RunEvent } from '../src/main/engine/types.ts'
import { createRegistry } from '../src/plugins/index.ts'
import { dedupeSources, normalizeSourceUrl } from '../src/plugins/pipeline-default/index.ts'
import { htmlOutputPlugin } from '../src/plugins/output-html/index.ts'
import { markdownOutputPlugin } from '../src/plugins/output-markdown/index.ts'
import { defaultPipelinePlugin } from '../src/plugins/pipeline-default/index.ts'
import { DUCKDUCKGO_FIXTURE, DUCKDUCKGO_PAGES, FakeFetch, staticFetch } from './helpers/fake-fetch.ts'
import { FakeOrganizer, FakeSearch, SAMPLE_SOURCES, manifestOf } from './helpers/fakes.ts'

/** 每个用例独立的临时数据根目录，避免相互污染。 */
const tempRoots: string[] = []

async function makeDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'researcher-test-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 组装一个使用假插件的内核。 */
async function makeKernel(options: {
  overrides?: Record<string, unknown>
  extra?: readonly PluginManifest[]
  fetch?: FetchService
  base?: PluginRegistry
} = {}): Promise<{ kernel: Kernel; dataRoot: string; bus: SimpleEventBus; events: RunEvent[] }> {
  const dataRoot = await makeDataRoot()
  const registry = options.base ?? new PluginRegistry()
  if (options.base === undefined) {
    registry.registerAll([
      defaultPipelinePlugin,
      markdownOutputPlugin,
      htmlOutputPlugin,
      ...(options.extra ?? []),
    ])
  }
  const config = deepMerge(DEFAULT_CONFIG, options.overrides ?? {}) as AppConfig
  const kernel = new Kernel({
    registry,
    config,
    dataRoot,
    mirrorLogsToConsole: false,
    ...(options.fetch === undefined ? {} : { fetchService: options.fetch }),
  })
  const bus = new SimpleEventBus()
  const events: RunEvent[] = []
  bus.on((event) => events.push(event))
  return { kernel, dataRoot, bus, events }
}

/** 默认的假插件配置。 */
const FAKE_IDS = {
  pipeline: { id: 'pipeline-default' },
  search: { id: 'search-fake', maxSources: 8, maxFetch: 5 },
  provider: { id: 'provider-fake' },
  organize: { id: 'organize-fake' },
  output: { ids: ['output-markdown', 'output-html'] },
}

describe('内核端到端（假插件）', () => {
  it('跑通搜索 → 抓取 → 整理 → 输出，并落盘全部产物', async () => {
    const search = new FakeSearch('search-fake', { sources: SAMPLE_SOURCES })
    const organizer = new FakeOrganizer('organize-fake')
    const { kernel, bus, events } = await makeKernel({
      overrides: FAKE_IDS,
      extra: [manifestOf(search), manifestOf(organizer)],
      fetch: staticFetch({ 'https://example.com/a': '<p>A 的正文</p>', 'https://example.com/b': '<p>B 的正文</p>' }),
    })

    const outcome = await kernel.run({ query: '  示例查询  ' }, bus)

    // 查询被 trim
    expect(outcome.report.query).toBe('示例查询')
    expect(outcome.report.sources).toHaveLength(3)
    expect(outcome.report.documents).toHaveLength(2)
    expect(outcome.report.failures).toHaveLength(1)
    expect(outcome.report.failures[0]?.reason).toContain('404')

    const paths = outcome.artifacts.map((artifact) => artifact.path)
    expect(paths).toContain('report.md')
    expect(paths).toContain('report.html')
    expect(paths).toContain('report.json')
    expect(paths).toContain('provenance.json')
    expect(paths).toContain('events.jsonl')

    // report.json 与内存中的报告一致
    const onDisk = JSON.parse(await readFile(join(outcome.runDir, 'report.json'), 'utf8')) as { query: string }
    expect(onDisk.query).toBe('示例查询')

    // 事件流完整：run:start → 各阶段 → run:done
    const types = events.map((event) => event.type)
    expect(types[0]).toBe('run:start')
    expect(types.at(-1)).toBe('run:done')
    expect(types).toContain('stage:start')
    expect(types.filter((type) => type === 'source:found')).toHaveLength(3)
    expect(types.filter((type) => type === 'fetch:done')).toHaveLength(3)

    // 每个事件都有时间戳
    expect(events.every((event) => typeof event.at === 'string' && event.at.length > 0)).toBe(true)
  })

  it('provenance 如实记录实际使用的插件与模型', async () => {
    const organizer = new FakeOrganizer('organize-fake', {
      output: {
        title: 'T',
        summary: 'S',
        sections: [{ heading: 'H', body: 'B', citations: [] }],
        meta: { model: 'some-model', usage: { promptTokens: 100, completionTokens: 50 } },
      },
    })
    const { kernel, bus } = await makeKernel({
      overrides: FAKE_IDS,
      extra: [manifestOf(new FakeSearch('search-fake', { sources: SAMPLE_SOURCES })), manifestOf(organizer)],
      fetch: staticFetch({}),
    })

    const outcome = await kernel.run({ query: 'q' }, bus)
    expect(outcome.report.provenance.pipeline).toBe('pipeline-default')
    expect(outcome.report.provenance.search).toBe('search-fake')
    expect(outcome.report.provenance.organize).toBe('organize-fake')
    expect(outcome.report.provenance.model).toBe('some-model')
    expect(outcome.report.provenance.usage).toEqual({ promptTokens: 100, completionTokens: 50 })
    expect(outcome.report.provenance.outputs).toEqual(['output-markdown', 'output-html'])
    expect(outcome.report.provenance.degraded).toBeUndefined()
  })

  it('主搜索插件不可用时降级到备用插件，并如实标记', async () => {
    const primary = new FakeSearch('search-primary', { available: false })
    const fallback = new FakeSearch('search-fallback', { sources: SAMPLE_SOURCES })
    const { kernel, bus } = await makeKernel({
      overrides: {
        ...FAKE_IDS,
        search: { id: 'search-primary', fallback: 'search-fallback', maxSources: 8, maxFetch: 1 },
      },
      extra: [manifestOf(primary), manifestOf(fallback), manifestOf(new FakeOrganizer('organize-fake'))],
      fetch: staticFetch({}),
    })

    const outcome = await kernel.run({ query: 'q' }, bus)
    expect(primary.calls).toHaveLength(0)
    expect(fallback.calls).toHaveLength(1)
    expect(outcome.report.provenance.search).toBe('search-fallback')
    expect(outcome.report.provenance.searchFallbackUsed).toBe(true)
  })

  it('两个搜索插件都不可用时给出可操作的错误', async () => {
    const { kernel, bus } = await makeKernel({
      overrides: {
        ...FAKE_IDS,
        search: { id: 'search-primary', fallback: 'search-fallback', maxSources: 8, maxFetch: 1 },
      },
      extra: [
        manifestOf(new FakeSearch('search-primary', { available: false })),
        manifestOf(new FakeSearch('search-fallback', { available: false })),
        manifestOf(new FakeOrganizer('organize-fake')),
      ],
      fetch: staticFetch({}),
    })

    await expect(kernel.run({ query: 'q' }, bus)).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' })
  })

  it('整理插件运行期失败时降级，并把原因写进报告', async () => {
    const failing = new FakeOrganizer('organize-primary', { error: new Error('模型返回了乱码') })
    const fallback = new FakeOrganizer('organize-fallback', {
      output: { title: '降级报告', summary: '降级摘要', sections: [{ heading: 'H', body: 'B', citations: [] }] },
    })
    const { kernel, bus } = await makeKernel({
      overrides: {
        ...FAKE_IDS,
        organize: { id: 'organize-primary', fallback: 'organize-fallback' },
      },
      extra: [
        manifestOf(new FakeSearch('search-fake', { sources: SAMPLE_SOURCES })),
        manifestOf(failing),
        manifestOf(fallback),
      ],
      fetch: staticFetch({}),
    })

    const outcome = await kernel.run({ query: 'q' }, bus)
    expect(outcome.report.provenance.organize).toBe('organize-fallback')
    expect(outcome.report.provenance.degraded).toContain('organize-primary')
    expect(outcome.report.synthesis.title).toBe('降级报告')
  })

  it('整理插件失败且没有降级目标时整次运行失败', async () => {
    const { kernel, bus } = await makeKernel({
      overrides: { ...FAKE_IDS, organize: { id: 'organize-primary' } },
      extra: [
        manifestOf(new FakeSearch('search-fake', { sources: SAMPLE_SOURCES })),
        manifestOf(new FakeOrganizer('organize-primary', { error: new Error('坏了') })),
      ],
      fetch: staticFetch({}),
    })

    await expect(kernel.run({ query: 'q' }, bus)).rejects.toThrowError(/坏了/)
  })

  it('拒绝空查询与超长查询', async () => {
    const { kernel, bus } = await makeKernel({ overrides: FAKE_IDS, extra: [], fetch: staticFetch({}) })
    await expect(kernel.run({ query: '   ' }, bus)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(kernel.run({ query: 'x'.repeat(2001) }, bus)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('取消后抛出 CANCELLED，且不把它当成阶段失败', async () => {
    const { kernel, bus, events } = await makeKernel({
      overrides: FAKE_IDS,
      extra: [
        manifestOf(new FakeSearch('search-fake', { sources: SAMPLE_SOURCES })),
        manifestOf(new FakeOrganizer('organize-fake')),
      ],
      fetch: staticFetch({}),
    })

    const controller = new AbortController()
    controller.abort(new Error('用户点了取消'))
    await expect(kernel.run({ query: 'q' }, bus, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(events.at(-1)?.type).toBe('run:error')
  })

  it('运行失败时上报 run:error，且错误信息里不出现 API key', async () => {
    const secret = 'sk-super-secret-key-value'
    const { kernel, bus, events } = await makeKernel({
      overrides: {
        ...FAKE_IDS,
        plugins: { 'search-fake': { apiKey: secret } },
      },
      extra: [
        manifestOf(new FakeSearch('search-fake', { error: new Error(`调用失败，key=${secret}`) })),
        manifestOf(new FakeOrganizer('organize-fake')),
      ],
      fetch: staticFetch({}),
    })

    await expect(kernel.run({ query: 'q' }, bus)).rejects.toThrowError()
    const errorEvent = events.find((event) => event.type === 'run:error')
    expect(errorEvent).toBeDefined()
    expect(JSON.stringify(errorEvent)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
  })
})

describe('零 key 端到端（真实内置插件）', () => {
  it('无任何 API key 时，整条链路仍能产出报告', async () => {
    // 确保环境里没有 key，否则真实插件会走向网络
    const saved = { deepseek: process.env['DEEPSEEK_API_KEY'] }
    delete process.env['DEEPSEEK_API_KEY']

    try {
      const dataRoot = await makeDataRoot()
      const fetch = new FakeFetch((url) =>
        url.startsWith('https://html.duckduckgo.com/')
          ? { body: DUCKDUCKGO_FIXTURE }
          : (DUCKDUCKGO_PAGES[url] === undefined ? { status: 404, body: 'nope' } : { body: DUCKDUCKGO_PAGES[url] as string }),
      )
      const kernel = new Kernel({
        registry: createRegistry(),
        config: DEFAULT_CONFIG,
        dataRoot,
        mirrorLogsToConsole: false,
        fetchService: fetch,
      })
      const bus = new SimpleEventBus()

      const outcome = await kernel.run({ query: 'Alpha 是什么' }, bus)

      // 搜索自动降级到 DuckDuckGo（免 key）
      expect(outcome.report.provenance.search).toBe('search-duckduckgo')
      expect(outcome.report.provenance.searchFallbackUsed).toBe(true)
      // 整理自动降级到抽取式（没有大模型 key）
      expect(outcome.report.provenance.organize).toBe('organize-extractive')
      expect(outcome.report.provenance.degraded).toContain('organize-llm')

      // 广告链接被过滤，只剩两个真实来源
      expect(outcome.report.sources.map((source) => source.url)).toEqual([
        'https://example.com/alpha',
        'https://example.com/beta',
      ])
      expect(outcome.report.sources[0]?.title).toBe('Alpha 官方文档')
      expect(outcome.report.documents).toHaveLength(2)

      // 抽取式整理产出了按来源分节的内容
      expect(outcome.report.synthesis.sections).toHaveLength(2)
      expect(outcome.report.synthesis.sections[0]?.citations).toEqual(['https://example.com/alpha'])

      const markdown = await readFile(join(outcome.runDir, 'report.md'), 'utf8')
      expect(markdown).toContain('# 关于「Alpha 是什么」的资料汇编')
      expect(markdown).toContain('抽取式整理')
      expect(markdown).toContain('未经大模型改写')

      const html = await readFile(join(outcome.runDir, 'report.html'), 'utf8')
      expect(html).toContain('<!doctype html>')
      expect(html).toContain('Alpha 官方文档')
    } finally {
      if (saved.deepseek !== undefined) process.env['DEEPSEEK_API_KEY'] = saved.deepseek
    }
  })

  it('无 key 时插件面板如实反映可用性', async () => {
    const saved = process.env['DEEPSEEK_API_KEY']
    delete process.env['DEEPSEEK_API_KEY']
    try {
      const dataRoot = await makeDataRoot()
      const kernel = new Kernel({
        registry: createRegistry(),
        config: DEFAULT_CONFIG,
        dataRoot,
        mirrorLogsToConsole: false,
        fetchService: staticFetch({}),
      })
      const infos = kernel.pluginInfos()
      const byId = new Map(infos.map((info) => [info.id, info]))

      expect(byId.get('search-deepseek')?.available).toBe(false)
      expect(byId.get('search-duckduckgo')?.available).toBe(true)
      expect(byId.get('provider-openai')?.available).toBe(false)
      // organize-llm 依赖 provider，因此也随之不可用——这是通过内核递归解析出来的
      expect(byId.get('organize-llm')?.available).toBe(false)
      expect(byId.get('organize-extractive')?.available).toBe(true)
      expect(byId.get('pipeline-default')?.active).toBe(true)
      expect(byId.get('output-markdown')?.active).toBe(true)
    } finally {
      if (saved !== undefined) process.env['DEEPSEEK_API_KEY'] = saved
    }
  })
})

describe('来源去重与 URL 归一化', () => {
  it('去掉 fragment、保留 http(s)、拒绝其它协议', () => {
    expect(normalizeSourceUrl('https://a.com/x#frag')).toBe('https://a.com/x')
    expect(normalizeSourceUrl('ftp://a.com/x')).toBeUndefined()
    expect(normalizeSourceUrl('不是 URL')).toBeUndefined()
  })

  it('按 URL 去重并补齐缺失的标题与摘要', () => {
    const deduped = dedupeSources([
      { url: 'https://a.com/x' },
      { url: 'https://a.com/x#section', title: '标题', snippet: '摘要' },
      { url: 'https://a.com/y', title: 'Y' },
      { url: 'ftp://a.com/z' },
    ])
    expect(deduped).toHaveLength(2)
    expect(deduped[0]).toEqual({ url: 'https://a.com/x', title: '标题', snippet: '摘要' })
    expect(deduped[1]?.title).toBe('Y')
  })
})

describe('run 仓库', () => {
  it('拒绝越界路径', async () => {
    const dir = await makeDataRoot()
    const store = new FileRunStore(dir)
    await store.ensure()
    await expect(store.writeText('../escape.txt', 'x')).rejects.toBeInstanceOf(ResearcherError)
  })

  it('列出产物时带上格式与字节数', async () => {
    const dir = await makeDataRoot()
    const store = new FileRunStore(dir)
    await store.ensure()
    await store.writeText('a/report.md', '# hi')
    await store.writeJson('b/data.json', { ok: true })
    const artifacts = await store.list()
    expect(artifacts.map((artifact) => artifact.path)).toEqual(['a/report.md', 'b/data.json'])
    expect(artifacts[0]).toMatchObject({ format: 'markdown', bytes: 4 })
    expect(artifacts[1]?.format).toBe('json')
  })
})

/** 让 EventBus 类型在测试里被引用到，避免 lint 抱怨未使用导入。 */
export type { EventBus }
