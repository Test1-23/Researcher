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

/** 某个插件当前密钥来自哪里。密钥本身永远不下发。 */
export type SecretSource = 'none' | 'env' | 'encrypted' | 'plaintext' | 'undecryptable'

/** 某个插件的密钥状态。 */
export interface SecretStatus {
  readonly source: SecretSource
  /** 该插件使用的环境变量名，供界面提示用。 */
  readonly envName: string
}

/** 密钥存储的整体能力，决定界面是否允许填写密钥。 */
export interface SecretStorageInfo {
  /** 是否可以写入配置文件。false 时界面应引导使用环境变量。 */
  readonly canPersist: boolean
  /** 是否会以明文持久化（界面需持续警告）。 */
  readonly plaintext: boolean
  /** 不能加密时的原因。 */
  readonly reason?: string
}

/**
 * 下发给渲染进程的配置快照。
 *
 * `config` 里的密钥字段已被抹掉——明文与密文都不出主进程。
 * 密钥是否存在、来自哪里，只通过 `secrets` 这个枚举告诉界面。
 */
export interface ConfigSnapshot {
  readonly config: AppConfig
  readonly secrets: Readonly<Record<string, SecretStatus>>
  readonly storage: SecretStorageInfo
}

/**
 * 渲染进程提交的配置更新。
 *
 * `config` 里的 `apiKey` 字段会被忽略（界面根本拿不到它）；
 * 密钥的增删改只能通过 `secrets`：
 *   · 非空字符串 —— 设为该值
 *   · `null`     —— 清除
 *   · 键缺省     —— 保持不变
 */
export interface ConfigUpdate {
  readonly config: AppConfig
  readonly secrets?: Readonly<Record<string, string | null>>
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
  getConfig(): Promise<ConfigSnapshot>
  /** 提交配置与密钥变更；返回更新后的快照。 */
  setConfig(update: ConfigUpdate): Promise<ConfigSnapshot>
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
