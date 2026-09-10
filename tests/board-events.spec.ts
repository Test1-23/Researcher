/**
 * 黑板变更事件与界面规模的测试。
 *
 * 计划里承诺过「界面上能看出搜索在第几轮因为什么饱和」——但只有 `task:step`
 * 是看不到「它到底攒到了多少东西」的，所以运行器要额外发 `board:change`。
 */

import { describe, expect, it } from 'vitest'
import { Blackboard } from '../src/main/engine/agent/blackboard.ts'
import { runToFixedPoint } from '../src/main/engine/agent/runner.ts'
import { IDLE_PROGRESS, reduceRunEvent, type RunProgress } from '../src/renderer/src/state.ts'
import type { AgentTask, BlackboardView } from '../src/main/engine/agent/types.ts'
import type { PluginContext, RunEvent } from '../src/main/engine/types.ts'
import { makeContext } from './helpers/fake-context.ts'
import { FakeLlm, FakeSearch } from './helpers/fakes.ts'
import { staticFetch } from './helpers/fake-fetch.ts'

const fakeCtx = {} as PluginContext

/** 造一个每步都往黑板写东西、走 n 步后满足的任务。 */
function growingTask(name: string, steps: number): AgentTask {
  let done = 0
  return {
    name,
    safetyLimit: 50,
    isSatisfied: () => done >= steps,
    explain: () => `已走 ${done} 步`,
    step: async (board: BlackboardView) => {
      done += 1
      board.addSources([{
        id: `s${done}`,
        url: `https://example.com/${done}`,
        title: `来源 ${done}`,
        text: '正文',
        status: 'full',
        foundByQueries: ['q'],
        fetchedAt: '2026-01-01T00:00:00.000Z',
        relevance: 'kept',
      }])
    },
  }
}

describe('board:change 事件', () => {
  it('每轮黑板有变化就发一条，带上当前规模', async () => {
    const board = new Blackboard('q')
    const events: RunEvent[] = []
    await runToFixedPoint([growingTask('search', 3)], board, fakeCtx, {
      globalLimit: 20,
      emit: (event) => events.push({ ...event, at: 'now' } as RunEvent),
    })

    const changes = events.filter((event) => event.type === 'board:change')
    expect(changes).toHaveLength(3)
    const last = changes.at(-1)
    expect(last?.type === 'board:change' && last.sources).toBe(3)
  })

  it('本轮毫无变化时不发（否则数字会骗人）', async () => {
    const board = new Blackboard('q')
    const events: RunEvent[] = []
    const noop: AgentTask = {
      name: 'noop',
      safetyLimit: 10,
      isSatisfied: () => false,
      explain: () => '不动',
      step: async () => {},
    }
    await runToFixedPoint([noop], board, fakeCtx, {
      globalLimit: 5,
      stallAfter: 2,
      emit: (event) => events.push({ ...event, at: 'now' } as RunEvent),
    })
    // 全程没写过黑板，因此一条 board:change 都不该有
    expect(events.filter((event) => event.type === 'board:change')).toHaveLength(0)
  })
})

describe('界面折叠 board:change', () => {
  /** 造一条事件。 */
  function event(partial: Record<string, unknown>): RunEvent {
    return { at: '2026-01-01T00:00:00.000Z', ...partial } as RunEvent
  }

  it('把黑板规模记进状态', () => {
    const next = reduceRunEvent(IDLE_PROGRESS, event({
      type: 'board:change',
      revision: 7,
      sources: 12,
      mapNodes: 5,
      gaps: 2,
      sections: 3,
    }))
    expect(next.board).toEqual({ sources: 12, mapNodes: 5, gaps: 2, sections: 3 })
  })

  it('后续事件覆盖前一次规模，而不是累加', () => {
    const first = reduceRunEvent(IDLE_PROGRESS, event({
      type: 'board:change', revision: 1, sources: 3, mapNodes: 1, gaps: 0, sections: 0,
    }))
    const second = reduceRunEvent(first, event({
      type: 'board:change', revision: 2, sources: 9, mapNodes: 4, gaps: 1, sections: 2,
    }))
    expect(second.board?.sources).toBe(9)
    expect(second.board?.mapNodes).toBe(4)
  })

  it('新运行开始时重置', () => {
    const withBoard: RunProgress = { ...IDLE_PROGRESS, board: { sources: 5, mapNodes: 2, gaps: 0, sections: 0 } }
    const restarted = reduceRunEvent(withBoard, event({
      type: 'run:start', runId: 'r2', query: 'q', pipeline: 'pipeline-research',
    }))
    expect(restarted.board).toBeUndefined()
  })

  it('task:step 带真实步数（不再有硬编码 0）', () => {
    const next = reduceRunEvent(IDLE_PROGRESS, event({
      type: 'task:step', task: 'search', step: 4, message: '第 4 步',
    }))
    expect(next.tasks[0]?.steps).toBe(4)

    const later = reduceRunEvent(next, event({
      type: 'task:state', task: 'search', satisfied: true, reason: '饱和',
    }))
    expect(later.tasks[0]?.steps).toBe(4)
    expect(later.tasks[0]?.satisfied).toBe(true)
  })
})

/** 让上下文助手在本文件里被引用到（其它用例可能用到）。 */
export { makeContext, FakeLlm, FakeSearch, staticFetch }
