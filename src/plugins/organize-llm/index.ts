/**
 * 基于大模型的整理插件。
 *
 * 它要求模型输出**严格 JSON**，然后自己校验结构、过滤掉不存在的引用 URL，
 * 再交给输出插件渲染。这样「整理」这一步的产物是结构化的，而不是一段需要再猜的散文。
 *
 * 失败处理是有层次的：JSON 不合法 → 带修复提示重试一次 → 仍失败则抛出 LLM_BAD_JSON，
 * 由 pipeline 降级到 organize-extractive，而不是让整次运行白跑。
 */

import { sectionNumber, sectionPositiveInt } from '../../main/engine/config.ts'
import { ResearcherError } from '../../main/engine/errors.ts'
import { asString, extractJsonObject, isPlainObject, stripCodeFence } from '../../main/engine/json.ts'
import { definePlugin } from '../../main/engine/registry.ts'
import type {
  AvailabilityContext,
  FetchedDocument,
  OrganizeInput,
  OrganizeOutput,
  Organizer,
  PluginContext,
  PluginManifest,
  ReportSection,
  SearchSource,
} from '../../main/engine/types.ts'

/** 交给模型的输出契约。 */
const SYSTEM_PROMPT = [
  '你是一名严谨的研究助理。你要根据用户提供的资料，写一份结构化的中文研究报告。',
  '',
  '硬性要求：',
  '1. 只能使用用户提供的资料，不得引入资料之外的事实、数字或结论。资料不足时明确说明「资料不足以判断」。',
  '2. 只输出一个 JSON 对象，不要包裹 markdown 代码块，不要输出任何解释文字。',
  '3. JSON 结构必须是：',
  '{"title": "报告标题", "summary": "3-5 句话的总体摘要", "sections": [{"heading": "小节标题", "body": "小节正文", "citations": ["https://..."]}]}',
  '4. sections 里每一项的 citations 必须是资料中出现过的 url 原文，禁止编造或改写 URL。',
  '5. 每一节都要有实际内容，不要写占位符，不要写「同上」。',
].join('\n')

/** 重试时追加的修复指令。 */
const REPAIR_PROMPT = '你上一次的输出不是合法的、符合结构的 JSON。请重新输出，只输出那一个 JSON 对象，不要任何其它文字。'

/** 解析后的报告结构。 */
export interface ParsedOrganizeOutput {
  readonly title: string
  readonly summary: string
  readonly sections: readonly ReportSection[]
}

/**
 * 解析并校验模型输出。
 *
 * 校验会丢弃所有不在资料里出现过的引用 URL——模型编造引用是这类任务最常见的失败模式，
 * 与其信任它，不如按白名单过滤。
 *
 * @throws ResearcherError 带 LLM_BAD_JSON 错误码，调用方据此决定重试或降级。
 */
export function parseOrganizeJson(text: string, allowedUrls: ReadonlySet<string>): ParsedOrganizeOutput {
  const jsonText = extractJsonObject(stripCodeFence(text))
  if (jsonText === undefined) {
    throw new ResearcherError('模型输出里找不到 JSON 对象', 'LLM_BAD_JSON')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    throw new ResearcherError(
      `模型输出的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`,
      'LLM_BAD_JSON',
      { cause: error },
    )
  }

  if (!isPlainObject(parsed)) {
    throw new ResearcherError('模型输出的顶层不是 JSON 对象', 'LLM_BAD_JSON')
  }

  const rawSections = Array.isArray(parsed['sections']) ? parsed['sections'] : []
  const sections: ReportSection[] = []
  let droppedCitations = 0

  for (const raw of rawSections) {
    if (!isPlainObject(raw)) continue
    const heading = asString(raw['heading'])
    const body = asString(raw['body'])
    if (heading.length === 0 && body.length === 0) continue

    const rawCitations = Array.isArray(raw['citations']) ? raw['citations'] : []
    const citations: string[] = []
    for (const candidate of rawCitations) {
      if (typeof candidate !== 'string') continue
      const url = candidate.trim()
      if (url.length === 0) continue
      if (!allowedUrls.has(url)) {
        droppedCitations += 1
        continue
      }
      if (!citations.includes(url)) citations.push(url)
    }

    sections.push({ heading: heading.length > 0 ? heading : '（无标题）', body, citations })
  }

  if (sections.length === 0) {
    throw new ResearcherError('模型输出里没有可用的 sections', 'LLM_BAD_JSON')
  }

  return {
    title: asString(parsed['title']) || '研究报告',
    summary: asString(parsed['summary']),
    sections,
  }
}

/** 喂给模型的资料条目。 */
interface MaterialEntry {
  readonly source: SearchSource
  readonly document: FetchedDocument | undefined
}

