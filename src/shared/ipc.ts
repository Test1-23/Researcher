/**
 * 主进程 ↔ 渲染进程的 IPC 契约。
 *
 * 这是两侧唯一的接口定义：主进程实现它，渲染进程消费它，双方都不需要知道对方的内部结构。
 * 渲染进程只通过 preload 暴露的窄接口访问这些能力（contextIsolation 打开、nodeIntegration 关闭）。
 */

import type {
  AppConfig,
  Artifact,
  PluginInfo,
  PluginKind,
  Report,
  RunEvent,
} from '../main/engine/types.ts'

/** 渲染进程发起的一次运行请求。 */
export interface RunRequest {
  readonly query: string
  /** 按次覆盖配置里的上限。 */
  readonly maxSources?: number
  readonly maxFetch?: number
}

/** run 启动后的回执：真正的进度与 runId 通过 run:event 推送。 */
export interface RunStarted {
  readonly accepted: boolean
}

/** run 列表里的一条摘要。 */
export interface RunSummary {
  readonly runId: string
  readonly query: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly status: 'done' | 'incomplete'
  readonly sourceCount?: number
  readonly organize?: string
  readonly degraded?: string
}

/** 一次运行的完整内容。 */
export interface RunDetail {
  readonly runId: string
  readonly dir: string
  readonly report: Report
  readonly artifacts: readonly Artifact[]
}

/** 插件连通性探测结果。 */
export interface ProbeResult {
  readonly ok: boolean
  readonly detail: string
}

/** 应用与引擎的基本信息。 */
export interface AppInfo {
  readonly appVersion: string
  readonly engineVersion: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersion: string
  readonly platform: string
  readonly dataRoot: string
  readonly runsRoot: string
}

/** 通道名常量，避免两侧写错字符串。 */
export const IPC = {
  configGet: 'config:get',
  configSet: 'config:set',
  pluginsList: 'plugins:list',
  pluginTest: 'plugin:test',
  runStart: 'run:start',
  runCancel: 'run:cancel',
  runsList: 'runs:list',
  runGet: 'run:get',
  artifactRead: 'artifact:read',
  artifactReveal: 'artifact:reveal',
  appInfo: 'app:info',
  /** 主 → 渲染的单向推送。 */
  runEvent: 'run:event',
} as const

/** preload 挂到 `window.researcher` 上的接口。 */
export interface ResearcherApi {
  getConfig(): Promise<AppConfig>
  setConfig(config: AppConfig): Promise<AppConfig>
  listPlugins(): Promise<readonly PluginInfo[]>
  /** 会真的发一次请求，界面必须提示用户这一点。 */
  testPlugin(kind: PluginKind, id: string): Promise<ProbeResult>
  startRun(request: RunRequest): Promise<RunStarted>
  cancelRun(): Promise<boolean>
  listRuns(): Promise<readonly RunSummary[]>
  getRun(runId: string): Promise<RunDetail | null>
  readArtifact(runId: string, path: string): Promise<string>
  revealArtifact(runId: string, path: string): Promise<void>
  appInfo(): Promise<AppInfo>
  /** 订阅运行事件，返回取消订阅函数。 */
  onRunEvent(listener: (event: RunEvent) => void): () => void
}
