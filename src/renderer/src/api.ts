/**
 * 渲染进程访问主进程的唯一入口。
 *
 * 所有跨进程调用都收敛在这里，组件不直接碰 window.researcher，
 * 这样 IPC 契约变化时只需要改这一个文件。
 */

import type { ResearcherApi } from '../../shared/ipc.ts'

declare global {
  interface Window {
    readonly researcher?: ResearcherApi
  }
}

/** preload 注入的接口；不在 Electron 里时为 undefined。 */
export const api: ResearcherApi | undefined = window.researcher

/** 取出接口，缺失时抛出可读错误。 */
export function requireApi(): ResearcherApi {
  if (api === undefined) {
    throw new Error('未检测到 Electron 预加载接口，请通过 pnpm dev 启动桌面应用')
  }
  return api
}

/** 把 IPC 抛出的 `CODE: message` 拆成结构化错误，便于界面分类提示。 */
export function parseIpcError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z_]+): ([\s\S]*)$/.exec(raw)
  if (match !== null) return { code: match[1] as string, message: match[2] as string }
  return { code: 'UNKNOWN', message: raw }
}
