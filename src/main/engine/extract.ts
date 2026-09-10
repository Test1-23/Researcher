/**
 * 正文抽取。
 *
 * 首选 **Readability**（Firefox 阅读模式的算法，零依赖）配 linkedom 提供 DOM。
 * 实测 4 个真实页面赢 3 个（CSDN 7040 字 / web.dev 1909 字 / Wikipedia 6781 字），
 * 但在 Chrome devsite 那种重前端框架的页面上会只取到页脚。
 *
 * 所以这里有一条**升级—回退**链，而不是单一实现：
 *
 *   ① Readability 整页
 *   ② 质量闸门不过 → 整页纯文本（`html.ts` 的去标签结果）
 *
 * 回退刻意选「整页纯文本」而不是再写一个启发式抽取器：下游是 LLM 代理，
 * 它有能力忽略导航噪声；而一个把正文猜错的智能抽取器会**主动丢内容**，
 * 那比噪声严重得多——噪声可以忽略，丢掉的东西找不回来。
 *
 * 抽取用哪个实现会如实记录（`method` / `fallbackReason`），并进入报告的 provenance。
 */

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { extractText } from './html.ts'

/** 实际使用的抽取实现。 */
export type ExtractionMethod = 'readability' | 'plain-text'

/** 抽取结果。 */
export interface ExtractionResult {
  readonly title?: string
  readonly text: string
  readonly method: ExtractionMethod
  /** 文本被上限截断。 */
  readonly truncated: boolean
  /** 为什么没用首选实现；用上了就没有这个字段。 */
  readonly fallbackReason?: string
}

/** 抽取配置。 */
export interface ExtractorOptions {
  /** `auto` 走升级—回退链；另外两个强制指定，便于排查。 */
  readonly mode: 'auto' | 'readability' | 'plain-text'
  /** 文本长度上限，超出截断。 */
  readonly maxTextChars: number
  /** 质量闸门的绝对下限（字符）。 */
  readonly minChars: number
  /** 质量闸门的相对下限：抽取结果 / 整页纯文本 的比例。 */
  readonly minRatio: number
}

/** 默认配置，与 `DEFAULT_CONFIG.fetch` 保持一致。 */
export const DEFAULT_EXTRACTOR_OPTIONS: ExtractorOptions = {
  mode: 'auto',
  maxTextChars: 20_000,
  minChars: 400,
  minRatio: 0.2,
}

/** 把 Readability 输出的空白整理成与 `htmlToText` 一致的形状。 */
function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 跑一次 Readability。
 *
 * 解析失败或结果为空都返回 undefined——**绝不抛错**：抽取失败只是要走回退链，
 * 不该让整个抓取步骤失败。
 */
export function runReadability(html: string): { title?: string; text: string } | undefined {
  try {
    const { document } = parseHTML(html)
    const article = new Readability(document).parse()
    if (article === null) return undefined

    const text = normalizeText(article.textContent ?? '')
    if (text.length === 0) return undefined

    const title = typeof article.title === 'string' ? article.title.trim() : ''
    return title.length > 0 ? { title, text } : { text }
  } catch {
    return undefined
  }
}

/** 按上限截断。 */
function clip(text: string, maxTextChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxTextChars) return { text, truncated: false }
  return { text: text.slice(0, maxTextChars), truncated: true }
}

/**
 * 从 HTML 抽取正文。
 *
 * @param html 完整响应体
 * @param options 抽取配置
 */
export function extractContent(html: string, options: ExtractorOptions = DEFAULT_EXTRACTOR_OPTIONS): ExtractionResult {
  // 纯文本结果同时充当「回退目标」与「质量闸门的基准」
  const plain = extractText(html)
  const plainResult = (fallbackReason?: string): ExtractionResult => {
    const clipped = clip(plain.text, options.maxTextChars)
    return {
      ...(plain.title === undefined ? {} : { title: plain.title }),
      text: clipped.text,
      method: 'plain-text',
      truncated: clipped.truncated,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    }
  }

  if (options.mode === 'plain-text') return plainResult()

  const readable = runReadability(html)
  if (readable === undefined) {
    // 强制 readability 模式下也一样回退：宁可给噪声，也不能给空
    return plainResult('Readability 没有解析出正文')
  }

  // 闸门：绝对下限 与 相对整页文本量的比例，取更严的那个
  const floor = Math.max(options.minChars, Math.round(plain.text.length * options.minRatio))
  const plainIsRicher = plain.text.length > readable.text.length
  if (options.mode === 'auto' && readable.text.length < floor && plainIsRicher) {
    return plainResult(`Readability 只取到 ${readable.text.length} 字，低于闸门 ${floor} 字`)
  }

  const clipped = clip(readable.text, options.maxTextChars)
  const title = readable.title ?? plain.title
  return {
    ...(title === undefined ? {} : { title }),
    text: clipped.text,
    method: 'readability',
    truncated: clipped.truncated,
  }
}
