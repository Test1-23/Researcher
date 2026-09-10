/**
 * 界面冒烟测试：启动打包后的 Electron 应用，通过 DevTools 协议读取真实 DOM。
 *
 * 存在的意义：类型检查、构建和引擎测试都无法证明「窗口里真的有内容」。
 * 这个脚本会启动应用、等界面真正渲染出来、取回关键节点并验证 IPC 往返，然后关掉应用。
 *
 * 用法：node --no-warnings scripts/smoke-ui.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import electronPath from 'electron'

/** 用一个随机端口，避免上一次运行留下的 TIME_WAIT 干扰。 */
const PORT = 9300 + Math.floor(Math.random() * 400)
const READY_TIMEOUT_MS = 30_000

/** 界面就绪的判定条件：React 已挂载并渲染出顶栏。 */
const READY_EXPRESSION = `document.querySelector('.brand-name') !== null`

/** 一个页面目标。 */
interface PageTarget {
  readonly type: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
}

/** 与页面之间保持一条 DevTools 连接，便于反复求值。 */
class DevtoolsClient {
  private readonly socket: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event: MessageEvent) => {
      const payload = JSON.parse(String(event.data)) as {
        id?: number
        result?: { result?: { value?: unknown }; exceptionDetails?: unknown }
      }
      if (payload.id === undefined) return
      const entry = this.pending.get(payload.id)
      if (entry === undefined) return
      this.pending.delete(payload.id)
      if (payload.result?.exceptionDetails !== undefined) {
        entry.reject(new Error(`页面内求值抛错：${JSON.stringify(payload.result.exceptionDetails)}`))
        return
      }
      entry.resolve(payload.result?.result?.value)
    })
  }

  /** 建立连接。 */
  static async connect(url: string): Promise<DevtoolsClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools WebSocket 连接超时')), 10_000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('DevTools WebSocket 连接失败'))
      })
    })
    return new DevtoolsClient(socket)
  }

  /** 在页面里求值。 */
  async evaluate(expression: string): Promise<unknown> {
    const id = this.nextId
    this.nextId += 1
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('DevTools 求值超时'))
      }, 15_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

