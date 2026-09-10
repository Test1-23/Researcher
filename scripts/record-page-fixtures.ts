/**
 * 录制真实页面的抽取夹具。
 *
 * 为什么需要它：自动测试此前只用合成页面，于是「Readability 在真实页面上怎么选、
 * 闸门什么时候回退」这些**真实行为没有回归网**。
 *
 * 做法是抓一次真页面、做**最小精简**、写成夹具；测试离线跑，断言每页最终选中了哪个抽取器。
 *
 * 关键约束：**精简不能改掉被测行为**。Readability 的分值依赖 DOM 结构，
 * 随意裁剪会让夹具测的东西和线上不是一回事。所以脚本逐级加大精简力度，
 * 只在「决策与原始页面一致」时才采用那一级；一级都保不住就原样保存。
 *
 * 用法：node --no-warnings scripts/record-page-fixtures.ts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_EXTRACTOR_OPTIONS, extractContent } from '../src/main/engine/extract.ts'
import type { ExtractionMethod } from '../src/main/engine/extract.ts'
import { RULES, scanText } from '../tools/secret-scan.ts'

/** 要录制的页面。`expect` 是当前实现的决策，脚本会核对精简后是否仍然一致。 */
const PAGES: readonly { readonly name: string; readonly url: string; readonly expect: ExtractionMethod }[] = [
  { name: 'csdn', url: 'https://blog.csdn.net/gitblog_01136/article/details/151943535', expect: 'readability' },
  { name: 'webdev', url: 'https://web.developers.google.cn/blog/webgpu-supported-major-browsers?hl=zh-cn', expect: 'readability' },
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/WebGPU', expect: 'readability' },
  // 已知难点：重前端框架的页面，Readability 只取到页脚，闸门应当回退
  { name: 'devsite', url: 'https://developer.chrome.com/docs/web-platform/webgpu/news?hl=zh-cn', expect: 'plain-text' },
]

const OUTPUT_DIR = join(process.cwd(), 'fixtures', 'pages')

/** 带退避重试的抓取：出口代理偶发丢 TLS 握手。 */
async function get(url: string, tries = 4): Promise<string> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(40_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      if (attempt === tries) throw error
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
    }
  }
  throw new Error('unreachable')
}

/**
 * 逐级加大力度的精简。
 *
 * 只用**不会改变 DOM 语义**的手段：去注释、去 base64 内联数据、压缩标签间空白。
 * 刻意不动 script / 结构——Readability 会读 JSON-LD 与结构来打分。
 */
function reduceAtLevel(html: string, level: number): string {
  let out = html
  if (level >= 1) out = out.replace(/<!--[\s\S]*?-->/g, '')
  if (level >= 2) out = out.replace(/(src|href)="data:[^"]*"/gi, '$1="data:stripped"')
  if (level >= 3) out = out.replace(/>\s+</g, '><').replace(/[ \t]{2,}/g, ' ')
  if (level >= 4) out = out.replace(/\s*\n\s*/g, '\n')
  return out
}

/**
 * 抹掉页面里的密钥形态字符串。
 *
 * 真实网页的源码里常内嵌**客户端公开密钥**（例如 web.dev 里的 Google API key——
 * Firebase 的前端 key 本来就是公开的）。它们不是泄漏，但仓库里不该出现密钥形态的字符串，
 * 扫描器也不该为它们开白名单。
 *
 * 保留前 4 个字符、其余替换成同长度的 `*`：**长度不变**（免得任何依赖长度的启发式被改掉），
 * 而 `*` 不在任何密钥规则的字符类里，所以掩码后不会再被扫描器命中。
 *
 * @returns 抹掉后的 HTML、抹掉的处数、以及**复查**后仍残留的处数
 */
export function scrubSecrets(html: string): { html: string; scrubbed: number; remaining: number } {
  let out = html
  let scrubbed = 0
  for (const rule of RULES) {
    // 每条规则各建一个实例，避免共享 lastIndex
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
    out = out.replace(pattern, (match) => {
      scrubbed += 1
      const keep = Math.min(4, match.length)
      return match.slice(0, keep) + '*'.repeat(Math.max(0, match.length - keep))
    })
  }
  // 复查：抹完之后必须一条都不剩，否则就是掩码本身还在触发规则
  const remaining = scanText(out, 'fixture').length
  return { html: out, scrubbed, remaining }
}

