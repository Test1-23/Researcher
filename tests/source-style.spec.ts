/**
 * 源码约定检查。
 *
 * 引擎要能**不经过构建**直接被 Node 跑起来（`node scripts/run-example.ts`），
 * 靠的是 Node 的类型剥离。但剥离模式只支持可擦除的语法，以下写法会让它直接报错：
 *
 *   · 构造函数参数属性 `constructor(private readonly x: T)`
 *   · `enum`
 *   · `namespace` / `module`
 *
 * 这些在 vitest 与打包流程里都能正常工作，所以只有命令行会炸——正是那种
 * 「测试全绿但一跑 CLI 就崩」的回归。这条测试把它挡住。
 */

import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

/** 列出被跟踪的 src 下所有 TS 文件。 */
async function sourceFiles(): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', 'src'], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts') && !line.endsWith('.d.ts'))
}

describe('源码必须能被 Node 直接执行（类型剥离兼容）', () => {
  it('没有构造函数参数属性', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8')
      // 匹配「构造参数上带可见性/只读修饰符」的写法
      const pattern = /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+\w+\s*[?:]/s
      if (pattern.test(text)) offenders.push(file)
    }
    expect(offenders, `这些文件用了参数属性，Node 直接跑 TS 会报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX：\n${offenders.join('\n')}`).toEqual([])
  })

  it('没有 enum 与 namespace', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8')
      if (/^\s*(?:export\s+)?enum\s+\w+/m.test(text)) offenders.push(`${file}（enum）`)
      if (/^\s*(?:export\s+)?(?:namespace|module)\s+\w+\s*\{/m.test(text)) offenders.push(`${file}（namespace）`)
    }
    expect(offenders, `这些写法无法被类型剥离：\n${offenders.join('\n')}`).toEqual([])
  })

  it('相对 import 都带显式扩展名（Node ESM 需要）', async () => {
    const offenders: string[] = []
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
        const specifier = match[1] ?? ''
        if (!/\.(?:ts|tsx|json|js)$/.test(specifier)) offenders.push(`${file}: ${specifier}`)
      }
    }
    expect(offenders, `相对 import 缺少扩展名：\n${offenders.join('\n')}`).toEqual([])
  })
})
