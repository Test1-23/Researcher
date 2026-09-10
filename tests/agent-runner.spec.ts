/**
 * 黑板与不动点运行器的测试。
 *
 * 这里测的是**控制模型**，不是任何具体任务：
 *   · 地图只增不减（结构性保证，不是约定）
 *   · 每次变更都推进版本号，于是「本轮有没有变化」可被观测
 *   · 任务能互相重新激活，且最终收敛
 *   · 收敛 / 卡死 / 撞护栏 三种收尾都被如实区分
 */

import { describe, expect, it } from 'vitest'
import { Blackboard, emptyMap } from '../src/main/engine/agent/blackboard.ts'
import { runToFixedPoint } from '../src/main/engine/agent/runner.ts'
import type { AgentTask, BlackboardView, CorpusSource, MapNode } from '../src/main/engine/agent/types.ts'
import type { PluginContext } from '../src/main/engine/types.ts'

/** 一条来源。 */
function source(id: string, url = `https://example.com/${id}`, text = '正文'): CorpusSource {
  return {
    id,
    url,
    title: `标题 ${id}`,
    text,
    status: 'full',
    foundByQueries: ['q'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    relevance: 'kept',
  }
}

/** 一个地图节点。 */
function node(id: string, sourceIds: readonly string[], claimText = `论断 ${id}`): MapNode {
  return {
    id,
    topic: `主题 ${id}`,
    summary: `简介 ${id}`,
    claims: [{ text: claimText, sourceIds }],
    sourceIds,
    level: 1,
  }
}

/** 运行器只需要 ctx 的极少部分；测试里给个空壳。 */
const fakeCtx = {} as PluginContext

describe('黑板', () => {
  it('初始是空的', () => {
    const board = new Blackboard('测试')
    expect(board.map).toEqual(emptyMap())
    expect(board.sources).toEqual([])
    expect(board.revision).toBe(0)
  })

  it('追加来源按 URL 去重，并返回真正新增数', () => {
    const board = new Blackboard('q')
    expect(board.addSources([source('a'), source('b')])).toBe(2)
    expect(board.addSources([source('b'), source('c')])).toBe(1)
    expect(board.sources.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('地图只增不减：同 id 节点做并集，已有来源与论断不会丢', () => {
    const board = new Blackboard('q')
    board.mergeMap([node('n1', ['a'], '原始论断')], [], [])
    board.mergeMap([node('n1', ['b'], '新增论断')], [], [])

    const merged = board.map.nodes.find((item) => item.id === 'n1')
    expect([...(merged?.sourceIds ?? [])].sort()).toEqual(['a', 'b'])
    expect((merged?.claims ?? []).map((claim) => claim.text).sort()).toEqual(['原始论断', '新增论断'].sort())
  })

  it('只是加厚已有节点（没有新节点）时也要落盘并推进版本号', () => {
    const board = new Blackboard('q')
    board.mergeMap([node('n1', ['a'])], [], [])
    const revision = board.revision
    // 返回值是「新增节点数」= 0，但内容确实变厚了
    expect(board.mergeMap([node('n1', ['b'])], [], [])).toBe(0)
    expect(board.revision).toBeGreaterThan(revision)
    expect(board.map.nodes[0]?.sourceIds).toHaveLength(2)
  })

  it('合并空内容不推进版本号（否则无进展检测会失效）', () => {
    const board = new Blackboard('q')
    board.mergeMap([node('n1', ['a'])], [], [])
    const revision = board.revision
    expect(board.mergeMap([node('n1', ['a'])], [], [])).toBe(0)
    expect(board.revision).toBe(revision)
  })

  it('缺口请求可添加与结清，重复 id 不会重复添加', () => {
    const board = new Blackboard('q')
    const request = { id: 'r1', from: 'outline', to: 'search', what: 'X', why: 'Y', status: 'open' as const }
    board.addRequest(request)
    board.addRequest(request)
    expect(board.requests).toHaveLength(1)
    expect(board.openRequests()).toHaveLength(1)

    board.resolveRequest('r1', '已补齐')
    expect(board.openRequests()).toHaveLength(0)
    expect(board.requests[0]?.resolution).toBe('已补齐')
  })

  it('写同一节会覆盖而不是追加', () => {
    const board = new Blackboard('q')
    board.writeSection({ outlineSectionId: 's1', heading: 'H', body: 'v1', sourceIds: [], selfCheckPassed: false })
    board.writeSection({ outlineSectionId: 's1', heading: 'H', body: 'v2', sourceIds: [], selfCheckPassed: true })
    expect(board.document).toHaveLength(1)
    expect(board.document[0]?.body).toBe('v2')
  })

  it('序列化往返保留全部状态', () => {
    const board = new Blackboard('话题')
    board.addSources([source('a')])
    board.mergeMap([node('n1', ['a'])], ['缺 X'], [{ topic: 'T', positions: ['甲', '乙'] }])
    board.setOutline({ title: 'T', thesis: 'th', sections: [], builtFromRevision: 1 })
    board.record('test', 'note', '一条观测')

    const restored = Blackboard.fromJSON(board.toJSON())
    expect(restored.query).toBe('话题')
    expect(restored.sources).toHaveLength(1)
    expect(restored.map.nodes).toHaveLength(1)
    expect(restored.map.gaps).toEqual(['缺 X'])
    expect(restored.outline?.title).toBe('T')
  })
})

/** 造一个「每步都推进、走 n 步后满足」的任务。 */
function finiteTask(name: string, doneAfter: number, onStep?: (board: BlackboardView) => void): AgentTask {
  let steps = 0
  return {
    name,
    safetyLimit: 50,
    isSatisfied: () => steps >= doneAfter,
    explain: () => (steps >= doneAfter ? '已完成' : `还需 ${doneAfter - steps} 步`),
    step: async (board) => {
      steps += 1
      board.record(name, 'step', `第 ${steps} 步`)
      onStep?.(board)
    },
  }
}

describe('不动点运行器', () => {
  it('所有任务一开始就满足时立刻收敛', async () => {
    const board = new Blackboard('q')
    const outcome = await runToFixedPoint([finiteTask('a', 0)], board, fakeCtx, { globalLimit: 10 })
    expect(outcome.status).toBe('converged')
    expect(outcome.iterations).toBe(1)
    expect(outcome.unsatisfied).toEqual([])
  })

  it('跑到所有任务都满足为止', async () => {
    const board = new Blackboard('q')
    const outcome = await runToFixedPoint(
      [finiteTask('a', 2), finiteTask('b', 3)],
      board,
      fakeCtx,
      { globalLimit: 50 },
    )
    expect(outcome.status).toBe('converged')
    expect(outcome.iterations).toBeGreaterThanOrEqual(3)
  })

  it('任务可以互相重新激活：一个任务写下的东西能让另一个重新变得未满足', async () => {
    const board = new Blackboard('q')
    let outlineRounds = 0
    let searchRounds = 0

    // 搜索：只要黑板上有未处理的缺口请求，就还没满足
    const search: AgentTask = {
      name: 'search',
      safetyLimit: 20,
      isSatisfied: (b) => b.requests.every((request) => request.status !== 'open'),
      explain: () => '还有缺口请求',
      step: async (b) => {
        searchRounds += 1
        const open = b.requests.find((request) => request.status === 'open')
        if (open !== undefined) b.resolveRequest(open.id, '已补齐')
        b.record('search', 'step', '补了一轮')
      },
    }

    // 大纲：地图节点不够就提缺口请求（它自己不搜）
    const outline: AgentTask = {
      name: 'outline',
      safetyLimit: 20,
      isSatisfied: (b) => (b.outline?.sections.length ?? 0) >= 2 && b.requests.every((r) => r.status !== 'open'),
      explain: () => '大纲还没覆盖两节',
      step: async (b) => {
        outlineRounds += 1
        const covered = b.outline?.sections.length ?? 0
        if (covered < 2) {
          b.addRequest({
            id: `gap-${covered}`,
            from: 'outline',
            to: 'search',
            what: `第 ${covered + 1} 节缺资料`,
            why: '支撑不足',
            status: 'open',
          })
          b.setOutline({
            title: 'T',
            thesis: 'th',
            sections: Array.from({ length: covered + 1 }, (_, index) => ({
              id: `s${index}`,
              heading: `第 ${index + 1} 节`,
              goal: 'g',
              sourceIds: [],
            })),
            builtFromRevision: b.revision,
          })
        }
      },
    }

    const outcome = await runToFixedPoint([search, outline], board, fakeCtx, { globalLimit: 40 })

    expect(outcome.status).toBe('converged')
    // 搜索确实被大纲的缺口请求反复唤醒过
    expect(searchRounds).toBeGreaterThanOrEqual(2)
    expect(outlineRounds).toBeGreaterThanOrEqual(2)
    expect(board.requests.every((request) => request.status === 'resolved')).toBe(true)
  })

  it('撞上单任务护栏时如实报告「条件未满足」，不假装完成', async () => {
    const board = new Blackboard('q')
    const stubborn: AgentTask = {
      name: 'stubborn',
      safetyLimit: 2,
      isSatisfied: () => false,
      explain: () => '永远不满足',
      step: async (b) => b.record('stubborn', 'step', '白做一步'),
    }
    const outcome = await runToFixedPoint([stubborn], board, fakeCtx, { globalLimit: 20 })

    expect(outcome.status).toBe('limits')
    expect(outcome.unsatisfied.map((item) => item.task)).toEqual(['stubborn'])
    expect(outcome.message).toContain('安全护栏')
  })

  it('连续多轮毫无变化判定卡死', async () => {
    const board = new Blackboard('q')
    const noop: AgentTask = {
      name: 'noop',
      safetyLimit: 100,
      isSatisfied: () => false,
      explain: () => '不满足但也不干活',
      step: async () => {
        /* 什么都不写 */
      },
    }
    const outcome = await runToFixedPoint([noop], board, fakeCtx, { globalLimit: 50, stallAfter: 2 })
    expect(outcome.status).toBe('stalled')
    expect(outcome.message).toContain('没有任何进展')
  })

  it('全局迭代上限触发时报告是上限而非收敛', async () => {
    const board = new Blackboard('q')
    const outcome = await runToFixedPoint([finiteTask('slow', 1000)], board, fakeCtx, { globalLimit: 5 })
    expect(outcome.status).toBe('limits')
    expect(outcome.message).toContain('全局迭代上限')
    expect(outcome.unsatisfied).toHaveLength(1)
  })

  it('发出 task:step / task:state 事件，让「为什么停」可见', async () => {
    const board = new Blackboard('q')
    const events: { type: string; task?: string }[] = []
    await runToFixedPoint([finiteTask('a', 1)], board, fakeCtx, {
      globalLimit: 10,
      emit: (event) => events.push({ type: event.type, ...('task' in event ? { task: event.task } : {}) }),
    })
    expect(events.filter((event) => event.type === 'task:step')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'task:state').length).toBeGreaterThanOrEqual(1)
  })

  it('journal 记录每一步，可回放', async () => {
    const board = new Blackboard('q')
    await runToFixedPoint([finiteTask('a', 2)], board, fakeCtx, { globalLimit: 10 })
    const kinds = board.journal.map((entry) => entry.kind)
    expect(kinds).toContain('step')
    expect(kinds).toContain('satisfied')
    expect(board.journal.every((entry) => typeof entry.at === 'string')).toBe(true)
  })
})
