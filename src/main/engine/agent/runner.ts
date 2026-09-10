/**
 * 任务运行器：不动点迭代。
 *
 * 不给任务排步骤顺序，只反复问「还有谁没满足」，让没满足的走一步。
 * 任务之间通过黑板互相**重新激活**：大纲发现覆盖不足 → 写缺口请求 →
 * 搜索重新变得未满足 → 地图变厚 → 大纲也可能重新未满足 → ……直到同时满足。
 *
 * 三种收尾，都会如实报告是哪一种：
 *   · converged    —— 所有任务同时满足（正常收敛）
 *   · stalled      —— 连续多轮黑板毫无变化（震荡或卡死）
 *   · limits       —— 撞上护栏（**条件未满足**，绝不假装完成）
 */

import type { PluginContext, RunEventPayload } from '../types.ts'
import type { AgentTask, BlackboardView, Observation } from './types.ts'

/** 运行器配置。 */
export interface RunnerOptions {
  /**
   * 全局迭代上限：**护栏，不是目标**。
   *
   * 设得远超正常所需，只用来兜底「任务互相激活导致不收敛」。
   */
  readonly globalLimit: number
  /** 连续多少轮无任何变化就判定卡死。 */
  readonly stallAfter?: number
  /** 事件出口（通常是 ctx.events.emit）。 */
  readonly emit?: (event: RunEventPayload) => void
  readonly signal?: AbortSignal
}

/** 运行结果。 */
export interface RunOutcome {
  readonly status: 'converged' | 'stalled' | 'limits'
  readonly iterations: number
  /** 结束时仍未满足的任务，以及它们不能停的原因。 */
  readonly unsatisfied: readonly { readonly task: string; readonly reason: string }[]
  /** 一条人可读的收尾说明。 */
  readonly message: string
}

/** 单个任务用了多少步。 */
interface TaskState {
  readonly task: AgentTask
  steps: number
}

/**
 * 跑到不动点。
 *
 * 同一轮内任务是**顺序**执行的：后面的任务能看到前面任务刚写进黑板的内容，
 * 这正是「协作」发生的地方，也避免了并发写黑板。
 */
export async function runToFixedPoint(
  tasks: readonly AgentTask[],
  board: BlackboardView,
  ctx: PluginContext,
  options: RunnerOptions,
): Promise<RunOutcome> {
  const stallAfter = options.stallAfter ?? 3
  const states: TaskState[] = tasks.map((task) => ({ task, steps: 0 }))
  let unproductiveRounds = 0
  let iterations = 0

  const announce = (event: RunEventPayload): void => {
    options.emit?.(event)
  }
  // 包成函数：中止信号可能在 await 期间被置位，不能被 TS 的控制流收窄缓存住
  const isAborted = (): boolean => options.signal?.aborted === true

  for (iterations = 1; iterations <= options.globalLimit; iterations += 1) {
    if (isAborted()) {
      return finish('limits', iterations, states, board, '运行已取消')
    }

    const pending = states.filter((state) => !state.task.isSatisfied(board))
    if (pending.length === 0) {
      for (const state of states) {
        board.record(state.task.name, 'satisfied', state.task.explain(board))
        announce({ type: 'task:state', task: state.task.name, satisfied: true, reason: state.task.explain(board) })
      }
      return finish('converged', iterations, states, board, '所有任务的条件都已满足')
    }

    // 已经用尽护栏的任务不再尝试，但要如实记下它没满足
    const runnable = pending.filter((state) => state.steps < state.task.safetyLimit)
    if (runnable.length === 0) {
      for (const state of pending) {
        board.record(state.task.name, 'exhausted', `达到安全护栏 ${state.task.safetyLimit} 步仍未满足条件`)
        announce({
          type: 'task:state',
          task: state.task.name,
          satisfied: false,
          reason: `达到安全护栏 ${state.task.safetyLimit} 步仍未满足条件`,
        })
      }
      return finish('limits', iterations, states, board, '所有未满足的任务都撞上了安全护栏')
    }

    const revisionBefore = board.revision
    for (const state of runnable) {
      if (isAborted()) break
      state.steps += 1
      await state.task.step(board, ctx, options.signal)
      announce({
        type: 'task:step',
        task: state.task.name,
        step: state.steps,
        message: state.task.explain(board),
      })
    }

    if (board.revision === revisionBefore) {
      unproductiveRounds += 1
      if (unproductiveRounds >= stallAfter) {
        board.record('runner', 'stall', `连续 ${stallAfter} 轮黑板没有任何变化`)
        return finish('stalled', iterations, states, board, `连续 ${stallAfter} 轮没有任何进展`)
      }
    } else {
      unproductiveRounds = 0
    }
  }

  return finish('limits', iterations - 1, states, board, `达到全局迭代上限 ${options.globalLimit}`)
}

/** 汇总收尾信息。 */
function finish(
  status: RunOutcome['status'],
  iterations: number,
  states: readonly TaskState[],
  board: BlackboardView,
  message: string,
): RunOutcome {
  const unsatisfied = states
    .filter((state) => !state.task.isSatisfied(board))
    .map((state) => ({ task: state.task.name, reason: state.task.explain(board) }))

  return { status, iterations, unsatisfied, message }
}

/** 把 journal 转成可持久化 / 可回放的数组。 */
export function journalOf(board: BlackboardView): readonly Observation[] {
  return board.journal
}
