/**
 * 仓库不得包含密钥。
 *
 * 这是「不可能把密钥推上 GitHub」的第二道防线：CI 与本地的 `pnpm test` 都会跑它。
 * 内容检查复用 `tools/secret-scan.ts`，与命令行、CI 任务完全同一套规则。
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ALLOW_MARKER, looksBinary, scanText, RULES } from '../tools/secret-scan.ts'

const run = promisify(execFile)

/**
 * 把碎片拼成样例密钥。
 *
 * 这样测试文件里就不会出现**完整的**密钥形态，否则扫描器会命中它自己。
 * 拼出来的值仍然是真实形态，规则该命中还是会命中。
 */
function fake(...parts: readonly string[]): string {
  return parts.join('')
}

/** 列出被 git 跟踪的文件。 */
async function trackedFiles(): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files'], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
}

describe('密钥扫描规则本身', () => {
  it('能识别常见形态的密钥', () => {
    const cases: readonly [string, string][] = [
      [fake('sk-', 'abcdefghijklmnopqrstuvwxyz012345'), 'openai-style-key'],
      [fake('sk-ant-', 'api03-abcdefghijklmnopqrstuvwxyz'), 'anthropic-key'],
      // GitHub PAT 固定为 ghp_ + 36 位
      [fake('ghp_', '0123456789abcdefghijklmnopqrstuvwxyz'), 'github-token'],
      [fake('AKIA', 'IOSFODNN7EXAMPLE'), 'aws-access-key'],
      [fake('xoxb-', '1234567890-abcdefghijkl'), 'slack-token'],
      [fake('-----BEGIN ', 'RSA PRIVATE KEY-----'), 'private-key-block'],
      [fake('DEEPSEEK_API_KEY=', 'abcdef0123456789abcdef'), 'env-assignment'],
    ]
    for (const [text, expectedRule] of cases) {
      const found = scanText(text, 'inline')
      expect(found.map((finding) => finding.rule), `未命中 ${expectedRule}：${text}`).toContain(expectedRule)
    }
  })

  it('不误报正常的代码与占位符', () => {
    const safe = [
      'const apiKeyEnv = "DEEPSEEK_API_KEY";',
      "expect(resolveApiKey({ apiKey: 'literal' }, envName)).toBe('literal')",
      'const apiKeyEncrypted = section["apiKeyEncrypted"];',
      fake('sk-', 'short'),
      'https://api.deepseek.com/v1',
      "'provider-openai': { model: 'deepseek-chat' }",
      'password: "请在这里填写"',
    ]
    for (const line of safe) {
      expect(scanText(line, 'inline'), `误报：${line}`).toEqual([])
    }
  })

  it('命中片段会被脱敏，报告本身不泄漏密钥', () => {
    const secret = fake('sk-', 'abcdefghijklmnopqrstuvwxyz012345')
    const [finding] = scanText(secret, 'inline')
    expect(finding?.excerpt).not.toContain('abcdefghijklmnopqrstuvwxyz012345')
    expect(finding?.excerpt).toContain('…')
  })

  it('白名单标记可以显式放行一行', () => {
    const line = `const k = "${fake('sk-', 'abcdefghijklmnopqrstuvwxyz012345')}"; // secret-scan:allow`
    expect(scanText(line, 'inline')).toEqual([])
  })
})

describe('仓库内容', () => {
  it('被跟踪的文件里没有密钥', async () => {
    const files = await trackedFiles()
    expect(files.length).toBeGreaterThan(20)

    const hits: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue
      }
      if (looksBinary(text)) continue
      for (const finding of scanText(text, file)) {
        hits.push(`${file}:${finding.line} [${finding.rule}] ${finding.excerpt}`)
      }
    }

    expect(hits, `发现的密钥：\n${hits.join('\n')}`).toEqual([])
  })

  it('没有把运行时数据或配置文件纳入版本控制', async () => {
    const files = await trackedFiles()
    const risky = files.filter((file) => {
      const normalized = file.split('\\').join('/')
      return normalized.startsWith('.researcher/')
        || normalized.endsWith('/.env')
        || normalized === '.env'
        || /(^|\/)config\.json$/.test(normalized)
        || /\.(pem|key|p12|pfx)$/.test(normalized)
    })
    expect(risky, `不该被跟踪的文件：${risky.join('、')}`).toEqual([])
  })

  it('扫描器至少覆盖若干类密钥（防止规则被误删）', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(8)
  })
})

/** 让常量在测试里被引用到，避免 lint 抱怨未使用。 */
export { ALLOW_MARKER }
