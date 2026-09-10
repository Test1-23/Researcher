/**
 * preload：渲染进程访问主进程的唯一通道。
 *
 * 只暴露一组窄接口（不是 ipcRenderer 本身），因此在 sandbox 打开、contextIsolation 打开的前提下，
 * 渲染进程无法调用未列出的通道，也拿不到 Node 能力。
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppInfo,
  type ConfigSnapshot,
  type ConfigUpdate,
  type ProbeResult,
  type ResearcherApi,
  type RunDetail,
  type RunRequest,
  type RunSummary,
  type RunStarted,
  type TopicSummary,
} from '../shared/ipc.ts'
import type { PluginInfo, PluginKind, RunEvent } from '../main/engine/types.ts'

const api: ResearcherApi = {
  getConfig: () => ipcRenderer.invoke(IPC.configGet) as Promise<ConfigSnapshot>,
  setConfig: (update: ConfigUpdate) => ipcRenderer.invoke(IPC.configSet, update) as Promise<ConfigSnapshot>,
  listPlugins: () => ipcRenderer.invoke(IPC.pluginsList) as Promise<readonly PluginInfo[]>,
  testPlugin: (kind: PluginKind, id: string) =>
    ipcRenderer.invoke(IPC.pluginTest, kind, id) as Promise<ProbeResult>,
  startRun: (request: RunRequest) => ipcRenderer.invoke(IPC.runStart, request) as Promise<RunStarted>,
  cancelRun: () => ipcRenderer.invoke(IPC.runCancel) as Promise<boolean>,
  listRuns: () => ipcRenderer.invoke(IPC.runsList) as Promise<readonly RunSummary[]>,
  listTopics: () => ipcRenderer.invoke(IPC.topicsList) as Promise<readonly TopicSummary[]>,
  getRun: (runId: string) => ipcRenderer.invoke(IPC.runGet, runId) as Promise<RunDetail | null>,
  readArtifact: (runId: string, path: string) =>
    ipcRenderer.invoke(IPC.artifactRead, runId, path) as Promise<string>,
  revealArtifact: (runId: string, path?: string) =>
    ipcRenderer.invoke(IPC.artifactReveal, runId, path) as Promise<void>,
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  onRunEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RunEvent): void => listener(payload)
    ipcRenderer.on(IPC.runEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC.runEvent, handler)
    }
  },
}

contextBridge.exposeInMainWorld('researcher', api)
