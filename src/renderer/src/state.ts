/**
 * 运行进度状态：把内核推来的事件流折叠成界面需要的形状。
 *
 * 做成纯 reducer，是因为「事件 → 界面状态」是最容易出错的一环，独立出来才好测、好读。
 */

import type { Artifact, Report, RunEvent, SearchSource } from '../../main/engine/types.ts'

/** 一个阶段的进度。 */
export interface StageProgress {
  readonly stage: string
  readonly status: 'running' | 'done'
  readonly summary?: string
  readonly startedAt: string
  readonly finishedAt?: string
}

/** 一个来源的抓取结果。 */
export interface FetchProgress {
  readonly url: string
  readonly ok: boolean
  readonly status: number
  readonly bytes: number
}

/** 一条日志。 */
export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly at: string
}

/** 一次运行的完整界面状态。 */
export interface RunProgress {
  readonly runId: string | null
  readonly status: 'idle' | 'running' | 'done' | 'error'
  readonly stages: readonly StageProgress[]
  readonly sources: readonly SearchSource[]
  readonly fetches: readonly FetchProgress[]
  readonly logs: readonly LogLine[]
  readonly report?: Report
  readonly artifacts: readonly Artifact[]
  readonly error?: { readonly code: string; readonly message: string }
}

/** 初始状态。 */
export const IDLE_PROGRESS: RunProgress = {
  runId: null,
  status: 'idle',
  stages: [],
  sources: [],
  fetches: [],
  logs: [],
  artifacts: [],
}

/** 阶段 id → 中文名。 */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  search: '搜索来源',
  fetch: '抓取正文',
  organize: '整理成稿',
  output: '写出报告',
}

/** 阶段显示名。 */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

/** 日志上限：长时间运行也不能让内存无限增长。 */
const MAX_LOGS = 300

/** 把一个事件折叠进状态。 */
export function reduceRunEvent(state: RunProgress, event: RunEvent): RunProgress {
  switch (event.type) {
    case 'run:start':
      // 新运行开始：整体重置，避免上一轮的来源/日志串台
      return { ...IDLE_PROGRESS, runId: event.runId, status: 'running' }

    case 'stage:start':
      return {
        ...state,
        stages: [
          ...state.stages.filter((item) => item.stage !== event.stage),
          { stage: event.stage, status: 'running', startedAt: event.at },
        ],
      }

    case 'stage:done':
      return {
        ...state,
        stages: state.stages.map((item) =>
          item.stage === event.stage
            ? { ...item, status: 'done' as const, summary: event.summary, finishedAt: event.at }
            : item,
        ),
      }

    case 'source:found':
      return { ...state, sources: [...state.sources, event.source] }

    case 'fetch:done':
      return {
        ...state,
        fetches: [...state.fetches.filter((item) => item.url !== event.url), {
          url: event.url,
          ok: event.ok,
          status: event.status,
          bytes: event.bytes,
        }],
      }

    case 'log':
      return {
        ...state,
        logs: [...state.logs, { level: event.level, message: event.message, at: event.at }].slice(-MAX_LOGS),
      }

    case 'run:done':
      return { ...state, status: 'done', report: event.report, artifacts: [...event.artifacts] }

    case 'run:error':
      return { ...state, status: 'error', error: { code: event.code, message: event.message } }
  }
}
