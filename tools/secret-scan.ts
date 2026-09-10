/**
 * 密钥扫描器。
 *
 * 一套实现，三处复用：本地测试（`tests/no-secrets.spec.ts`）、命令行
 * （`scripts/scan-secrets.ts`）与 CI。刻意不引入第三方扫描 Action——
 * 依赖更少，而且离线可跑、规则可审计。
 *
 * 设计取舍：**宁可漏报也不要误报**。误报会让人习惯性忽略告警，
 * 那比少一条规则更危险。因此每条规则都要求足够长的、像密钥的值。
 */

/** 一条命中的结果。 */
export interface Finding {
  /** 触发的规则 id。 */
  readonly rule: string
  /** 文件路径（历史扫描时是当时的历史路径）。 */
  readonly source: string
  /** 行号（从 1 开始）；无法确定时为 undefined。 */
  readonly line: number | undefined
  /** 已脱敏的命中片段。 */
  readonly excerpt: string
}

/** 一条检测规则。 */
interface Rule {
  readonly id: string
  readonly description: string
  readonly pattern: RegExp
}

/**
 * 检测规则。
 *
 * 注意：这些模式写在本文件里也不会自我命中——`sk-[A-Za-z0-9]{24,}` 这种字面量
 * 在 `sk-` 之后紧跟着 `[`，不满足字符类。
 */
export const RULES: readonly Rule[] = [
  {
    id: 'openai-style-key',
    description: 'OpenAI / DeepSeek 风格的 sk- 密钥',
    pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/g,
  },
  {
    id: 'anthropic-key',
    description: 'Anthropic 风格的 sk-ant- 密钥',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'github-token',
    description: 'GitHub 个人访问令牌',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  },
  {
    id: 'aws-access-key',
    description: 'AWS Access Key ID',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'google-api-key',
    description: 'Google API Key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'slack-token',
    description: 'Slack 令牌',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'private-key-block',
    description: '私钥文件内容',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'assigned-secret',
    description: '把长密钥字面量直接赋给 key/secret/token 字段',
    pattern: /(?<=(?:api[_-]?key|apikey|secret|token|passwd|password)["']?\s*[:=]\s*)["'][A-Za-z0-9_\-]{32,}["']/gi,
  },
  {
    id: 'env-assignment',
    description: '疑似真实密钥的环境变量赋值',
    pattern: /^\s*(?:DEEPSEEK|OPENAI|ANTHROPIC)_API_KEY\s*=\s*\S{16,}/gm,
  },
]

/**
 * 已知安全的字面量：测试与文档里的假密钥。
 *
 * 用精确匹配而不是模式放宽，这样「加入白名单」永远是一次显式动作，
 * 而不是靠规则松动悄悄放过一整类值。
 */
export const ALLOWED_LITERALS: readonly string[] = [
  // tests/secrets.spec.ts
  'sk-live-abcdefghijklmnopqrstuvwxyz-0123456789',
  // tests/ipc.spec.ts
  'sk-test-key-that-must-never-leak-0123456789',
  // scripts/smoke-ui.ts
  'sk-smoke-test-key-must-never-touch-disk-0123456789',
]

/** 单行内允许跳过扫描的标记。 */
export const ALLOW_MARKER = 'secret-scan:allow'

/** 把命中片段脱敏后再放进报告，避免报告本身泄漏密钥。 */
export function maskExcerpt(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 12) return '***'
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`
}

/** 判断一行是否被白名单或标记放行。 */
function isAllowed(line: string): boolean {
  if (line.includes(ALLOW_MARKER)) return true
  return ALLOWED_LITERALS.some((literal) => line.includes(literal))
}

/**
 * 扫描一段文本。
 *
 * @param text 待扫描内容
 * @param source 用于报告的文件路径
 */
export function scanText(text: string, source: string): Finding[] {
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (isAllowed(line)) continue

    for (const rule of RULES) {
      // 规则带 g 标志，复用前必须重置 lastIndex，否则会漏掉后续行
      rule.pattern.lastIndex = 0
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({
          rule: rule.id,
          source,
          line: index + 1,
          excerpt: maskExcerpt(match[0]),
        })
      }
    }
  }

  return findings
}

/** 判断内容是否像二进制（含 NUL 字节），二进制直接跳过。 */
export function looksBinary(text: string): boolean {
  return text.includes('\u0000')
}
