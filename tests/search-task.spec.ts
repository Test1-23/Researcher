/**
 * 搜索任务的测试。
 *
 * 重点验证「任务，不是流水线」这件事：
 *   · 查询由地图缺什么决定（缺口请求优先），不是执行固定清单
 *   · 终止条件来自**观测到的饱和**，不是步数
 *   · 过滤只淘汰重复与无关——**绝不按质量排序**（这条写成断言，防止被改回去）
 */

import { describe, expect, it } from 'vitest'
import { Blackboard } from '../src/main/engine/agent/blackboard.ts'
import { dedupe, filterIrrelevant, normalizeUrl, similarity, contentFingerprint } from '../src/main/engine/agent/filter.ts'
import { LlmMeter } from '../src/main/engine/agent/llm.ts'
import { SearchTask, topicId, type SearchTaskConfig } from '../src/main/engine/agent/search-task.ts'
import type { CorpusSource } from '../src/main/engine/agent/types.ts'
import type { CompleteRequest, CompleteResult, LlmProvider, SearchProvider, SearchResult } from '../src/main/engine/types.ts'
import { staticFetch } from './helpers/fake-fetch.ts'
import { makeContext } from './helpers/fake-context.ts'

/** 一条搜索结果。 */
function hit(url: string, title = url, snippet = '摘要内容'): { url: string; title: string; snippet: string } {
  return { url, title, snippet }
}

/** 按系统提示词分派的假模型：让整条流程可控。 */
class RoutingLlm implements LlmProvider {
  readonly id = 'fake-llm'
  readonly kind = 'provider' as const
  readonly supportsTools = true
  readonly calls: CompleteRequest[] = []
  /** 每次归纳返回多少条论断，用来模拟「越搜越没新增」 */
  claimBudget: number[] = []

  constructor(private readonly handlers: {
    expand?: (request: CompleteRequest) => string
    targeted?: (request: CompleteRequest) => string
    integrate?: (request: CompleteRequest, index: number) => string
    irrelevant?: (request: CompleteRequest) => string
  }) {}

  available(): boolean {
    return true
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const index = this.calls.length
    this.calls.push(request)
    const system = request.messages.find((message) => message.role === 'system')?.content ?? ''

    if (system.includes('拆成若干')) {
      return { text: this.handlers.expand?.(request) ?? '{"queries":["q1","q2"]}', model: 'fake' }
    }
    if (system.includes('下一个') && system.includes('搜索查询')) {
      return { text: this.handlers.targeted?.(request) ?? '{"query":"缺口查询"}', model: 'fake' }
    }
    if (system.includes('话题地图')) {
      const budget = this.claimBudget.shift() ?? 2
      const reply = this.handlers.integrate?.(request, index)
        ?? JSON.stringify(buildIntegration(index, budget))
      return { text: reply, model: 'fake' }
    }
    if (system.includes('资料筛选员')) {
      return { text: this.handlers.irrelevant?.(request) ?? '{"irrelevant":[],"notes":[]}', model: 'fake' }
    }
    return { text: '{}', model: 'fake' }
  }
}

/** 构造一次归纳响应：budget 条论断 + 1 个主题节点。 */
function buildIntegration(round: number, budget: number): unknown {
  const claims = Array.from({ length: budget }, (_, index) => ({
    text: `第 ${round} 轮论断 ${index + 1}`,
    quote: `原文 ${index + 1}`,
    sourceIndexes: [1],
  }))
  return {
    nodes: budget === 0 ? [] : [{ topic: `主题${round}`, summary: '简介', claims, sourceIndexes: [1] }],
    gaps: budget === 0 ? [] : [`缺口${round}`],
    conflicts: [],
  }
}

/** 按脚本逐轮返回搜索结果的假搜索插件。 */
class ScriptedSearch implements SearchProvider {
  readonly id = 'scripted'
  readonly kind = 'search' as const
  readonly queries: string[] = []

  constructor(private readonly rounds: readonly SearchResult[]) {}

