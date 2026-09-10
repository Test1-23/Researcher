/**
 * 代理式主流程的端到端测试。
 *
 * 用一个「扮演所有角色」的假模型，把采集 → 归纳 → 大纲 → 工具循环写作 → 输出
 * 整条链路真的跑一遍，验证：
 *   · 三个任务能协作收敛
 *   · 地图饱和会终止搜索，而不是靠步数用完
 *   · 报告契约与其它主流程一致（输出链完整、引用链不断）
 *   · provenance 如实记录观测数据
 *   · 没有大模型时内核自动降到备用主流程，零 key 路径不破
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, deepMerge } from '../src/main/engine/config.ts'
import { SimpleEventBus } from '../src/main/engine/events.ts'
import { Kernel } from '../src/main/engine/kernel.ts'
import { PluginRegistry, definePlugin } from '../src/main/engine/registry.ts'
import { createRegistry } from '../src/plugins/index.ts'
import type {
  AppConfig,
  CompleteRequest,
  CompleteResult,
  LlmProvider,
  PluginManifest,
  RunEvent,
  SearchProvider,
  SearchResult,
} from '../src/main/engine/types.ts'
import { DUCKDUCKGO_FIXTURE, DUCKDUCKGO_PAGES, FakeFetch } from './helpers/fake-fetch.ts'

/** 系统提示词特征串：用来分辨模型此刻在扮演哪个角色。 */
const MARKS = {
  expand: '拆成若干',
  targeted: '你要为一个研究任务生成',
  integrate: '归纳成',
  outline: '起草大纲',
  irrelevant: '资料筛选员',
  section: '写其中的一节',
  selfCheck: '是否达标',
} as const

/** 扮演全部角色的假模型。 */
class AllRolesLlm implements LlmProvider {
  readonly id = 'fake-llm'
  readonly kind = 'provider' as const
  readonly supportsTools = true
  readonly calls: CompleteRequest[] = []
  /** 每轮归纳返回几条论断：递减即可触发饱和。 */
  claimBudget: number[] = [3, 3, 0, 0]
  private integrateRound = 0

  available(): boolean {
    return true
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    this.calls.push(request)
    const system = request.messages.find((message) => message.role === 'system')?.content ?? ''
    const user = request.messages.find((message) => message.role === 'user')?.content ?? ''

    if (system.includes(MARKS.expand)) return reply('{"queries":["WebGPU 支持现状","WebGPU browser support"]}')
    if (system.includes(MARKS.targeted)) return reply('{"query":"针对缺口的补充查询"}')
    if (system.includes(MARKS.integrate)) {
      const budget = this.claimBudget[Math.min(this.integrateRound, this.claimBudget.length - 1)] ?? 0
      this.integrateRound += 1
      return reply(JSON.stringify(integrationReply(this.integrateRound, budget)))
    }
    if (system.includes(MARKS.irrelevant)) return reply('{"irrelevant":[],"notes":[]}')
    if (system.includes(MARKS.outline)) return reply(JSON.stringify(outlineReply(user)))
    if (system.includes(MARKS.selfCheck)) return reply('{"passed":true,"notes":""}')
    if (system.includes(MARKS.section)) return reply('这是假模型写出的正文，依据了给定来源。\n\n第二段继续说明。')
    return reply('{}')
  }
}

/** 包一层标准回复。 */
function reply(text: string): CompleteResult {
  return { text, model: 'fake', usage: { promptTokens: 20, completionTokens: 10 } }
}

/** 归纳回复：budget 条论断 + 一个固定主题（同 id 会被并集加厚）。 */
function integrationReply(round: number, budget: number): unknown {
  if (budget === 0) return { nodes: [], gaps: [], conflicts: [] }
  return {
    nodes: [{
      topic: '浏览器支持',
      summary: `第 ${round} 轮的概述`,
      claims: Array.from({ length: budget }, (_, index) => ({
        text: `论断 ${round}-${index + 1}`,
        quote: `原文 ${round}-${index + 1}`,
        sourceIndexes: [1],
      })),
      sourceIndexes: [1],
    }],
    gaps: [],
    conflicts: [],
  }
}

/**
 * 大纲回复：从提示词里把来源编号抓出来，让每一节都引用真实来源。
 * 这样覆盖度检查（地图里的主题必须被某一节用到）能确定性地通过。
 */
