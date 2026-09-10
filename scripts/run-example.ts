/**
 * 命令行示例：用真实插件跑一次完整研究。
 *
 * 这同时是对「引擎与 Electron 无关」的直接证明——同一个内核既服务桌面应用，也能在这里跑。
 *
 * 用法：
 *   node scripts/run-example.ts "你想研究的问题"                    # 走真实网络
 *   node scripts/run-example.ts --offline                          # 用录制夹具，不联网
 *   node scripts/run-example.ts "问题" --save-example               # 顺便写进 examples/
 *
 * 不传 key 时会走 DuckDuckGo + 抽取式整理（零配置可跑）；
 * 设了 DEEPSEEK_API_KEY 则走 DeepSeek 搜索 + 大模型整理。
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfigResilient, envNameOf, secretSourceOf } from '../src/main/engine/config.ts'
import { FetchError } from '../src/main/engine/errors.ts'
import { SimpleEventBus } from '../src/main/engine/events.ts'
import { extractText } from '../src/main/engine/html.ts'
import { Kernel } from '../src/main/engine/kernel.ts'
import type { FetchedDocument, FetchService, RawResponse, RunEvent } from '../src/main/engine/types.ts'
import { createRegistry } from '../src/plugins/index.ts'
import { DUCKDUCKGO_FIXTURE, DUCKDUCKGO_PAGES } from '../fixtures/duckduckgo.ts'

/**
 * 解析命令行。
 *
 * 用手写循环而不是 `args.find`：`--format md` 里的 `md` 是**选项的值**，
 * 不是位置参数；用 find 找位置参数会把它误当成查询词。
 */
function parseArgs(argv: readonly string[]): {
  readonly query: string
  readonly offline: boolean
  readonly saveExample: boolean
  readonly formats: readonly string[] | undefined
} {
  /** 常见的简写：命令行的便利，不下沉到引擎（引擎只认插件声明的 format）。 */
  const aliases: Readonly<Record<string, string>> = { md: 'markdown', htm: 'html', txt: 'markdown' }
  const parseFormats = (value: string): string[] =>
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
      .map((item) => aliases[item] ?? item)

  const positionals: string[] = []
  let offline = false
  let saveExample = false
  let formats: readonly string[] | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--offline') {
      offline = true
      continue
    }
    if (arg === '--save-example') {
      saveExample = true
      continue
    }
    if (arg.startsWith('--format=')) {
      formats = parseFormats(arg.slice('--format='.length))
      continue
    }
    if (arg === '--format') {
      formats = parseFormats(argv[index + 1] ?? '')
      index += 1
      continue
    }
    if (arg.startsWith('--')) continue
    positionals.push(arg)
  }

  return {
    query: positionals[0] ?? '演示：Alpha 与 Beta 是什么关系',
    offline,
    saveExample,
    formats,
  }
}

const { query, offline, saveExample, formats } = parseArgs(process.argv.slice(2))

/** 只读录制夹具的抓取服务：让整条 pipeline 在无网络环境里也能跑完。 */
function offlineFetch(): FetchService {
  const fetchRaw = async (url: string): Promise<RawResponse> => {
    const body = url.startsWith('https://html.duckduckgo.com/')
      ? DUCKDUCKGO_FIXTURE
      : DUCKDUCKGO_PAGES[url]
    if (body === undefined) throw new FetchError('HTTP 404', url, 404)
    return { url, status: 200, contentType: 'text/html; charset=utf-8', body, truncated: false }
  }
  return {
    userAgent: 'researcher-example',
    fetchRaw,
    async fetchText(url: string): Promise<FetchedDocument> {
      const raw = await fetchRaw(url)
      const extracted = extractText(raw.body)
      return {
        url: raw.url,
        status: raw.status,
        ...(extracted.title === undefined ? {} : { title: extracted.title }),
        text: extracted.text,
        truncated: raw.truncated,
      }
    },
  }
}

const dataRoot = join(process.cwd(), '.researcher')
await mkdir(dataRoot, { recursive: true })
// 不传编解码器：命令行没有 safeStorage，桌面应用加密的密钥在这里解不开。
const { config, warning } = await loadConfigResilient(dataRoot)
if (warning !== undefined) console.warn(`[config] ${warning}`)

for (const [pluginId, section] of Object.entries(config.plugins)) {
  if (secretSourceOf(section, 'DEEPSEEK_API_KEY') === 'undecryptable') {
    console.warn(
      `[secrets] 插件 ${pluginId} 的密钥由桌面应用加密，命令行无法解密；`
      + `请改用 ${envNameOf(section, 'DEEPSEEK_API_KEY')} 环境变量。`,
    )
  }
}

const kernel = new Kernel({
  registry: createRegistry(),
  config,
  dataRoot,
  mirrorLogsToConsole: false,
  ...(offline ? { fetchService: offlineFetch() } : {}),
})

console.log(`查询：${query}`)
console.log(`模式：${offline ? '离线（录制夹具，不联网）' : '在线'}${formats === undefined ? '' : `　输出格式：${formats.join('、')}`}`)
console.log('插件状态：')
for (const info of kernel.pluginInfos()) {
  if (info.kind === 'search' || info.kind === 'organize' || info.kind === 'provider') {
    console.log(`  ${info.kind.padEnd(9)} ${info.id.padEnd(22)} ${info.available ? '可用' : '不可用'}`)
  }
}
console.log('')

const bus = new SimpleEventBus()
bus.on((event: RunEvent) => {
  switch (event.type) {
    case 'stage:start':
      process.stdout.write(`▶ ${event.stage} … `)
      break
    case 'stage:done':
      console.log(event.summary)
      break
    case 'source:found':
      console.log(`  · ${event.source.title ?? event.source.url}`)
      break
    case 'fetch:done':
      console.log(`  ${event.ok ? '✓' : '✗'} ${event.url}${event.ok ? ` (${event.bytes} 字)` : ` (HTTP ${event.status})`}`)
      break
    case 'log':
      if (event.level === 'warn' || event.level === 'error') console.log(`  [${event.level}] ${event.message}`)
      break
    default:
      break
  }
})

try {
  const outcome = await kernel.run(
    { query, ...(formats === undefined ? {} : { formats }) },
    bus,
  )
  console.log('')
  console.log(`✔ 运行完成：${outcome.runId}`)
  console.log(`  搜索插件：${outcome.report.provenance.search}${outcome.report.provenance.searchFallbackUsed ? '（已降级）' : ''}`)
  console.log(`  整理插件：${outcome.report.provenance.organize}`)
  if (outcome.report.provenance.degraded !== undefined) {
    console.log(`  降级说明：${outcome.report.provenance.degraded}`)
  }
  console.log(`  来源 ${outcome.report.sources.length} 个，正文 ${outcome.report.documents.length} 篇，失败 ${outcome.report.failures.length} 篇`)
  console.log(`  产物：${outcome.artifacts.map((artifact) => artifact.path).join('、')}`)
  console.log(`  目录：${outcome.runDir}`)

  if (saveExample) {
    const exampleDir = join(process.cwd(), 'examples')
    await mkdir(exampleDir, { recursive: true })
    for (const [from, to] of [
      ['report.md', 'example-report.md'],
      ['report.html', 'example-report.html'],
      ['provenance.json', 'example-provenance.json'],
    ] as const) {
      await copyFile(join(outcome.runDir, from), join(exampleDir, to))
    }
    console.log('  已写出示例：examples/example-report.md、example-report.html、example-provenance.json')
  }
} catch (error) {
  console.error('')
  console.error(`✗ 运行失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
