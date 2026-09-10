/**
 * IPC 契约测试。
 *
 * 主进程与渲染进程之间只有这一份契约，而「忘了注册某个 handler」在
 * 类型检查、构建和引擎测试里都发现不了——只有真正打开窗口才会暴露。
 * 这里用假的 electron 模块把 registerIpc 跑起来，逐个通道检查。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, deepMerge } from '../src/main/engine/config.ts'
import { Kernel } from '../src/main/engine/kernel.ts'
import { createRegistry } from '../src/plugins/index.ts'
import { IPC } from '../src/shared/ipc.ts'
import type { AppConfig } from '../src/main/engine/types.ts'

/** 假的 electron 模块：只收集注册了哪些通道。 */
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  revealed: [] as string[],
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      fake.handlers.set(channel, handler)
    },
  },
  shell: {
    showItemInFolder: (path: string) => {
      fake.revealed.push(path)
    },
  },
}))

const { registerIpc } = await import('../src/main/ipc.ts')

const roots: string[] = []

beforeEach(() => {
  fake.handlers.clear()
  fake.revealed.length = 0
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 起一个真实内核并注册 IPC。 */
async function setup(config: AppConfig = DEFAULT_CONFIG): Promise<{ dataRoot: string; kernel: Kernel }> {
  const dataRoot = await mkdtemp(join(tmpdir(), 'researcher-ipc-'))
  roots.push(dataRoot)
  const kernel = new Kernel({ registry: createRegistry(), config, dataRoot, mirrorLogsToConsole: false })
  registerIpc({
    kernel,
    dataRoot,
    getWindow: () => null,
    applyConfig: () => {},
    appInfo: {
      appVersion: '0.1.0',
      electronVersion: '33.0.0',
      chromeVersion: '130.0.0',
      nodeVersion: '22.0.0',
      platform: 'test-arch',
    },
  })
  return { dataRoot, kernel }
}

/** 调用一个已注册的 handler。 */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = fake.handlers.get(channel)
  if (handler === undefined) throw new Error(`通道未注册：${channel}`)
  return await handler(null, ...args)
}

describe('IPC 通道完整性', () => {
  it('契约里每个 invoke 通道都注册了 handler', async () => {
    await setup()
    // run:event 是主 → 渲染的单向推送，不需要 handler
    const invokeChannels = Object.entries(IPC)
      .filter(([name]) => name !== 'runEvent')
      .map(([, channel]) => channel)

    const missing = invokeChannels.filter((channel) => !fake.handlers.has(channel))
    expect(missing, `以下通道没有注册 handler：${missing.join('、')}`).toEqual([])
  })

  it('app:info 返回拼装好的信息', async () => {
    const { dataRoot } = await setup()
    const info = await invoke(IPC.appInfo) as Record<string, unknown>
    expect(info['engineVersion']).toBe('0.1.0')
    expect(info['appVersion']).toBe('0.1.0')
    expect(info['dataRoot']).toBe(dataRoot)
    expect(info['runsRoot']).toBe(join(dataRoot, 'runs'))
  })
})

describe('配置通道', () => {
  it('读取配置返回缺省值', async () => {
    await setup()
    const config = await invoke(IPC.configGet) as AppConfig
    expect(config.pipeline.id).toBe('pipeline-default')
    expect(config.search.fallback).toBe('search-duckduckgo')
  })

  it('写入非法配置被拒绝，且不会落盘', async () => {
    const { dataRoot } = await setup()
    const broken = deepMerge(DEFAULT_CONFIG, { search: { maxSources: 0 } })
    await expect(invoke(IPC.configSet, broken)).rejects.toThrowError(/CONFIG_INVALID/)
    await expect(invoke(IPC.configGet)).resolves.toEqual(DEFAULT_CONFIG)
    // 目录里不该出现配置文件
    await expect(rm(join(dataRoot, 'config.json'), { force: false })).rejects.toThrowError()
  })

  it('写入合法配置后生效', async () => {
    const { kernel } = await setup()
    const next = deepMerge(DEFAULT_CONFIG, { search: { maxSources: 3 } })
    await invoke(IPC.configSet, next)
    expect(kernel.currentConfig.search.maxSources).toBe(3)
  })
})

describe('运行通道', () => {
  it('空查询被拒绝', async () => {
    await setup()
    await expect(invoke(IPC.runStart, { query: '   ' })).rejects.toThrowError(/INVALID_INPUT/)
  })

  it('没有运行时取消返回 false', async () => {
    await setup()
    await expect(invoke(IPC.runCancel)).resolves.toBe(false)
  })

  it('没有运行记录时返回空列表', async () => {
    await setup()
    await expect(invoke(IPC.runsList)).resolves.toEqual([])
  })
})

describe('产物通道的路径校验', () => {
  it('只允许读取产物清单里的文件，越界路径被拒绝', async () => {
    const { dataRoot } = await setup()
    const runId = '2026-01-01T00-00-00-000Z-test'
    const runDir = join(dataRoot, 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'report.md'), '# 报告', 'utf8')
    // 放在 run 目录之外的文件，绝不能通过 artifact:read 读到
    await writeFile(join(dataRoot, 'secret.txt'), 'top secret', 'utf8')

    await expect(invoke(IPC.artifactRead, runId, 'report.md')).resolves.toBe('# 报告')
    await expect(invoke(IPC.artifactRead, runId, '../secret.txt')).rejects.toThrowError(/INVALID_INPUT/)
    await expect(invoke(IPC.artifactRead, runId, '不存在.md')).rejects.toThrowError(/INVALID_INPUT/)
  })

  it('拒绝越界的 run id', async () => {
    await setup()
    await expect(invoke(IPC.runGet, '..')).rejects.toThrowError(/INVALID_INPUT/)
    await expect(invoke(IPC.runGet, 'a/b')).rejects.toThrowError(/INVALID_INPUT/)
  })

  it('定位产物时把绝对路径交给系统', async () => {
    const { dataRoot } = await setup()
    const runId = '2026-01-01T00-00-00-000Z-test'
    const runDir = join(dataRoot, 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'report.md'), '# 报告', 'utf8')

    await invoke(IPC.artifactReveal, runId, 'report.md')
    expect(fake.revealed).toEqual([join(runDir, 'report.md')])
  })
})

describe('插件通道', () => {
  it('列出全部内置插件', async () => {
    await setup()
    const plugins = await invoke(IPC.pluginsList) as { id: string; kind: string }[]
    expect(plugins.map((plugin) => plugin.id)).toContain('pipeline-default')
    expect(plugins.map((plugin) => plugin.id)).toContain('search-duckduckgo')
    expect(plugins).toHaveLength(9)
  })

  it('对不支持测试的类别返回可读说明，而不是抛错', async () => {
    await setup()
    await expect(invoke(IPC.pluginTest, 'pipeline', 'pipeline-default')).resolves.toEqual({
      ok: false,
      detail: '只有搜索与大模型插件支持连通性测试',
    })
  })

  it('配置不完整时测试连接返回失败原因而不是抛错', async () => {
    const saved = process.env['DEEPSEEK_API_KEY']
    delete process.env['DEEPSEEK_API_KEY']
    try {
      await setup()
      const result = await invoke(IPC.pluginTest, 'provider', 'provider-openai') as { ok: boolean; detail: string }
      expect(result.ok).toBe(false)
      expect(result.detail).toContain('不可用')
    } finally {
      if (saved !== undefined) process.env['DEEPSEEK_API_KEY'] = saved
    }
  })
})
