/**
 * 写作任务：按模板写出每一节，带工具。
 *
 * 这是整个流程里**唯一真正 agentic 的地方**，也是工具唯一有价值的地方：
 * 写某一节时如果发现资料不够，它可以自己去补搜、回读原文、甚至改大纲。
 * 采集与归纳做成确定性流程反而更可靠，但「写到一半发现缺口」只有写作者自己知道。
 *
 * 满足判据是**自检通过**：每一节都写出来了，并且通过了针对模板要求的检查。
 * 自检反复不过的节会在用尽重试后**如实标注未通过**并继续——
 * 假装通过比标注未通过糟糕得多。
 */

import { throwIfAborted } from '../errors.ts'
import { asString } from '../json.ts'
import type { DocumentTemplate } from '../../../templates/index.ts'
import type { ChatMessage, PluginContext, ToolCall, ToolSpec } from '../types.ts'
import { collectDocuments, type Candidate } from './collect.ts'
import { dedupe, filterIrrelevant, normalizeUrl } from './filter.ts'
import { completeStructured, completeWithTools, type LlmMeter } from './llm.ts'
import type { AgentTask, BlackboardView, DocumentSection, OutlineSection } from './types.ts'

/** 写作任务配置。 */
export interface WritingTaskConfig {
  /** 单节工具循环的步数上限（护栏）。 */
  readonly maxToolSteps: number
  /** 单节自检不过时的最大重写次数。 */
  readonly maxRewriteAttempts: number
  /** 回读原文时单次最多给多少字符。 */
  readonly readSourceChars: number
  /** 补搜时取多少条结果。 */
  readonly searchMoreCandidates: number
  /** 发给模型的来源正文上限。 */
  readonly contextCharsPerSource: number
}

/** 默认配置。 */
export const DEFAULT_WRITING_TASK: WritingTaskConfig = {
  maxToolSteps: 12,
  maxRewriteAttempts: 2,
  readSourceChars: 4000,
  searchMoreCandidates: 12,
  contextCharsPerSource: 3000,
}

/** 工具名。 */
export const TOOL_SEARCH_MORE = 'search_more'
export const TOOL_READ_SOURCE = 'read_source'
export const TOOL_LIST_SOURCES = 'list_sources'
export const TOOL_REVISE_OUTLINE = 'revise_outline'

/** 写作阶段暴露给模型的工具。 */
export const WRITING_TOOLS: readonly ToolSpec[] = [
  {
    name: TOOL_SEARCH_MORE,
    description: '资料不足以支撑本节时，用它补充搜索并抓取新来源。只在确实缺资料时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询，要针对你缺失的那个具体方面' },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_READ_SOURCE,
    description: '回读某个来源的原文细节。给出关键词时只返回包含关键词的段落，比整篇更省上下文。',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: '来源 id，如 s003' },
        keyword: { type: 'string', description: '可选：只取包含该关键词的段落' },
      },
      required: ['sourceId'],
    },
  },
  {
    name: TOOL_LIST_SOURCES,
    description: '列出当前语料库里有哪些来源（id、标题、是否抓到正文）。',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: TOOL_REVISE_OUTLINE,
    description: '如果发现大纲的这一节划分得不合理（例如目标无法由现有资料支撑），用它修改该节的目标或标题。',
    parameters: {
      type: 'object',
      properties: {
        sectionId: { type: 'string', description: '要修改的小节 id' },
        heading: { type: 'string', description: '新的标题（可选）' },
        goal: { type: 'string', description: '新的目标（可选）' },
      },
      required: ['sectionId'],
    },
  },
]

const SECTION_SYSTEM = [
  '你在按大纲为一份文档写其中的一节。',
  '',
  '严格要求：',
  '1. 只使用给定的资料。资料不足以支撑某个论断时，**明确写「资料不足以判断」**，不要用常识补全。',
  '2. 不要编造来源、数字、时间或引用。',
  '3. 写完直接输出这一节的正文（Markdown），不要输出 JSON、不要加解释、不要重复标题。',
  '4. 资料不够时可以调用工具补充：search_more 补搜、read_source 回读原文细节。',
  '5. 资料足够时就**直接开始写**，不要为了用工具而用工具。',
].join('\n')

const SELF_CHECK_SYSTEM = [
  '你检查一份文档的某一节是否达标。',
  '',
  '检查项：',
  '1. 是否完成了这一节规定的目标。',
  '2. 每个事实性论断是否能在给定资料里找到依据；有无编造。',
  '3. 是否满足该节的写作要求（长度、要素等）。',
  '',
  '只输出 JSON：{"passed": true/false, "notes": "没通过时说明差在哪，一句话"}',
].join('\n')

/** 写作任务。 */
export class WritingTask implements AgentTask {
  readonly name = 'write'
  /** 护栏：一节一步，外加重写余量。 */
  readonly safetyLimit = 60

