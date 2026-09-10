/**
 * 主进程侧的 IPC 实现。
 *
 * 所有 handler 都在这里注册，并且**永远不把原始堆栈抛给渲染进程**：
 * 统一转成带 code 的可读消息，界面据此给出可操作提示。
 */

import { ipcMain, shell, type BrowserWindow } from 'electron'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { ENGINE_VERSION, assertValidConfig, saveConfig } from './engine/config.ts'
import { FileRunStore } from './engine/run-store.ts'
import { ResearcherError, toResearcherError } from './engine/errors.ts'
import { SimpleEventBus } from './engine/events.ts'
import type { Kernel } from './engine/kernel.ts'
import type { AppConfig, PluginKind, Report, RunEvent } from './engine/types.ts'
import { IPC, type AppInfo, type ProbeResult, type RunDetail, type RunRequest, type RunSummary } from '../shared/ipc.ts'

/** 注册 IPC 所需的依赖。 */
export interface IpcContext {
  readonly kernel: Kernel
  readonly dataRoot: string
  readonly getWindow: () => BrowserWindow | null
  readonly applyConfig: (config: AppConfig) => void
  readonly appInfo: Omit<AppInfo, 'engineVersion' | 'dataRoot' | 'runsRoot'>
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

  handle(IPC.configGet, async () => kernel.currentConfig)

  handle(IPC.configSet, async (_event, config: AppConfig) => {
    // 先校验再落盘：写坏配置会让应用下次启动直接失败。
    assertValidConfig(config)
    await saveConfig(dataRoot, config)
    // 内核自己更新，不依赖调用方记得接线——否则磁盘上是新配置、内核还是旧配置。
    kernel.setConfig(config)
    applyConfig(config)
    return kernel.currentConfig
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

/** 只允许访问 runs 根目录下的直接子目录，防止 `../` 越界。 */
function safeRunDir(dataRoot: string, runId: string): string {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
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
