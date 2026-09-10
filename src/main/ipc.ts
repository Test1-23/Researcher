/**
 * 主进程侧的 IPC 实现。
 *
 * 所有 handler 都在这里注册，并且**永远不把原始堆栈抛给渲染进程**：
 * 统一转成带 code 的可读消息，界面据此给出可操作提示。
 */

import { ipcMain, shell, type BrowserWindow } from 'electron'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ENGINE_VERSION, assertValidConfig, redactSecrets, saveConfig, secretSourceOf, envNameOf, DEFAULT_CONFIG } from './engine/config.ts'
import type { SecretCodec } from './engine/config.ts'
import { FileRunStore } from './engine/run-store.ts'
import { ResearcherError, toResearcherError } from './engine/errors.ts'
import { SimpleEventBus } from './engine/events.ts'
import { FileTopicStore } from './engine/agent/topic-store.ts'
import type { Kernel } from './engine/kernel.ts'
import type { AppConfig, PluginKind, Report, RunEvent } from './engine/types.ts'
import type { SecretStorage } from './secrets.ts'
import {
  IPC,
  type AppInfo,
  type ConfigSnapshot,
  type ConfigUpdate,
  type ProbeResult,
  type RunDetail,
  type RunRequest,
  type RunSummary,
  type SecretStatus,
  type TopicSummary,
} from '../shared/ipc.ts'

/** 配置密钥时使用的默认环境变量名。 */
const DEFAULT_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 注册 IPC 所需的依赖。 */
export interface IpcContext {
  readonly kernel: Kernel
  readonly dataRoot: string
  readonly getWindow: () => BrowserWindow | null
  readonly applyConfig: (config: AppConfig) => void
  readonly appInfo: Omit<AppInfo, 'engineVersion' | 'dataRoot' | 'runsRoot'>
  /** 当前平台的密钥存储能力。 */
  readonly secretStorage: SecretStorage
}

/** 当前正在运行的 run（同一时刻只允许一个）。 */
interface ActiveRun {
  readonly controller: AbortController
}