  /** 每节已经尝试了几次（含最后一次未通过）。 */
  private readonly attempts = new Map<string, number>()
  /** 每节累计的工具调用次数，用于报告。 */
  private readonly toolCalls = new Map<string, number>()

  constructor(
    private readonly template: DocumentTemplate,
    private readonly config: WritingTaskConfig = DEFAULT_WRITING_TASK,
    private readonly meter?: LlmMeter,
  ) {}

  /** 工具调用总数。 */
  get totalToolCalls(): number {
    let total = 0
    for (const count of this.toolCalls.values()) total += count
    return total
  }

  isSatisfied(board: BlackboardView): boolean {
    const outline = board.outline
    if (outline === undefined || outline.sections.length === 0) return false

    return outline.sections.every((section) => {
      const written = board.document.find((item) => item.outlineSectionId === section.id)
      if (written === undefined) return false
      if (written.selfCheckPassed) return true
      // 自检没过但重写次数已经用尽：接受这个结果，但如实标记未通过
      return (this.attempts.get(section.id) ?? 0) >= this.config.maxRewriteAttempts
    })
  }

  explain(board: BlackboardView): string {
    const outline = board.outline
    if (outline === undefined) return '还没有大纲'
    const pending = outline.sections.filter((section) => {
      const written = board.document.find((item) => item.outlineSectionId === section.id)
      if (written === undefined) return true
      if (written.selfCheckPassed) return false
      return (this.attempts.get(section.id) ?? 0) < this.config.maxRewriteAttempts
    })
    if (pending.length === 0) {
      const failed = board.document.filter((item) => !item.selfCheckPassed).length
      return failed === 0 ? '全部小节已通过自检' : `全部小节已完成，其中 ${failed} 节未通过自检`
    }
    return `还有 ${pending.length} 节待完成：${pending.map((section) => section.heading).join('、')}`
  }

  async step(board: BlackboardView, ctx: PluginContext, signal?: AbortSignal): Promise<void> {
    const meter = this.requireMeter()
    const outline = board.outline
    if (outline === undefined) {
      board.record(this.name, 'note', '还没有大纲，等待大纲任务')
      return
    }

    const target = outline.sections.find((section) => this.needsWork(board, section))
    if (target === undefined) {
      board.record(this.name, 'note', '没有待写的节')
      return
    }

    throwIfAborted(signal)
    const attempt = (this.attempts.get(target.id) ?? 0) + 1
    this.attempts.set(target.id, attempt)

    const section = await this.writeSection(board, outline.title, outline.thesis, target, ctx, meter, signal)
    board.writeSection(section)

    board.record(this.name, 'step', `写完「${target.heading}」${section.selfCheckPassed ? '（自检通过）' : `（自检未通过：${section.selfCheckNotes ?? '未说明'}）`}`, {
      section: target.heading,
      attempt,
      selfCheckPassed: section.selfCheckPassed,
      forced: section.forced === true,
      toolCalls: this.toolCalls.get(target.id) ?? 0,
    })
    ctx.events.emit({
      type: 'task:step',
      task: this.name,
      step: attempt,
      message: `${target.heading}：${section.selfCheckPassed ? '自检通过' : '自检未通过'}${section.forced === true ? '（工具步数耗尽，强制收稿）' : ''}`,
    })
  }

  /** 这一节还需要干活吗。 */
  private needsWork(board: BlackboardView, section: OutlineSection): boolean {
    const written = board.document.find((item) => item.outlineSectionId === section.id)
    if (written === undefined) return true
    if (written.selfCheckPassed) return false
    return (this.attempts.get(section.id) ?? 0) < this.config.maxRewriteAttempts
  }

