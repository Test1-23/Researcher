/**
 * 解析模型返回的 JSON。
 *
 * 抽到这里是因为它被多处使用（整理插件、各个自主任务）；留一份实现，
 * 免得每个调用点各自处理代码块围栏与前后废话，行为不一致。
 */

/** 去掉可能的 markdown 代码块包裹。 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

/** 从夹带解释文字的输出里截出 JSON 对象。 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  return text.slice(start, end + 1)
}

/** 从夹带解释文字的输出里截出 JSON 数组。 */
export function extractJsonArray(text: string): string | undefined {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return undefined
  return text.slice(start, end + 1)
}

/** 宽松地解析：先按对象，再按数组。 */
export function parseLooseJson(text: string): unknown {
  const cleaned = stripCodeFence(text)
  const candidate = extractJsonObject(cleaned) ?? extractJsonArray(cleaned)
  if (candidate === undefined) return undefined
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

/** 普通对象判断。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取字符串，非字符串返回空串。 */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取有限数字，非法时返回 fallback。 */
export function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 取字符串数组，过滤非字符串项。 */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0)
}
