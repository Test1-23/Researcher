/**
 * Electron 主进程入口。
 *
 * 职责很窄：建窗口、装配内核、注册 IPC。
 * 引擎（内核 + 插件）完全不知道 Electron 的存在，因此同一套引擎将来也能被 CLI 复用。
 */

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { loadConfigResilient, saveConfig } from './engine/config.ts'
import { Kernel } from './engine/kernel.ts'
import { createRegistry } from '../plugins/index.ts'
import { registerIpc } from './ipc.ts'
import type { AppConfig } from './engine/types.ts'

/** 数据根目录：配置与 runs 都放这里，卸载应用时可一并清理。 */
const dataRoot = join(app.getPath('userData'), 'researcher')

let mainWindow: BrowserWindow | null = null

/** 建主窗口。 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#f6f7f9',
    title: 'Researcher',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // 渲染进程只通过 preload 暴露的窄接口访问主进程，不给它 Node 能力。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 首帧渲染完成后再显示，避免白屏闪烁
  window.once('ready-to-show', () => window.show())

  // 外部链接交给系统浏览器，绝不在应用窗口里打开
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** 装配内核：读配置（容错）→ 建注册表 → 建内核。 */
async function bootstrap(): Promise<Kernel> {
  const { config, warning } = await loadConfigResilient(dataRoot)
  if (warning !== undefined) {
    console.warn(`[config] ${warning}`)
  }

  let current: AppConfig = config
  const kernel = new Kernel({
    registry: createRegistry(),
    config: current,
    dataRoot,
    mirrorLogsToConsole: true,
  })

  registerIpc({
    kernel,
    dataRoot,
    getWindow: () => mainWindow,
    // 内核的更新由 IPC handler 自己完成；这里只记录当前配置，供启动告警回写使用。
    applyConfig: (next) => {
      current = next
    },
    appInfo: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      nodeVersion: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
    },
  })

  // 配置损坏时把回退后的缺省配置写回磁盘，让用户看到一份可编辑的文件
  if (warning !== undefined) {
    await saveConfig(dataRoot, current).catch(() => {
      /* 写回失败不影响使用 */
    })
  }

  return kernel
}

void app.whenReady().then(async () => {
  await bootstrap()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