/** 注册全部 IPC handler。 */
export function registerIpc(context: IpcContext): void {
  const { kernel, dataRoot, getWindow, applyConfig } = context
  let active: ActiveRun | null = null

  /** 把一个事件推给渲染进程；同时负责在终止事件后清理运行状态。 */
  const forward = (event: RunEvent): void => {
    const window = getWindow()
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(IPC.runEvent, event)
    }
    if (event.type === 'run:done' || event.type === 'run:error') active = null
  }

  handle(IPC.configGet, async (): Promise<ConfigSnapshot> => snapshotOf(kernel.currentConfig, context.secretStorage))

  handle(IPC.configSet, async (_event, update: ConfigUpdate): Promise<ConfigSnapshot> => {
    const storage = context.secretStorage
    // 以内存中的配置（含已解密的密钥）为基准合并，界面提交的 config 里没有密钥材料。
    const merged = mergeSecretUpdates(kernel.currentConfig, update, storage)

    // 先校验再落盘：写坏配置会让应用下次启动直接失败。
    assertValidConfig(merged)
    await saveConfig(dataRoot, merged, storage.codec)
    // 内核自己更新，不依赖调用方记得接线——否则磁盘上是新配置、内核还是旧配置。
    kernel.setConfig(merged)
    applyConfig(merged)
    return snapshotOf(merged, storage)
  })

  handle(IPC.pluginsList, async () => kernel.pluginInfos())

  handle(IPC.pluginTest, async (_event, kind: PluginKind, id: string): Promise<ProbeResult> => {
    if (kind !== 'search' && kind !== 'provider') {
      return { ok: false, detail: '只有搜索与大模型插件支持连通性测试' }
    }
    try {
      return { ok: true, detail: await kernel.probe(kind, id) }
    } catch (error) {
      return { ok: false, detail: toResearcherError(error).message }
    }
  })

  handle(IPC.runStart, async (_event, request: RunRequest) => {
    if (active !== null) {
      throw new ResearcherError('已有一次运行在进行中，请先取消或等待它结束', 'INVALID_INPUT')
    }
    const query = request.query.trim()
    if (query.length === 0) {
      throw new ResearcherError('请先输入要研究的问题', 'INVALID_INPUT')
    }

    const controller = new AbortController()
    active = { controller }

    // 每次运行用独立的事件总线，并立刻转发给界面。
    // 不 await 运行本身：立即把控制权交回界面，进度靠事件推送。
    const bus = new SimpleEventBus()
    const unsubscribe = bus.on(forward)
    void kernel
      .run(
        {
          query,
          ...(request.maxSources === undefined ? {} : { maxSources: request.maxSources }),
          ...(request.maxFetch === undefined ? {} : { maxFetch: request.maxFetch }),
        },
        bus,
        controller.signal,
      )
      .catch(() => {
        // 失败已通过 run:error 事件上报；这里只确保状态一定被清掉
        active = null
      })
      .finally(unsubscribe)

    return { accepted: true }
  })

  handle(IPC.runCancel, async () => {
    if (active === null) return false
    active.controller.abort(new Error('用户取消了运行'))
    return true
  })

  handle(IPC.runsList, async (): Promise<readonly RunSummary[]> => summariseRuns(dataRoot))

  handle(IPC.topicsList, async (): Promise<readonly TopicSummary[]> => {
    // 话题缓存损坏不该让界面报错：仓库自己会跳过读不出来的条目
    return await new FileTopicStore(join(dataRoot, 'topics')).list()
  })

  handle(IPC.runGet, async (_event, runId: string): Promise<RunDetail | null> => {
    const dir = safeRunDir(dataRoot, runId)
    let report: Report
    try {
      report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as Report
    } catch {
      return null
    }
    return { runId, dir, report, artifacts: await new FileRunStore(dir).list() }
  })

  handle(IPC.artifactRead, async (_event, runId: string, path: string): Promise<string> => {
    const absolute = await resolveArtifact(dataRoot, runId, path)
    const content = await readFile(absolute, 'utf8')
    // 预览用：超大产物截断，避免把界面卡死
    return content.length > 400_000 ? `${content.slice(0, 400_000)}\n\n…（已截断预览）` : content
  })

  handle(IPC.artifactReveal, async (_event, runId: string, path?: string) => {
    const dir = safeRunDir(dataRoot, runId)
    if (path === undefined) {
      shell.showItemInFolder(join(dir, 'report.md'))
      return
    }
    shell.showItemInFolder(await resolveArtifact(dataRoot, runId, path))
  })

  handle(IPC.appInfo, async (): Promise<AppInfo> => ({
    ...context.appInfo,
    engineVersion: ENGINE_VERSION,
    dataRoot,
    runsRoot: kernel.runsRoot,
  }))
}

/** 统一包一层：把引擎错误转成可读消息，不向渲染进程泄漏堆栈。 */
function handle<Args extends unknown[], Result>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...(args as Args))
    } catch (error) {
      const normalized = toResearcherError(error)
      throw new Error(`${normalized.code}: ${normalized.message}`)
    }
  })
}

/** 构造下发给渲染进程的快照：配置里的密钥材料被全部抹掉。 */
function snapshotOf(config: AppConfig, storage: SecretStorage): ConfigSnapshot {
  const secrets: Record<string, SecretStatus> = {}
  for (const [pluginId, section] of Object.entries(config.plugins)) {
    secrets[pluginId] = {
      source: secretSourceOf(section, DEFAULT_KEY_ENV),
      envName: envNameOf(section, DEFAULT_KEY_ENV),
    }
  }
  return {
    config: redactSecrets(config),
    secrets,
    storage: {
      canPersist: storage.canPersist,
      plaintext: storage.plaintext,
      ...(storage.reason === undefined ? {} : { reason: storage.reason }),
    },
  }
}

/**
 * 把界面提交的配置与密钥更新合并到内存配置上。
 *
 * 界面拿不到密钥，因此「没提到某个插件」必须解释为**保持原样**，
 * 否则每次改个 model 都会把已保存的密钥抹掉。
 */
