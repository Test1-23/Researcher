/**
 * 大纲任务的测试。
 *
 * 重点：
 *   · 满足判据是**覆盖度**（固定节在位、可展开节够数、每节有支撑、地图无遗漏）
 *   · 支撑不足时它**写缺口请求**而不是自己去搜
 *   · 「地图变了 → 大纲过期」用的是 mapRevision，不会因为记一条日志就误判
 */

import { describe, expect, it } from 'vitest'
import { Blackboard } from '../src/main/engine/agent/blackboard.ts'
import { LlmMeter } from '../src/main/engine/agent/llm.ts'
import { OutlineTask, describeMap } from '../src/main/engine/agent/outline-task.ts'
import type { CorpusSource, MapNode, Outline, OutlineSection } from '../src/main/engine/agent/types.ts'
import { templateById, BUILT_IN_TEMPLATES } from '../src/templates/index.ts'
import type { CompleteRequest, CompleteResult, LlmProvider, SearchProvider } from '../src/main/engine/types.ts'
import { staticFetch } from './helpers/fake-fetch.ts'
import { makeContext } from './helpers/fake-context.ts'

/** 只会返回预制 JSON 的假模型。 */
class ScriptedLlm implements LlmProvider {
  readonly id = 'fake-llm'
  readonly kind = 'provider' as const
  readonly supportsTools = true
  readonly calls: CompleteRequest[] = []

  constructor(private readonly replies: string[]) {}

  available(): boolean {
    return true
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const index = this.calls.length
    this.calls.push(request)
    return { text: this.replies[Math.min(index, this.replies.length - 1)] ?? '{}', model: 'fake' }
  }
}

/** 不会用到的搜索替身。 */
const unusedSearch: SearchProvider = {
  id: 'unused',
  kind: 'search',
  available: () => true,
  search: async () => ({ providerId: 'unused', sources: [], truncated: false }),
}

/** 造一条来源。 */
function source(id: string): CorpusSource {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `标题 ${id}`,
    text: '正文内容',
    status: 'full',
    foundByQueries: ['q'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    relevance: 'kept',
  }
}

/** 造一个地图节点。 */
function node(id: string, topic: string, sourceIds: readonly string[]): MapNode {
  return {
    id,
    topic,
    summary: `${topic} 的概述`,
    claims: [{ text: `${topic} 的论断`, sourceIds }],
    sourceIds,
    level: 1,
  }
}

/** 把黑板填到「有地图、有多条来源」的状态。 */
function seedBoard(): Blackboard {
  const board = new Blackboard('WebGPU 支持现状')
  board.addSources([source('s1'), source('s2'), source('s3'), source('s4')])
  board.mergeMap(
    [node('n1', '浏览器支持', ['s1', 's2']), node('n2', '性能特征', ['s3', 's4'])],
    [],
    [],
  )
  return board
}

/** 构造一份合法的大纲响应。 */
function outlineReply(sections: readonly { slot: string; heading: string; sources: number[] }[]): string {
  return JSON.stringify({
    title: '报告标题',
    thesis: '一句话主线',
    sections: sections.map((section) => ({
      slot: section.slot,
      heading: section.heading,
      goal: `${section.heading} 的目标`,
      sourceIndexes: section.sources,
    })),
    coverage: '覆盖良好',
  })
}

/** report 模板要求的固定节：abstract / background / conclusion，可展开：body。 */
const REPORT = templateById('report')

describe('模板', () => {
  it('三份内置模板都有固定节与可展开节', () => {
    expect(BUILT_IN_TEMPLATES.map((template) => template.id).sort()).toEqual(['brief', 'lecture', 'report'])
    for (const template of BUILT_IN_TEMPLATES) {
      expect(template.slots.some((slot) => slot.kind === 'fixed')).toBe(true)
      expect(template.slots.some((slot) => slot.kind === 'expandable')).toBe(true)
      expect(template.writingGuidance.length).toBeGreaterThan(0)
    }
  })

  it('未知模板回退到默认模板而不是报错', () => {
    expect(templateById('不存在的模板').id).toBe('report')
    expect(templateById(undefined).id).toBe('report')
  })
})

describe('大纲任务的覆盖度判据', () => {
  it('固定节缺失 → 未满足，并写明缺哪一节', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      // 只给了 body 与 abstract，缺 background 与 conclusion
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [1] },
        { slot: 'body', heading: '现状一', sources: [1, 2] },
        { slot: 'body', heading: '现状二', sources: [3, 4] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)

    expect(task.isSatisfied(board)).toBe(false)
    const problems = task.checkCoverage(board, board.outline as Outline)
    expect(problems.some((problem) => problem.why.includes('背景'))).toBe(true)
  })

  it('每节支撑不足 → 未满足，并指出是哪一节', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [1] },
        { slot: 'background', heading: '背景', sources: [] }, // 0 条支撑
        { slot: 'body', heading: '现状一', sources: [1, 2] },
        { slot: 'body', heading: '现状二', sources: [3, 4] },
        { slot: 'conclusion', heading: '结论', sources: [1] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)
    const problems = task.checkCoverage(board, board.outline as Outline)
    expect(problems.some((problem) => problem.what.includes('背景'))).toBe(true)
  })

  it('地图上有主题没被任何一节用到 → 未满足', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [1, 2] },
        { slot: 'background', heading: '背景', sources: [1, 2] },
        // 只用了 n1 的来源，n2（s3/s4）完全没被用到
        { slot: 'body', heading: '现状一', sources: [1, 2] },
        { slot: 'body', heading: '现状二', sources: [1, 2] },
        { slot: 'conclusion', heading: '结论', sources: [1, 2] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)
    const problems = task.checkCoverage(board, board.outline as Outline)
    expect(problems.some((problem) => problem.why.includes('主题'))).toBe(true)
  })

  it('全部达标 → 满足', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [1, 2] },
        { slot: 'background', heading: '背景', sources: [1, 2] },
        { slot: 'body', heading: '浏览器支持', sources: [1, 2] },
        { slot: 'body', heading: '性能特征', sources: [3, 4] },
        { slot: 'conclusion', heading: '结论', sources: [1, 3] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)
    expect(task.checkCoverage(board, board.outline as Outline)).toEqual([])
    expect(task.isSatisfied(board)).toBe(true)
    expect(task.explain(board)).toBe('覆盖度达标')
  })

  it('模型编造 slot 的小节被丢弃；解析不出任何小节则抛错', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      JSON.stringify({
        title: 'T',
        thesis: 'th',
        sections: [{ slot: '根本不存在的槽位', heading: 'X', goal: 'g', sourceIndexes: [1] }],
      }),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await expect(task.step(board, ctx)).rejects.toThrowError(/没有任何可用的小节/)
  })
})