  /** 写一节：工具循环 → 自检。 */
  private async writeSection(
    board: BlackboardView,
    documentTitle: string,
    thesis: string,
    section: OutlineSection,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<DocumentSection> {
    const previous = board.document.find((item) => item.outlineSectionId === section.id)
    const messages: ChatMessage[] = [
      { role: 'system', content: SECTION_SYSTEM },
      { role: 'user', content: this.buildBrief(board, documentTitle, thesis, section, previous?.selfCheckNotes) },
    ]

    const supportsTools = ctx.llm().supportsTools
    let body = ''
    let forced = false

    if (!supportsTools) {
      // provider 不支持原生工具调用：退化为无工具写作，并如实记录
      ctx.log.warn('当前大模型不支持原生工具调用，本节以无工具模式写作')
      const result = await completeWithTools({ messages }, ctx, meter, signal)
      body = result.text.trim()
    } else {
      for (let step = 1; step <= this.config.maxToolSteps; step += 1) {
        throwIfAborted(signal)
        const result = await completeWithTools({ messages, tools: WRITING_TOOLS }, ctx, meter, signal)

        const calls = result.toolCalls ?? []
        if (calls.length === 0) {
          body = result.text.trim()
          break
        }

        // 记录 assistant 的工具调用，再逐条追加工具结果
        messages.push({ role: 'assistant', content: result.text, toolCalls: calls })
        this.toolCalls.set(section.id, (this.toolCalls.get(section.id) ?? 0) + calls.length)

        for (const call of calls) {
          const output = await this.runTool(board, call, ctx, meter, signal)
          messages.push({ role: 'tool', content: output, toolCallId: call.id })
        }

        if (step === this.config.maxToolSteps) {
          // 步数耗尽：强制收稿而不是抛错。用 toolChoice=none 明确不许再调工具。
          ctx.log.warn(`「${section.heading}」工具步数耗尽，强制收稿`)
          const final = await completeWithTools(
            { messages, tools: WRITING_TOOLS, toolChoice: 'none' },
            ctx,
            meter,
            signal,
          )
          body = final.text.trim()
          forced = true
        }
      }
    }

    if (body.length === 0) {
      return {
        outlineSectionId: section.id,
        heading: section.heading,
        body: '',
        sourceIds: section.sourceIds,
        selfCheckPassed: false,
        selfCheckNotes: '模型没有产出正文',
        ...(forced ? { forced: true } : {}),
      }
    }

    const check = await this.selfCheck(board, section, body, ctx, meter, signal)
    return {
      outlineSectionId: section.id,
      heading: section.heading,
      body,
      sourceIds: section.sourceIds,
      selfCheckPassed: check.passed,
      ...(check.notes.length === 0 ? {} : { selfCheckNotes: check.notes }),
      ...(forced ? { forced: true } : {}),
    }
  }

  /** 组装这一节的写作简报。 */
  private buildBrief(
    board: BlackboardView,
    documentTitle: string,
    thesis: string,
    section: OutlineSection,
    previousNotes: string | undefined,
  ): string {
    const parts: string[] = [
      `文档标题：${documentTitle}`,
      `全文主线：${thesis}`,
      `文档类型：${this.template.title}`,
      `写作要求：${this.template.writingGuidance}`,
      '',
      `**现在要写的是这一节**：${section.heading}`,
      `这一节要达成的目标：${section.goal}`,
    ]
    if (section.formatHints !== undefined && section.formatHints.length > 0) {
      parts.push(`这一节的特别要求：${section.formatHints.join('；')}`)
    }
    if (previousNotes !== undefined) {
      parts.push('', `上一稿自检未通过，原因是：${previousNotes}。请针对这一点重写。`)
    }

    // 其余小节的标题，帮助保持全局连贯
    const siblings = board.outline?.sections.filter((item) => item.id !== section.id) ?? []
    if (siblings.length > 0) {
      parts.push('', `全文其它小节（仅供保持连贯，不要写它们的内容）：${siblings.map((item) => item.heading).join('、')}`)
    }

    parts.push('', '本节可用的资料：')
    const sources = section.sourceIds
      .map((id) => board.sources.find((source) => source.id === id))
      .filter((source): source is NonNullable<typeof source> => source !== undefined)

    if (sources.length === 0) {
      parts.push('（本节没有指定来源。你可以用 list_sources 看语料库里有什么，或用 search_more 补搜。）')
    } else {
      for (const source of sources) {
        const body = source.status === 'full' ? source.text.slice(0, this.config.contextCharsPerSource) : (source.snippet ?? '')
        parts.push(`[${source.id}] ${source.title}`, `    ${body.replace(/\s+/g, ' ').slice(0, this.config.contextCharsPerSource)}`)
      }
    }

    return parts.join('\n')
  }

  /** 执行一次工具调用，返回给模型的观察结果。 */
  private async runTool(
    board: BlackboardView,
    call: ToolCall,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const args = (call.arguments ?? {}) as Record<string, unknown>
    try {
      switch (call.name) {
        case TOOL_SEARCH_MORE:
          return await this.toolSearchMore(board, asString(args['query']), ctx, meter, signal)
        case TOOL_READ_SOURCE:
          return this.toolReadSource(board, asString(args['sourceId']), asString(args['keyword']))
        case TOOL_LIST_SOURCES:
          return JSON.stringify(
            board.sources.map((source) => ({ id: source.id, title: source.title, status: source.status })),
          )
        case TOOL_REVISE_OUTLINE:
          return this.toolReviseOutline(board, asString(args['sectionId']), asString(args['heading']), asString(args['goal']))
        default:
          return JSON.stringify({ error: `未知工具：${call.name}` })
      }
    } catch (error) {
      // 工具失败只作为观察结果返回，不中断写作
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 补搜：搜索 + 抓取 + 过滤，并入语料库。 */
  private async toolSearchMore(
    board: BlackboardView,
    query: string,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (query.length === 0) return JSON.stringify({ error: 'query 不能为空' })

    const found = await ctx.search().search({ query, maxResults: this.config.searchMoreCandidates }, ctx, signal)
    const known = new Set(board.sources.map((source) => normalizeUrl(source.url)).filter((url): url is string => url !== undefined))
    const candidates: Candidate[] = []
    for (const hit of found.sources) {
      const url = normalizeUrl(hit.url)
      if (url === undefined || known.has(url)) continue
      candidates.push({
        url,
        title: hit.title ?? url,
        ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
        foundByQueries: [query],
      })
    }
    if (candidates.length === 0) return JSON.stringify({ added: [], note: `「${query}」没有找到新来源` })

    const collected = await collectDocuments(candidates, ctx, { concurrency: 4, startIndex: board.sources.length + 1 }, signal)
    const deduped = dedupe(collected.sources)
    const filtered = await filterIrrelevant(board.query, deduped, ctx, meter, { signal })
    board.addSources([...filtered.kept, ...filtered.dropped])

    return JSON.stringify({
      added: filtered.kept.map((source) => ({
        id: source.id,
        title: source.title,
        status: source.status,
        preview: (source.status === 'full' ? source.text : (source.snippet ?? '')).slice(0, 200),
      })),
      note: `新增 ${filtered.kept.length} 条来源`,
    })
  }

  /** 回读原文；给了关键词就只取包含关键词的段落。 */
  private toolReadSource(board: BlackboardView, sourceId: string, keyword: string): string {
    const source = board.sources.find((item) => item.id === sourceId)
    if (source === undefined) return JSON.stringify({ error: `找不到来源 ${sourceId}` })
    const body = source.status === 'full' ? source.text : (source.snippet ?? '')
    if (keyword.length === 0) {
      return JSON.stringify({ id: source.id, title: source.title, text: body.slice(0, this.config.readSourceChars) })
    }
    const paragraphs = body
      .split(/\n{2,}/)
      .filter((paragraph) => paragraph.includes(keyword))
      .slice(0, 8)
    return JSON.stringify({
      id: source.id,
      title: source.title,
      keyword,
      matches: paragraphs.length,
      text: paragraphs.join('\n\n').slice(0, this.config.readSourceChars),
    })
  }

  /** 修改大纲的某一节。 */
  private toolReviseOutline(board: BlackboardView, sectionId: string, heading: string, goal: string): string {
    const outline = board.outline
    if (outline === undefined) return JSON.stringify({ error: '还没有大纲' })
    const index = outline.sections.findIndex((section) => section.id === sectionId)
    if (index < 0) return JSON.stringify({ error: `找不到小节 ${sectionId}` })

    const sections = outline.sections.map((section, position) =>
      position === index
        ? {
            ...section,
            ...(heading.length === 0 ? {} : { heading }),
            ...(goal.length === 0 ? {} : { goal }),
          }
        : section,
    )
    board.setOutline({ ...outline, sections })
    return JSON.stringify({ ok: true, section: sections[index] })
  }

  /** 自检。 */
  private async selfCheck(
    board: BlackboardView,
    section: OutlineSection,
    body: string,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<{ passed: boolean; notes: string }> {
    const sources = section.sourceIds
      .map((id) => board.sources.find((source) => source.id === id))
      .filter((source): source is NonNullable<typeof source> => source !== undefined)
    const material = sources
      .map((source) => `[${source.id}] ${source.title}\n${(source.status === 'full' ? source.text : (source.snippet ?? '')).slice(0, 1500)}`)
      .join('\n\n')

    try {
      return await completeStructured(
        {
          system: SELF_CHECK_SYSTEM,
          user: [
            `文档类型：${this.template.title}`,
            `本节标题：${section.heading}`,
            `本节目标：${section.goal}`,
            section.formatHints === undefined ? '' : `本节特别要求：${section.formatHints.join('；')}`,
            '',
            '本节正文：',
            body.slice(0, 6000),
            '',
            '本节可用的资料：',
            material.length === 0 ? '（无）' : material,
          ].join('\n'),
          temperature: 0,
        },
        (value) => {
          if (typeof value !== 'object' || value === null) throw new Error('顶层不是对象')
          const record = value as Record<string, unknown>
          return { passed: record['passed'] === true, notes: asString(record['notes']) }
        },
        ctx,
        meter,
        '小节自检',
        signal,
      )
    } catch (error) {
      // 自检本身失败时按「未通过」处理并说明原因——不能因为检查器坏了就宣称通过
      ctx.log.warn(`自检调用失败：${error instanceof Error ? error.message : String(error)}`)
      return { passed: false, notes: `自检未能执行：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private requireMeter(): LlmMeter {
    if (this.meter === undefined) throw new Error('写作任务缺少用量计量器')
    return this.meter
  }
}