/** 当前决策。 */
function decide(html: string): ExtractionMethod {
  return extractContent(html, DEFAULT_EXTRACTOR_OPTIONS).method
}

/** 主流程。 */
async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const records: { name: string; url: string; method: ExtractionMethod; bytes: number; reductionLevel: number; note: string }[] = []

  for (const page of PAGES) {
    process.stdout.write(`── ${page.name}\n`)
    let original: string
    try {
      original = await get(page.url)
    } catch (error) {
      console.log(`   抓取失败，跳过：${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const originalMethod = decide(original)
    // 先抹密钥再判断决策：夹具就是抹过的那份，测试断言的也应当是它
    const scrubbed = scrubSecrets(original)
    const scrubbedMethod = decide(scrubbed.html)

    // 逐级试，取「决策不变」里力度最大的那一级
    let chosen = scrubbed.html
    let chosenLevel = -1
    for (let level = 1; level <= 4; level += 1) {
      const candidate = reduceAtLevel(scrubbed.html, level)
      if (decide(candidate) === scrubbedMethod) {
        chosen = candidate
        chosenLevel = level
      } else {
        break
      }
    }

    const matchesExpected = scrubbedMethod === page.expect
    const note = chosenLevel < 0
      ? '未精简（任何一级都会改变决策）'
      : `精简到第 ${chosenLevel} 级`

    console.log(
      `   原始 ${original.length} 字符 → 夹具 ${chosen.length} 字符（${note}）`
      + `｜抹掉 ${scrubbed.scrubbed} 处密钥形态字符串`
      + (scrubbed.remaining > 0 ? `（仍有 ${scrubbed.remaining} 处残留！）` : '')
      + `｜决策 ${scrubbedMethod}${matchesExpected ? '' : `（与脚本预期的 ${page.expect} 不一致！）`}`,
    )
    if (originalMethod !== scrubbedMethod) {
      console.log('   ⚠ 抹密钥改变了抽取决策，夹具与线上行为不再一致')
    }

    await writeFile(join(OUTPUT_DIR, `${page.name}.html`), chosen, 'utf8')
    records.push({
      name: page.name,
      url: page.url,
      method: scrubbedMethod,
      bytes: chosen.length,
      reductionLevel: chosenLevel,
      note,
    })
  }

  const total = records.reduce((sum, record) => sum + record.bytes, 0)
  console.log(`\n合计 ${records.length} 页，${Math.round(total / 1024)} KB`)

  // 生成元信息模块：URL 与录制日期要留在仓库里，便于判断夹具是否过期
  const lines: string[] = [
    '/**',
    ' * 录制页面的元信息。',
    ' *',
    ' * 由 `scripts/record-page-fixtures.ts` 生成，**不要手改**。',
    ' * 夹具是某一时刻的真实页面快照；`recordedAt` 用来判断它有多旧。',
    ' */',
    '',
    '/** 一页录制信息。 */',
    'export interface RecordedPage {',
    '  readonly name: string',
    '  readonly url: string',
    '  /** 录制那一刻，原始页面上实际选中的抽取实现。 */',
    '  readonly method: string',
    '  /** 精简力度（越大越狠）；-1 表示未精简。 */',
    '  readonly reductionLevel: number',
    '  readonly bytes: number',
    '  readonly note: string',
    '}',
    '',
    `export const RECORDED_AT = ${JSON.stringify(new Date().toISOString())}`,
    '',
    'export const RECORDED_PAGES: readonly RecordedPage[] = [',
  ]
  for (const record of records) {
    lines.push(
      '  {'
      + ` name: ${JSON.stringify(record.name)},`
      + ` url: ${JSON.stringify(record.url)},`
      + ` method: ${JSON.stringify(record.method)},`
      + ` reductionLevel: ${record.reductionLevel},`
      + ` bytes: ${record.bytes},`
      + ` note: ${JSON.stringify(record.note)} },`,
    )
  }
  lines.push(']', '')
  await writeFile(join(OUTPUT_DIR, 'index.ts'), lines.join('\n'), 'utf8')
  console.log('已写出 fixtures/pages/index.ts')
}

await main()