/** 启动 Electron（加载构建产物，不是 dev server）。 */
function launch(): ChildProcess {
  const child = spawn(String(electronPath), ['.', `--remote-debugging-port=${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    // Electron/Chromium 噪声很多，只报告看起来像错误的行
    for (const line of chunk.toString().split('\n')) {
      if (/error|failed|cannot|unable/i.test(line) && !/DevTools listening|Autofill|GPU|dbus|Vulkan|gpu_/i.test(line)) {
        console.error(`[electron] ${line.trim()}`)
      }
    }
  })
  return child
}

/** 等目标页面出现。 */
async function waitForPage(): Promise<PageTarget> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json() as PageTarget[]
      const page = targets.find(
        (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
      )
      if (page !== undefined) return page
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`等待界面超时（${READY_TIMEOUT_MS}ms 内没有出现页面目标）`)
}

/** 轮询到界面真正渲染完成，而不是死等一个固定时长。 */
async function waitForReady(client: DevtoolsClient): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await client.evaluate(READY_EXPRESSION) === true) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('界面在超时前没有渲染出顶栏')
}

/** 冒烟测试用的密钥：明显是假的，且用完即清。 */
const SMOKE_KEY = 'sk-smoke-test-key-must-never-touch-disk-0123456789'

/**
 * 验证密钥真的被加密落盘。
 *
 * 这是唯一能验证真实 safeStorage（Windows DPAPI）的地方——单元测试只能覆盖假的编解码器。
 * 测试会先备份用户的 config.json，结束后按字节还原，绝不覆盖用户已保存的密钥。
 *
 * @returns 发现的问题列表（空数组表示通过）
 */
async function verifyKeyEncryption(client: DevtoolsClient, dataRoot: string): Promise<string[]> {
  const configPath = join(dataRoot, 'config.json')
  const previous = await readFile(configPath, 'utf8').catch(() => undefined)

  try {
    const capability = JSON.parse(String(await client.evaluate(
      'window.researcher.getConfig().then(s => JSON.stringify(s.storage))',
    ))) as { canPersist: boolean; plaintext: boolean; reason?: string }

    if (!capability.canPersist) {
      // 平台没有可用密钥库（例如无 keyring 的 Linux）：这里无法验证，如实跳过
      console.log(`  密钥加密      跳过（平台不支持：${capability.reason ?? '未知原因'}）`)
      return []
    }

    const result = JSON.parse(String(await client.evaluate(`(async () => {
      const snap = await window.researcher.getConfig();
      const next = await window.researcher.setConfig({
        config: snap.config,
        secrets: { 'provider-openai': ${JSON.stringify(SMOKE_KEY)} },
      });
      return JSON.stringify({ source: next.secrets['provider-openai'].source });
    })()`))) as { source: string }

    const onDisk = await readFile(configPath, 'utf8').catch(() => '')
    const leaksPlaintext = onDisk.includes(SMOKE_KEY)
    const hasCiphertext = onDisk.includes('apiKeyEncrypted')

    console.log(`  密钥加密      ${result.source} · 磁盘含密文 ${hasCiphertext ? '是' : '否'} · 磁盘含明文 ${leaksPlaintext ? '是' : '否'}`)

    const found: string[] = []
    if (result.source !== 'encrypted') found.push(`密钥状态应为 encrypted，实际为 ${result.source}`)
    if (leaksPlaintext) found.push('明文密钥出现在了磁盘上的 config.json 里')
    if (!hasCiphertext) found.push('config.json 里没有找到 apiKeyEncrypted 字段')
    return found
  } finally {
    // 按字节还原用户原本的配置；原本没有就删掉
    if (previous === undefined) await rm(configPath, { force: true })
    else await writeFile(configPath, previous, 'utf8')
  }
}

const app = launch()
let exitCode = 0
let client: DevtoolsClient | undefined

try {
  const page = await waitForPage()
  console.log(`✓ 窗口已加载：${page.url}`)

  client = await DevtoolsClient.connect(page.webSocketDebuggerUrl as string)
  await waitForReady(client)

  const report = await client.evaluate(`(() => ({
    title: document.title,
    hasBridge: typeof window.researcher === 'object',
    topbar: document.querySelector('.brand-name')?.textContent ?? null,
    panelTitles: [...document.querySelectorAll('.panel-title')].map(e => e.textContent.trim()),
    tabs: [...document.querySelectorAll('.tab')].map(e => e.textContent.trim()),
    emptyState: document.querySelector('.empty h2')?.textContent ?? null,
    buttons: [...document.querySelectorAll('button')].map(e => e.textContent.trim()).filter(Boolean),
    bodyLength: document.body.innerText.length,
    bridgeMissing: document.querySelector('.bridge-missing') !== null,
  }))()`) as Record<string, unknown>

  console.log('')
  console.log('界面内容：')
  console.log(`  页面标题      ${String(report['title'])}`)
  console.log(`  preload 桥    ${report['hasBridge'] === true ? '已注入' : '缺失'}`)
  console.log(`  应用名        ${String(report['topbar'])}`)
  console.log(`  侧栏面板      ${JSON.stringify(report['panelTitles'])}`)
  console.log(`  标签页        ${JSON.stringify(report['tabs'])}`)
  console.log(`  空状态        ${String(report['emptyState'])}`)
  console.log(`  按钮          ${JSON.stringify(report['buttons'])}`)
  console.log(`  可见文本长度  ${String(report['bodyLength'])}`)

  const problems: string[] = []
  if (report['hasBridge'] !== true) problems.push('preload 桥未注入')
  if (report['bridgeMissing'] === true) problems.push('界面落到了「需要通过桌面应用启动」提示页')
  if (String(report['topbar']) !== 'Researcher') problems.push('顶栏没有渲染')
  if (Number(report['bodyLength']) < 100) problems.push('界面可见文本过少，可能没有渲染')

  // IPC 往返：真实调用主进程，而不是只看 DOM
  const info = JSON.parse(String(await client.evaluate(
    'window.researcher.appInfo().then(i => JSON.stringify(i))',
  ))) as Record<string, unknown>
  console.log(`  IPC appInfo   引擎 ${String(info['engineVersion'])} · ${String(info['platform'])}`)
  if (typeof info['engineVersion'] !== 'string') problems.push('appInfo IPC 往返失败')

  const pluginCount = Number(await client.evaluate('window.researcher.listPlugins().then(p => String(p.length))'))
  console.log(`  IPC 插件数    ${pluginCount}`)
  if (pluginCount < 9) problems.push('插件列表 IPC 返回数量异常')

  const runsCount = Number(await client.evaluate('window.researcher.listRuns().then(r => String(r.length))'))
  console.log(`  IPC 历史运行  ${runsCount}`)
  if (!Number.isFinite(runsCount)) problems.push('runs:list IPC 失败')

  const topicCount = Number(await client.evaluate('window.researcher.listTopics().then(t => String(t.length))'))
  console.log(`  IPC 话题缓存  ${topicCount}`)
  if (!Number.isFinite(topicCount)) problems.push('topics:list IPC 失败')

  // ── 真实 safeStorage 加密：只有在真窗口里才能验证 ──
  problems.push(...(await verifyKeyEncryption(client, String(info['dataRoot']))))

  console.log('')
  if (problems.length > 0) {
    console.error(`✗ 界面冒烟测试失败：${problems.join('；')}`)
    exitCode = 1
  } else {
    console.log('✓ 界面冒烟测试通过')
  }
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  client?.close()
  app.kill()
  // 等子进程真正退出后再让 Node 自然结束：直接 process.exit() 会在 libuv
  // 还有句柄要关闭时触发断言崩溃，那样测试通过也会返回非零退出码。
  await new Promise<void>((resolve) => {
    if (app.exitCode !== null || app.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, 5000)
    app.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

process.exitCode = exitCode
