/**
 * 密钥扫描命令行。
 *
 * 用法：
 *   node --no-warnings scripts/scan-secrets.ts              # 只扫被跟踪的工作树
 *   node --no-warnings scripts/scan-secrets.ts --history    # 追加扫描全量 git 历史
 *
 * 有命中即非零退出，可直接用于 CI 与本地 pre-push 检查。
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { looksBinary, scanText, type Finding } from '../tools/secret-scan.ts'

const run = promisify(execFile)

/** 在仓库里执行一个 git 命令。 */
async function git(args: readonly string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  const { stdout } = await run('git', [...args], { maxBuffer })
  return stdout
}

/** 扫描所有被跟踪的文件。 */
export async function scanTrackedFiles(): Promise<{ findings: Finding[]; files: string[] }> {
  const listed = await git(['ls-files'])
  const files = listed.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const findings: Finding[] = []

  for (const file of files) {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (looksBinary(text)) continue
    findings.push(...scanText(text, file))
  }

  return { findings, files }
}

/**
 * 扫描全部历史提交里**新增**的行。
 *
 * 解析 `+++ b/<路径>` 头来归属文件，因此报告能指出密钥是哪个文件里引入的。
 */
export async function scanHistory(): Promise<Finding[]> {
  const diff = await git(['log', '--all', '-p', '--no-color', '--unified=0', '--diff-filter=AM'])
  const findings: Finding[] = []
  let currentFile = '(未知文件)'
  let lineNumber = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6)
      lineNumber = 0
      continue
    }
    if (line.startsWith('@@')) {
      const match = /\+(\d+)/.exec(line)
      lineNumber = match === null ? 0 : Number(match[1]) - 1
      continue
    }
    // 只看新增行；+++ / --- 头已经处理过
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNumber += 1
      const body = line.slice(1)
      if (looksBinary(body)) continue
      for (const found of scanText(body, currentFile)) {
        findings.push({ ...found, line: lineNumber })
      }
    }
  }

  return findings
}

/** 打印结果并给出人类可读的汇总。 */
function report(title: string, findings: readonly Finding[], scanned: number | undefined): void {
  if (findings.length === 0) {
    console.log(`✓ ${title}：未发现密钥${scanned === undefined ? '' : `（扫描 ${scanned} 个文件）`}`)
    return
  }
  console.error(`✗ ${title}：发现 ${findings.length} 处疑似密钥`)
  for (const finding of findings.slice(0, 50)) {
    const where = finding.line === undefined ? finding.source : `${finding.source}:${finding.line}`
    console.error(`  ${where}  [${finding.rule}]  ${finding.excerpt}`)
  }
  if (findings.length > 50) console.error(`  …另有 ${findings.length - 50} 处`)
  console.error('  若确认是假密钥，请把它加进 tools/secret-scan.ts 的 ALLOWED_LITERALS，')
  console.error('  或在那一行加上 secret-scan:allow 注释。')
}

const withHistory = process.argv.includes('--history')

const tracked = await scanTrackedFiles()
report('工作树', tracked.findings, tracked.files.length)

let historyFindings: Finding[] = []
if (withHistory) {
  historyFindings = await scanHistory()
  report('git 历史', historyFindings, undefined)
}

const total = tracked.findings.length + historyFindings.length
if (total > 0) {
  console.error('')
  console.error(`共 ${total} 处命中，已阻止。`)
  process.exitCode = 1
} else {
  console.log('')
  console.log('密钥扫描通过。')
}