function outlineReply(prompt: string): unknown {
  const indexes = [...new Set([...prompt.matchAll(/\bs(\d{3})\b/g)].map((match) => Number(match[1])))]
  const all = indexes.length > 0 ? indexes : [1]
  const half = Math.max(1, Math.ceil(all.length / 2))
  return {
    title: 'WebGPU 支持现状报告',
    thesis: '一句话主线',
    sections: [
      { slot: 'abstract', heading: '摘要', goal: '概括发现', sourceIndexes: all },
      { slot: 'background', heading: '背景', goal: '交代范围', sourceIndexes: all.slice(0, half) },
      { slot: 'body', heading: '浏览器支持', goal: '讲清支持情况', sourceIndexes: all },
      { slot: 'body', heading: '限制与差距', goal: '讲清限制', sourceIndexes: all.slice(-half) },
      { slot: 'conclusion', heading: '结论', goal: '给出判断', sourceIndexes: all },
    ],
    coverage: '覆盖良好',
  }
}

/** 每轮返回不同 URL 的假搜索。 */
class GrowingSearch implements SearchProvider {
  readonly id = 'growing'
  readonly kind = 'search' as const
  readonly queries: string[] = []

  available(): boolean {
    return true
  }

  async search(request: { query: string }): Promise<SearchResult> {
    this.queries.push(request.query)
    const round = this.queries.length
    return {
      providerId: this.id,
      sources: [
        { url: `https://site${round}.com/a`, title: `来源 ${round}A`, snippet: `第 ${round} 轮 A 的摘要` },
        { url: `https://site${round}.com/b`, title: `来源 ${round}B`, snippet: `第 ${round} 轮 B 的摘要` },
      ],
      truncated: false,
    }
  }
}

const roots: string[] = []
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'researcher-agentic-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 抓取替身：任何 URL 都给一段够长的正文。 */
function articleFetch(): FakeFetch {
  return new FakeFetch((url) => ({
    body: `<html><head><title>${url}</title></head><body><article><p>${'这是正文段落。'.repeat(60)}</p><p>${'第二段内容。'.repeat(60)}</p></article></body></html>`,
  }))
}

/** 用真实注册表 + 两个替身插件装配内核。 */
function buildKernel(options: {
  readonly dataRoot: string
  readonly llm: LlmProvider
  readonly search?: SearchProvider
  readonly overrides?: Record<string, unknown>
  readonly fetch: FakeFetch
}): { kernel: Kernel; bus: SimpleEventBus; events: RunEvent[] } {
  const registry = new PluginRegistry()
  for (const manifest of createRegistry().list()) registry.register(manifest)

  const extra: PluginManifest[] = [
    definePlugin({
      id: 'fake-llm',
      kind: 'provider',
      version: '0.0.0',
      title: '假模型',
      description: '测试替身',
      entry: options.llm,
    }),
  ]
  if (options.search !== undefined) {
    extra.push(definePlugin({
      id: 'growing',
      kind: 'search',
      version: '0.0.0',
      title: '假搜索',
      description: '测试替身',
      entry: options.search,
    }))
  }
  for (const manifest of extra) registry.register(manifest)

  const config = deepMerge(DEFAULT_CONFIG, {
    provider: { id: 'fake-llm' },
    ...(options.search === undefined ? {} : { search: { id: 'growing', fallback: 'growing' } }),
    ...options.overrides,
  }) as AppConfig

  const kernel = new Kernel({
    registry,
    config,
    dataRoot: options.dataRoot,
    mirrorLogsToConsole: false,
    fetchService: options.fetch,
  })
  const bus = new SimpleEventBus()
  const events: RunEvent[] = []
  bus.on((event) => events.push(event))
  return { kernel, bus, events }
}