  available(): boolean {
    return true
  }

  async search(request: { query: string; maxResults?: number }): Promise<SearchResult> {
    this.queries.push(request.query)
    const round = this.rounds[this.queries.length - 1]
    return round ?? { providerId: this.id, sources: [], truncated: false }
  }
}

/** 一组配置：窗口与阈值调小，方便测试。 */
const TEST_CONFIG: SearchTaskConfig = {
  candidatesPerQuery: 10,
  concurrency: 2,
  queryFanout: 2,
  saturationWindow: 2,
  saturationThreshold: 0.3,
  integrateBatchSize: 4,
}

/** 抓取替身：给每个 URL 一段够长的正文。 */
function pagesFor(urls: readonly string[]): ReturnType<typeof staticFetch> {
  return staticFetch(Object.fromEntries(urls.map((url) => [url, `<html><body><p>${'正文'.repeat(200)}</p></body></html>`])))
}

describe('URL 归一化与近似去重', () => {
  it('去掉 fragment 与追踪参数', () => {
    expect(normalizeUrl('https://a.com/x?utm_source=y#frag')).toBe('https://a.com/x')
    expect(normalizeUrl('ftp://a.com/x')).toBeUndefined()
  })

  it('相似度：同文高分、异文低分', () => {
    const a = contentFingerprint('这是一段用于测试的正文内容，重复足够多次以便形成指纹。'.repeat(20))
    const b = contentFingerprint('这是一段用于测试的正文内容，重复足够多次以便形成指纹。'.repeat(20))
    const c = contentFingerprint('完全不同的另一段文字，讲的是别的主题，与上面没有交集。'.repeat(20))
    expect(similarity(a, b)).toBeGreaterThan(0.9)
    expect(similarity(a, c)).toBeLessThan(0.2)
  })
})

describe('过滤只淘汰重复，不排序', () => {
  /** 造一条语料。 */
  function source(id: string, url: string, title: string, text = '', status: 'full' | 'snippet-only' = 'full'): CorpusSource {
    return {
      id,
      url,
      title,
      text,
      status,
      foundByQueries: ['q'],
      fetchedAt: '2026-01-01T00:00:00.000Z',
      relevance: 'kept',
    }
  }

  it('URL 重复与同域名同标题会被判为重复', () => {
    const result = dedupe([
      source('s1', 'https://a.com/1', '标题'),
      source('s2', 'https://a.com/1#x', '标题'),
      source('s3', 'https://a.com/2', '标题'), // 同域名同标题
      source('s4', 'https://b.com/1', '另一个标题'),
    ])
    expect(result.filter((item) => item.relevance === 'kept')).toHaveLength(2)
    expect(result.filter((item) => item.relevance === 'duplicate')).toHaveLength(2)
  })

  it('正文高度重合会被判为重复', () => {
    const body = '这是一篇被转载的文章正文，内容完全一样。'.repeat(30)
    const result = dedupe([
      source('s1', 'https://a.com/x', '标题甲', body),
      source('s2', 'https://b.com/y', '标题乙', body),
    ])
    expect(result.filter((item) => item.relevance === 'duplicate')).toHaveLength(1)
  })

  it('**绝不因为质量低而淘汰**：短、没摘要、权威性差的条目照样保留', () => {
    const result = dedupe([
      source('s1', 'https://a.com/1', '很短的一条', '内容很少', 'snippet-only'),
      source('s2', 'https://a.com/2', '', ''),
    ])
    expect(result.every((item) => item.relevance === 'kept')).toBe(true)
  })

  it('无关判定：模型只给下标，保留的是默认选择', async () => {
    const llm = new RoutingLlm({ irrelevant: () => '{"irrelevant":[2],"notes":["第 2 条是广告"]}' })
    const { ctx } = makeContext({ llm, search: new ScriptedSearch([]), fetch: staticFetch({}) })
    const meter = new LlmMeter()

    const sources = [
      source('s1', 'https://a.com/1', '相关甲', '正文'),
      source('s2', 'https://ad.com/x', '广告', '买买买'),
      source('s3', 'https://b.com/2', '相关乙', '正文'),
    ]
    const outcome = await filterIrrelevant('主题', sources, ctx, meter)
    expect(outcome.kept.map((item) => item.id)).toEqual(['s1', 's3'])
    expect(outcome.dropped.map((item) => item.id)).toEqual(['s2'])
    expect(outcome.notes).toContain('第 2 条是广告')
  })

  it('无关判定失败时整批保留——多留噪声远好于误删资料', async () => {
    const llm = new RoutingLlm({ irrelevant: () => '这不是 JSON' })
    const { ctx } = makeContext({ llm, search: new ScriptedSearch([]), fetch: staticFetch({}) })
    const meter = new LlmMeter()

    const sources = [source('s1', 'https://a.com/1', '甲', '正文'), source('s2', 'https://a.com/2', '乙', '正文')]
    const outcome = await filterIrrelevant('主题', sources, ctx, meter)
    expect(outcome.kept).toHaveLength(2)
    expect(outcome.notes.join('')).toContain('全部保留')
  })
})