describe('大纲任务与搜索任务的协作', () => {
  it('支撑不足时写缺口请求，而不是自己去搜', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [1] },
        { slot: 'background', heading: '背景', sources: [] },
        { slot: 'body', heading: '现状一', sources: [1, 2] },
        { slot: 'body', heading: '现状二', sources: [3, 4] },
        { slot: 'conclusion', heading: '结论', sources: [1] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)

    // 缺口请求写给 search，而不是自己处理
    expect(board.openRequests().length).toBeGreaterThan(0)
    expect(board.openRequests().every((request) => request.from === 'outline' && request.to === 'search')).toBe(true)
    // 有未处理请求时，它自己也不满足
    expect(task.isSatisfied(board)).toBe(false)
    expect(task.explain(board)).toContain('缺口请求')
  })

  it('缺口请求被搜索结清后，大纲可以重新评估为满足', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [] },
        { slot: 'background', heading: '背景', sources: [1, 2] },
        { slot: 'body', heading: '现状一', sources: [1, 2] },
        { slot: 'body', heading: '现状二', sources: [3, 4] },
        { slot: 'conclusion', heading: '结论', sources: [1, 3] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)
    expect(task.isSatisfied(board)).toBe(false)

    // 搜索把缺口结清（模拟）
    for (const request of board.openRequests()) board.resolveRequest(request.id, '已补齐')
    // 摘要这一节仍然 0 支撑，所以还是不满足——这才诚实
    expect(task.isSatisfied(board)).toBe(false)
  })
})

describe('大纲过期判定', () => {
  it('记一条日志不会让大纲显得过期（用的必须是 mapRevision）', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [1, 2] },
        { slot: 'background', heading: '背景', sources: [1, 2] },
        { slot: 'body', heading: '浏览器支持', sources: [1, 2] },
        { slot: 'body', heading: '性能特征', sources: [3, 4] },
        { slot: 'conclusion', heading: '结论', sources: [1, 3] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)
    expect(task.isSatisfied(board)).toBe(true)

    // 任意一条观测都会推进 revision，但不应影响地图新鲜度
    board.record('别的任务', 'note', '无关的观测')
    expect(task.isSatisfied(board)).toBe(true)
  })

  it('地图真的变了，大纲即被视为过期', async () => {
    const board = seedBoard()
    const llm = new ScriptedLlm([
      outlineReply([
        { slot: 'abstract', heading: '摘要', sources: [1, 2] },
        { slot: 'background', heading: '背景', sources: [1, 2] },
        { slot: 'body', heading: '浏览器支持', sources: [1, 2] },
        { slot: 'body', heading: '性能特征', sources: [3, 4] },
        { slot: 'conclusion', heading: '结论', sources: [1, 3] },
      ]),
    ])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)
    expect(task.isSatisfied(board)).toBe(true)

    board.mergeMap([node('n3', '新主题', ['s1'])], [], [])
    expect(task.isSatisfied(board)).toBe(false)
    expect(task.explain(board)).toContain('地图已更新')
  })

  it('地图为空时不空转，也不产生缺口请求', async () => {
    const board = new Blackboard('空主题')
    const llm = new ScriptedLlm([outlineReply([])])
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const task = new OutlineTask(REPORT, undefined, new LlmMeter())

    await task.step(board, ctx)
    expect(llm.calls).toHaveLength(0) // 没调模型
    expect(board.openRequests()).toHaveLength(0)
    expect(board.journal.some((entry) => entry.message.includes('地图为空'))).toBe(true)
  })
})

describe('地图压缩成清单', () => {
  it('包含主题、来源编号、分歧与盲区', () => {
    const text = describeMap(
      {
        nodes: [node('n1', '浏览器支持', ['s1', 's2'])],
        gaps: ['缺少移动端实测'],
        conflicts: [{ topic: '性能', positions: ['甲说更快', '乙说更慢'] }],
      },
      200,
    )
    expect(text).toContain('浏览器支持')
    expect(text).toContain('s1、s2')
    expect(text).toContain('存在分歧的问题')
    expect(text).toContain('甲说更快')
    expect(text).toContain('缺少移动端实测')
  })

  it('空地图返回明确占位而不是空串', () => {
    expect(describeMap({ nodes: [], gaps: [], conflicts: [] }, 100)).toBe('（地图为空）')
  })
})

/** 让类型在测试里被引用到。 */
export type { OutlineSection }