describe('代理式主流程端到端', () => {
  it('跑通采集 → 归纳 → 大纲 → 工具循环写作 → 输出，并产出完整报告', async () => {
    const dataRoot = await makeRoot()
    const llm = new AllRolesLlm()
    const search = new GrowingSearch()
    const { kernel, bus, events } = buildKernel({
      dataRoot,
      llm,
      search,
      fetch: articleFetch(),
      overrides: {
        search: { id: 'growing', fallback: 'growing', maxSources: 20, maxFetch: 20 },
        agentic: { minSupport: 1, queryFanout: 2, candidatesPerQuery: 6 },
      },
    })

    const outcome = await kernel.run({ query: 'WebGPU 支持现状' }, bus)

    expect(outcome.report.provenance.pipeline).toBe('pipeline-research')
    expect(outcome.report.synthesis.title).toBe('WebGPU 支持现状报告')
    expect(outcome.report.synthesis.sections.length).toBeGreaterThanOrEqual(5)
    expect(outcome.report.sources.length).toBeGreaterThan(0)
    expect(outcome.report.documents.length).toBeGreaterThan(0)

    // 引用链必须完整：每节都有正文，且引用的 URL 都在来源清单里
    for (const section of outcome.report.synthesis.sections) {
      expect(section.body.length).toBeGreaterThan(0)
      expect(section.citations.length).toBeGreaterThan(0)
      for (const citation of section.citations) {
        expect(outcome.report.sources.some((source) => source.url === citation)).toBe(true)
      }
    }

    // provenance 如实记录观测数据
    const agentic = outcome.report.provenance.agentic
    expect(agentic?.outcome).toBe('converged')
    expect(agentic?.searchRounds).toBeGreaterThan(0)
    expect(agentic?.llmCalls).toBeGreaterThan(0)
    expect(agentic?.mapNodes).toBeGreaterThan(0)
    expect(agentic?.tasks.map((task) => task.name)).toContain('search')
    expect(outcome.report.provenance.template).toBe('report')

    // 产物落盘
    const paths = outcome.artifacts.map((artifact) => artifact.path)
    expect(paths).toContain('report.md')
    expect(paths).toContain('report.html')

    // 事件流里能看到任务在走
    expect(events.some((event) => event.type === 'task:step')).toBe(true)
    expect(events.some((event) => event.type === 'task:state')).toBe(true)
  })

  it('地图饱和会终止搜索——靠观测，不靠步数用完', async () => {
    const dataRoot = await makeRoot()
    const llm = new AllRolesLlm()
    llm.claimBudget = [3, 3, 0, 0, 0]
    const search = new GrowingSearch()
    const { kernel, bus } = buildKernel({
      dataRoot,
      llm,
      search,
      fetch: articleFetch(),
      overrides: {
        search: { id: 'growing', fallback: 'growing', maxSources: 20, maxFetch: 20 },
        agentic: {
          minSupport: 1,
          queryFanout: 5, // 预生成 5 条查询；饱和后不该把 5 条都用完
          candidatesPerQuery: 6,
          saturationWindow: 2,
          saturationThreshold: 0.3,
        },
      },
    })

    const outcome = await kernel.run({ query: 'WebGPU 支持现状' }, bus)

    expect(search.queries.length).toBeLessThan(5)
    expect(outcome.report.provenance.agentic?.outcome).toBe('converged')
  })

  it('没有大模型时自动降到备用主流程，零 key 路径不破', async () => {
    const dataRoot = await makeRoot()
    const registry = createRegistry()
    // 不注册假模型：provider-openai 没有 key → 代理式主流程不可用
    const config = deepMerge(DEFAULT_CONFIG, {
      search: { id: 'search-deepseek', fallback: 'search-duckduckgo', maxSources: 4, maxFetch: 2 },
    }) as AppConfig
    const kernel = new Kernel({
      registry,
      config,
      dataRoot,
      mirrorLogsToConsole: false,
      // DuckDuckGo 与文章页都走录制夹具
      fetchService: new FakeFetch((url) => {
        if (url.startsWith('https://html.duckduckgo.com/')) return { body: DUCKDUCKGO_FIXTURE }
        const page = DUCKDUCKGO_PAGES[url]
        return page === undefined ? { status: 404, body: 'not found' } : { body: page }
      }),
    })

    const infos = kernel.pluginInfos()
    expect(infos.find((info) => info.id === 'pipeline-research')?.available).toBe(false)
    expect(infos.find((info) => info.id === 'pipeline-default')?.available).toBe(true)

    const saved = process.env['DEEPSEEK_API_KEY']
    delete process.env['DEEPSEEK_API_KEY']
    try {
      const bus = new SimpleEventBus()
      const events: RunEvent[] = []
      bus.on((event) => events.push(event))
      const outcome = await kernel.run({ query: 'Alpha 与 Beta' }, bus)

      // 确实由备用主流程完成
      expect(outcome.report.provenance.pipeline).toBe('pipeline-default')
      expect(outcome.report.provenance.organize).toBe('organize-extractive')
      expect(outcome.report.provenance.searchFallbackUsed).toBe(true)
      // 降级都在日志里说清楚了
      const logText = events
        .filter((event) => event.type === 'log')
        .map((event) => (event.type === 'log' ? event.message : ''))
        .join('\n')
      expect(logText).toContain('pipeline-research')
      expect(logText).toContain('pipeline-default')
    } finally {
      if (saved !== undefined) process.env['DEEPSEEK_API_KEY'] = saved
    }
  })
})