describe('搜索任务的自终止', () => {
  it('查询来自第一轮的扩展，且会逐条用掉', async () => {
    const search = new ScriptedSearch([
      { providerId: 's', sources: [hit('https://a.com/1')], truncated: false },
      { providerId: 's', sources: [hit('https://b.com/1')], truncated: false },
    ])
    const llm = new RoutingLlm({ expand: () => '{"queries":["甲查询","乙查询"]}' })
    llm.claimBudget = [5, 5]
    const fetch = pagesFor(['https://a.com/1', 'https://b.com/1'])
    const { ctx } = makeContext({ llm, search, fetch })
    const board = new Blackboard('主题')
    const task = new SearchTask(TEST_CONFIG, new LlmMeter())

    await task.step(board, ctx)
    await task.step(board, ctx)

    expect(search.queries).toEqual(['甲查询', '乙查询'])
    expect(task.history.map((record) => record.origin)).toEqual(['expansion', 'expansion'])
  })

  it('贡献率连续低于阈值即判定饱和，并如实说明理由', async () => {
    const urls = ['https://a.com/1', 'https://b.com/1', 'https://c.com/1']
    const search = new ScriptedSearch(urls.map((url) => ({ providerId: 's', sources: [hit(url)], truncated: false })))
    const llm = new RoutingLlm({ expand: () => '{"queries":["q1","q2","q3"]}' })
    // 第一轮有新增，之后两轮毫无新增 → 饱和
    llm.claimBudget = [4, 0, 0]
    const fetch = pagesFor(urls)
    const { ctx } = makeContext({ llm, search, fetch })
    const board = new Blackboard('主题')
    const task = new SearchTask(TEST_CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(task.isSatisfied(board)).toBe(false)

    await task.step(board, ctx)
    expect(task.isSatisfied(board)).toBe(false) // 只有 1 轮低贡献，窗口是 2

    await task.step(board, ctx)
    expect(task.isSatisfied(board)).toBe(true)
    expect(task.explain(board)).toContain('贡献率')
  })

  it('贡献率仍高时不终止——终止看观测，不看步数', async () => {
    const urls = ['https://a.com/1', 'https://b.com/1', 'https://c.com/1', 'https://d.com/1']
    const search = new ScriptedSearch(urls.map((url) => ({ providerId: 's', sources: [hit(url)], truncated: false })))
    const llm = new RoutingLlm({ expand: () => '{"queries":["q1","q2","q3","q4"]}' })
    llm.claimBudget = [4, 4, 4, 4]
    const fetch = pagesFor(urls)
    const { ctx } = makeContext({ llm, search, fetch })
    const board = new Blackboard('主题')
    const task = new SearchTask(TEST_CONFIG, new LlmMeter())

    for (let index = 0; index < 3; index += 1) await task.step(board, ctx)
    expect(task.isSatisfied(board)).toBe(false)
  })

  it('缺口请求优先于预生成查询，处理完会被结清', async () => {
    const search = new ScriptedSearch([{ providerId: 's', sources: [hit('https://a.com/1')], truncated: false }])
    const targeted: string[] = []
    const llm = new RoutingLlm({
      expand: () => '{"queries":["甲查询","乙查询"]}',
      targeted: (request) => {
        targeted.push(request.messages.find((message) => message.role === 'user')?.content ?? '')
        return '{"query":"针对缺口的查询"}'
      },
    })
    llm.claimBudget = [3]
    const fetch = pagesFor(['https://a.com/1'])
    const { ctx } = makeContext({ llm, search, fetch })
    const board = new Blackboard('主题')
    board.addRequest({ id: 'g1', from: 'outline', to: 'search', what: '缺可靠来源', why: '第 2 节支撑不足', status: 'open' })

    const task = new SearchTask(TEST_CONFIG, new LlmMeter())
    expect(task.isSatisfied(board)).toBe(false)

    await task.step(board, ctx)

    expect(search.queries).toEqual(['针对缺口的查询'])
    expect(task.history[0]?.origin).toBe('gap')
    // 缺口被结清，任务状态随之变化
    expect(board.requests[0]?.status).toBe('resolved')
    expect(targeted.join('')).toContain('缺可靠来源')
  })

  it('抓取失败的候选仍以「仅摘要」形式进入语料库', async () => {
    const search = new ScriptedSearch([
      { providerId: 's', sources: [hit('https://ok.com/1', '甲'), hit('https://bad.com/1', '乙', '这条有摘要')], truncated: false },
    ])
    const llm = new RoutingLlm({ expand: () => '{"queries":["q1"]}' })
    llm.claimBudget = [2]
    // 只提供 ok 的正文，bad 会 404
    const fetch = pagesFor(['https://ok.com/1'])
    const { ctx } = makeContext({ llm, search, fetch })
    const board = new Blackboard('主题')
    const task = new SearchTask(TEST_CONFIG, new LlmMeter())

    await task.step(board, ctx)

    const bad = task.collected.find((source) => source.url === 'https://bad.com/1')
    expect(bad).toBeDefined()
    expect(bad?.status).toBe('snippet-only')
    expect(bad?.snippet).toBe('这条有摘要')
    expect(bad?.filterReason).toContain('抓取失败')
  })

  it('搜索没带来新资料时记一轮零贡献，而不是抛错', async () => {
    const search = new ScriptedSearch([{ providerId: 's', sources: [], truncated: false }])
    const llm = new RoutingLlm({ expand: () => '{"queries":["q1"]}' })
    const { ctx } = makeContext({ llm, search, fetch: staticFetch({}) })
    const board = new Blackboard('主题')
    const task = new SearchTask(TEST_CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(task.history[0]?.contribution).toBe(0)
    expect(task.history[0]?.candidates).toBe(0)
  })

  it('缺口查询生成失败时抛出可读错误，不静默跳过', async () => {
    const search = new ScriptedSearch([])
    const llm = new RoutingLlm({ targeted: () => '不是 JSON' })
    const { ctx } = makeContext({ llm, search, fetch: staticFetch({}) })
    const board = new Blackboard('主题')
    board.addRequest({ id: 'g1', from: 'outline', to: 'search', what: 'X', why: 'Y', status: 'open' })
    const task = new SearchTask(TEST_CONFIG, new LlmMeter())

    await expect(task.step(board, ctx)).rejects.toMatchObject({ code: 'LLM_BAD_JSON' })
  })
})

describe('主题 id 稳定性', () => {
  it('同一主题（含大小写与空格差异）得到同一个 id，从而被并集而不是重复', () => {
    expect(topicId('图形 API')).toBe(topicId('图形API'))
    expect(topicId('WebGPU 支持')).toBe(topicId('webgpu支持'))
  })

  it('不同主题得到不同 id', () => {
    expect(topicId('主题甲')).not.toBe(topicId('主题乙'))
  })
})