function mergeSecretUpdates(current: AppConfig, update: ConfigUpdate, storage: SecretStorage): AppConfig {
  const incoming = update.config ?? DEFAULT_CONFIG
  const requested = update.secrets ?? {}
  const plugins: Record<string, Record<string, unknown>> = {}
  // 内存中的存储标记必须和 encodeSecrets 落盘时写的一致，
  // 否则界面会把「已加密保存」错报成「明文保存」。
  const storageLabel = storage.codec.kind === 'safeStorage' ? 'safeStorage' : 'plaintext'

  // 以界面提交的结构为准（它改的是 baseUrl/model 这些非敏感项）
  for (const [pluginId, section] of Object.entries(incoming.plugins)) {
    const next: Record<string, unknown> = { ...section }
    // 界面提交的密钥字段一律不可信，先丢弃
    delete next['apiKey']
    delete next['apiKeyEncrypted']
    delete next['apiKeyStorage']

    const existing = current.plugins[pluginId]?.['apiKey']
    const hasExisting = typeof existing === 'string' && existing.length > 0

    let desired: string | null | undefined
    if (Object.prototype.hasOwnProperty.call(requested, pluginId)) {
      desired = requested[pluginId]
    }

    if (desired === null) {
      // 显式清除
    } else if (typeof desired === 'string' && desired.trim().length > 0) {
      if (!storage.canPersist) {
        throw new ResearcherError(
          `无法保存 API key：${storage.reason ?? '当前平台不支持安全的密钥存储'}`,
          'CONFIG_INVALID',
        )
      }
      next['apiKey'] = desired.trim()
      next['apiKeyStorage'] = storageLabel
    } else if (hasExisting) {
      // 未提及 → 保持原有密钥
      next['apiKey'] = existing
      const previousLabel = current.plugins[pluginId]?.['apiKeyStorage']
      next['apiKeyStorage'] = typeof previousLabel === 'string' ? previousLabel : storageLabel
    }

    plugins[pluginId] = next
  }

  return { ...incoming, plugins }
}

/** 只允许访问 runs 根目录下的直接子目录，防止 `../` 越界。 */
function safeRunDir(dataRoot: string, runId: string): string {  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
    throw new ResearcherError(`非法的 run id：${String(runId)}`, 'INVALID_INPUT')
  }
  return join(dataRoot, 'runs', runId)
}

/**
 * 把产物相对路径解析成绝对路径。
 *
 * 先用 run 仓库的真实产物清单做白名单校验，再拼路径——这样即使传进来
 * `../../etc/passwd` 之类的值，也会在读取之前就被拒绝。
 */
async function resolveArtifact(dataRoot: string, runId: string, path: string): Promise<string> {
  const dir = safeRunDir(dataRoot, runId)
  const artifacts = await new FileRunStore(dir).list()
  if (!artifacts.some((artifact) => artifact.path === path)) {
    throw new ResearcherError(`产物不存在：${path}`, 'INVALID_INPUT')
  }
  const absolute = resolve(dir, path)
  if (!absolute.startsWith(dir + sep)) {
    throw new ResearcherError('非法的产物路径', 'INVALID_INPUT')
  }
  return absolute
}

/** 扫描 runs 目录，按时间倒序给出摘要。 */
async function summariseRuns(dataRoot: string): Promise<readonly RunSummary[]> {
  const runsRoot = join(dataRoot, 'runs')
  let entries: string[]
  try {
    entries = await readdir(runsRoot)
  } catch {
    return []
  }

  const summaries: RunSummary[] = []
  for (const runId of entries) {
    const dir = join(runsRoot, runId)
    try {
      const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as Report
      summaries.push({
        runId,
        query: report.query,
        startedAt: report.startedAt,
        finishedAt: report.finishedAt,
        durationMs: report.durationMs,
        status: 'done',
        sourceCount: report.sources.length,
        organize: report.provenance.organize,
        ...(report.provenance.degraded === undefined ? {} : { degraded: report.provenance.degraded }),
      })
    } catch {
      // 没有 report.json 说明这次运行中途失败或被中断：如实标为未完成，而不是假装成功
      summaries.push({ runId, query: '（未完成）', startedAt: runId, status: 'incomplete' })
    }
  }

  return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}