/** 按预算挑选资料并拼成提示词正文。 */
export function buildMaterial(
  input: OrganizeInput,
  limits: { maxSources: number; maxCharsPerSource: number; maxTotalChars: number },
): string {
  const documentBySource = new Map<string, FetchedDocument>()
  for (const document of input.documents) {
    const key = document.sourceUrl ?? document.url
    if (!documentBySource.has(key)) documentBySource.set(key, document)
  }

  const entries: MaterialEntry[] = input.sources
    .slice(0, limits.maxSources)
    .map((source) => ({ source, document: documentBySource.get(source.url) }))

  const blocks: string[] = []
  let total = 0
  for (let index = 0; index < entries.length; index += 1) {
    const { source, document } = entries[index]
    const lines = [`[${index + 1}] url: ${source.url}`]
    const title = document?.title ?? source.title
    if (title !== undefined && title.length > 0) lines.push(`    标题：${title}`)

    let body = document?.text ?? ''
    if (body.length === 0) body = source.snippet ?? ''
    if (body.length === 0) {
      lines.push('    正文：抓取失败，且没有摘要')
    } else {
      const excerpt = body.slice(0, limits.maxCharsPerSource)
      lines.push(`    正文摘录${body.length > excerpt.length ? '（已截断）' : ''}：${excerpt}`)
    }

    const block = lines.join('\n')
    if (total + block.length > limits.maxTotalChars && blocks.length > 0) break
    blocks.push(block)
    total += block.length
  }

  return blocks.join('\n\n')
}

/** LLM 整理插件。 */
export class LlmOrganizer implements Organizer {
  readonly id = 'organize-llm'
  readonly kind = 'organize' as const

  /** 自己不需要 key，但依赖大模型 provider 可用；这一点通过内核查询。 */
  available(ctx: AvailabilityContext): boolean {
    return ctx.isAvailable('provider')
  }

  async organize(input: OrganizeInput, ctx: PluginContext, signal?: AbortSignal): Promise<OrganizeOutput> {
    const section = ctx.config.section(this.id)
    const maxSources = sectionPositiveInt(section, 'maxSourcesInPrompt', 8)
    const maxCharsPerSource = sectionPositiveInt(section, 'maxCharsPerSource', 2500)
    const maxTotalChars = sectionPositiveInt(section, 'maxTotalChars', 24_000)
    const temperature = sectionNumber(section, 'temperature', 0.2)

    const material = buildMaterial(input, { maxSources, maxCharsPerSource, maxTotalChars })
    if (material.trim().length === 0) {
      throw new ResearcherError('没有可用于整理的资料（来源为空）', 'LLM_UNAVAILABLE')
    }

    const allowedUrls = new Set(input.sources.map((source) => source.url))
    const baseMessages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      {
        role: 'user' as const,
        content: `查询：${input.query}\n\n资料（只允许引用下面出现过的 url）：\n\n${material}`,
      },
    ]

    const llm = ctx.llm()
    const maxAttempts = 2
    let lastOutput = ''
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted === true) throw new ResearcherError('运行已取消', 'CANCELLED')

      const messages = attempt === 1
        ? baseMessages
        : [
            ...baseMessages,
            { role: 'assistant' as const, content: lastOutput.slice(0, 4000) },
            { role: 'user' as const, content: REPAIR_PROMPT },
          ]

      const completion = await llm.complete({ messages, json: true, temperature }, ctx, signal)
      lastOutput = completion.text

      try {
        const parsed = parseOrganizeJson(completion.text, allowedUrls)
        return {
          ...parsed,
          meta: {
            pluginId: this.id,
            model: completion.model,
            ...(completion.usage === undefined ? {} : { usage: completion.usage }),
            attempts: attempt,
          },
        }
      } catch (error) {
        lastError = error
        if (attempt < maxAttempts) {
          ctx.log.warn(`整理输出不可用（${describe(error)}），追加修复指令后重试一次`)
        }
      }
    }

    throw new ResearcherError(
      `大模型连续 ${maxAttempts} 次都没有给出可用的 JSON 报告：${describe(lastError)}`,
      'LLM_BAD_JSON',
      { cause: lastError },
    )
  }
}

/** 从任意异常取可读信息。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 插件清单。 */
export const llmOrganizerPlugin: PluginManifest = definePlugin({
  id: 'organize-llm',
  kind: 'organize',
  version: '0.1.0',
  title: '大模型整理',
  description: '要求模型输出严格 JSON 的结构化报告，并按来源白名单过滤引用；失败时重试一次后降级。',
  entry: new LlmOrganizer(),
})
