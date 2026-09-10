/**
 * 结构化 LLM 调用。
 *
 * 自主任务需要的是「给出一个判断」而不是「生成一段散文」，因此统一走
 * JSON 模式 + 严格校验 + 失败重试一次。不可解析时**抛错而不是猜**——
 * 上层据此决定降级，而不是拿着半截数据继续跑。
 *
 * 同时累计用量：一次运行调了多少次、花了多少 token 要能写进 provenance。
 */

import { ResearcherError, isCancellation } from '../errors.ts'
import { parseLooseJson } from '../json.ts'
import type { PluginContext, TokenUsage } from '../types.ts'

/** 用量计量：跨任务累计，最终写进报告。 */
export class LlmMeter {
  calls = 0
  promptTokens = 0
  completionTokens = 0
  /** 记录每次调用失败的 JSON 解析（用于判断模型是否稳定） */
  parseFailures = 0

  record(usage: TokenUsage | undefined): void {
    this.calls += 1
    if (usage === undefined) return
    this.promptTokens += usage.promptTokens
    this.completionTokens += usage.completionTokens
  }

  get totalTokens(): number {
    return this.promptTokens + this.completionTokens
  }

  summary(): { calls: number; promptTokens: number; completionTokens: number; parseFailures: number } {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      parseFailures: this.parseFailures,
    }
  }
}

/** 一次结构化调用的规格。 */
export interface StructuredSpec {
  readonly system: string
  readonly user: string
  readonly temperature?: number
  readonly maxTokens?: number
  /** 解析失败时的重试次数（不含首次）。默认 1。 */
  readonly maxRetries?: number
}

/** 重试时追加的修复指令。 */
const REPAIR_PROMPT = '你上一次的输出不是合法的、符合要求的 JSON。请重新输出，只输出那一个 JSON 值，不要任何其它文字。'

/**
 * 调一次模型并解析成结构化结果。
 *
 * @param parse 校验并转换；不合法就抛错，触发重试
 */
export async function completeStructured<T>(
  spec: StructuredSpec,
  parse: (value: unknown) => T,
  ctx: PluginContext,
  meter: LlmMeter,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const maxRetries = spec.maxRetries ?? 1
  const baseMessages = [
    { role: 'system' as const, content: spec.system },
    { role: 'user' as const, content: spec.user },
  ]

  let lastOutput = ''
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted === true) throw new ResearcherError('运行已取消', 'CANCELLED')

    const messages = attempt === 0
      ? baseMessages
      : [
          ...baseMessages,
          { role: 'assistant' as const, content: lastOutput.slice(0, 4000) },
          { role: 'user' as const, content: REPAIR_PROMPT },
        ]

    const completion = await ctx.llm().complete(
      {
        messages,
        json: true,
        ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
        ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
      },
      ctx,
      signal,
    )
    meter.record(completion.usage)
    lastOutput = completion.text

    const parsed = parseLooseJson(completion.text)
    if (parsed === undefined) {
      lastError = new Error('输出里找不到可解析的 JSON')
      meter.parseFailures += 1
      ctx.log.warn(`${label}：第 ${attempt + 1} 次输出无法解析为 JSON`)
      continue
    }

    try {
      return parse(parsed)
    } catch (error) {
      if (isCancellation(error)) throw error
      lastError = error
      meter.parseFailures += 1
      ctx.log.warn(
        `${label}：第 ${attempt + 1} 次输出结构不合法（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  }

  throw new ResearcherError(
    `${label} 连续 ${maxRetries + 1} 次都没有给出可用的 JSON：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    'LLM_BAD_JSON',
    { cause: lastError },
  )
}

/**
 * 工具循环用的**无结构**调用：拿到文本或工具调用。
 *
 * 与 `completeStructured` 分开，是因为工具循环不能强求 JSON——
 * 模型可能是「调工具」也可能是「交稿」，两者都合法。
 */
export async function completeWithTools(
  spec: {
    readonly messages: readonly import('../types.ts').ChatMessage[]
    readonly tools?: readonly import('../types.ts').ToolSpec[]
    readonly toolChoice?: 'auto' | 'none'
    readonly temperature?: number
    readonly maxTokens?: number
  },
  ctx: PluginContext,
  meter: LlmMeter,
  signal?: AbortSignal,
): Promise<import('../types.ts').CompleteResult> {
  const result = await ctx.llm().complete(
    {
      messages: spec.messages,
      ...(spec.tools === undefined ? {} : { tools: spec.tools }),
      ...(spec.toolChoice === undefined ? {} : { toolChoice: spec.toolChoice }),
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
      ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
    },
    ctx,
    signal,
  )
  meter.record(result.usage)
  return result
}
