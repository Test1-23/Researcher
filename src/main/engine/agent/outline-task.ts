/**
 * 大纲任务：产出一份能支撑起模板文档的大纲。
 *
 * 它的满足判据是**覆盖度**，不是「写完了」：
 *   · 模板要求的固定节都在
 *   · 可展开节至少展开了规定数量
 *   · 每一节都有足够的来源支撑
 *   · 地图上有主题、大纲却没安排 → 未满足
 *   · 自己提出的缺口请求还没被处理 → 未满足
 *
 * 支撑不足时它**自己不去搜索**，而是往黑板写一条缺口请求——
 * 搜索任务看到未处理的请求就会重新变得未满足。这就是两个任务协作的全部机制。
 */

import { isCancellation } from '../errors.ts'
import { asNumberArray, asString, isPlainObject } from '../json.ts'
import { expandableSlots, fixedSlots, type DocumentTemplate } from '../../../templates/index.ts'
import type { PluginContext } from '../types.ts'
import { completeStructured, type LlmMeter } from './llm.ts'
import type { AgentTask, BlackboardView, CorpusSource, MapNode, Outline, OutlineSection } from './types.ts'

/** 大纲任务配置。 */
export interface OutlineTaskConfig {
  /** 每节至少要多少条来源支撑。 */
  readonly minSupport: number
  /** 大纲里最多多少节（含固定节）。 */
  readonly maxSections: number
  /** 给模型的来源摘要每条截多长。 */
  readonly sourceDigestChars: number
}

/** 默认配置。 */
export const DEFAULT_OUTLINE_TASK: OutlineTaskConfig = {
  minSupport: 2,
  maxSections: 10,
  sourceDigestChars: 400,
}

const OUTLINE_SYSTEM = [
  '你根据一张「话题地图」为一份文档起草大纲。',
  '',
  '严格要求：',
  '1. 每一节的 sourceIndexes 必须来自给定的主题/来源编号，**不得编造**。',
  '2. 只能依据地图里已有的内容安排章节，地图没有覆盖的方面不要凭空写进大纲。',
  '3. 如果地图对某个必须的节支撑不足，照实标注该节 sources 为空——上层会据此去补资料，而不是让你硬编。',
  '4. 不要按「重要性」挑几个主题写，地图上的主题都要在结构里有位置。',
  '',
  '只输出 JSON：',
  '{"title":"文档标题","thesis":"一句话主线",',
  ' "sections":[{"slot":"模板里的 slot key","heading":"节标题","goal":"这一节要回答什么","sourceIndexes":[1,3]}],',
  ' "coverage":"对覆盖情况的简短说明"}',
].join('\n')

/** 大纲任务。 */
export class OutlineTask implements AgentTask {
  readonly name = 'outline'
  /** 护栏，不是目标。 */
  readonly safetyLimit = 12

  private lastBuiltFromRevision = -1
  private lastCoverage = ''
  private readonly template: DocumentTemplate
  private readonly config: OutlineTaskConfig
  private readonly meter: LlmMeter | undefined

  constructor(template: DocumentTemplate, config: OutlineTaskConfig = DEFAULT_OUTLINE_TASK, meter?: LlmMeter) {
    this.template = template
    this.config = config
    this.meter = meter
  }

  get templateId(): string {
    return this.template.id
  }

  /** 覆盖情况说明（写进报告）。 */
  get coverage(): string {
    return this.lastCoverage
  }

  isSatisfied(board: BlackboardView): boolean {
    // 自己提的缺口还没被搜索处理，就还没到收工的时候
    if (board.requests.some((request) => request.status === 'open')) return false

    const outline = board.outline
    if (outline === undefined) return false
    if (outline.builtFromRevision !== board.mapRevision && board.map.nodes.length > 0) {
      // 地图变了但大纲还没跟上
      return false
    }

    const problems = this.checkCoverage(board, outline)
    return problems.length === 0
  }

  explain(board: BlackboardView): string {
    const open = board.requests.filter((request) => request.status === 'open').length
    if (open > 0) return `还有 ${open} 条缺口请求待处理`
    if (board.outline === undefined) return '还没有大纲'
    if (board.outline.builtFromRevision !== board.mapRevision && board.map.nodes.length > 0) return '地图已更新，需要重排大纲'
    const problems = this.checkCoverage(board, board.outline)
    return problems.length === 0 ? '覆盖度达标' : problems.join('；')
  }

  async step(board: BlackboardView, ctx: PluginContext, signal?: AbortSignal): Promise<void> {
    const meter = this.requireMeter()

    if (board.map.nodes.length === 0) {
      // 地图还是空的：无事可做，等搜索任务先有产出
      board.record(this.name, 'note', '地图为空，等待搜索任务产出')
      return
    }

    const outline = await this.draft(board, ctx, meter, signal)
    board.setOutline(outline)
    this.lastBuiltFromRevision = board.revision

    // 支撑不足的节 → 写缺口请求（自己不搜）
    const problems = this.checkCoverage(board, outline)
    this.lastCoverage = `${outline.sections.length} 节，其中 ${problems.length} 处待补`
    board.record(this.name, 'step', `产出大纲：${outline.sections.length} 节，${problems.length} 处支撑不足`, {
      sections: outline.sections.length,
      problems,
    })
    ctx.events.emit({
      type: 'task:step',
      task: this.name,
      step: 1,
      message: `大纲 ${outline.sections.length} 节${problems.length === 0 ? '，覆盖度达标' : `，${problems.length} 处待补`}`,
    })

    problems.forEach((problem) => {
      board.addRequest({
        id: `gap-${problem.slot}-${board.revision}`,
        from: this.name,
        to: 'search',
        what: problem.what,
        why: problem.why,
        status: 'open',
      })
    })
  }

  /** 逐项检查覆盖度，返回所有问题（空数组表示达标）。 */
  checkCoverage(
    board: BlackboardView,
    outline: Outline,
  ): { readonly slot: string; readonly what: string; readonly why: string }[] {
    const problems: { slot: string; what: string; why: string }[] = []
    const bySlot = new Map<string, OutlineSection[]>()
    for (const section of outline.sections) {
      const list = bySlot.get(section.slot) ?? []
      list.push(section)
      bySlot.set(section.slot, list)
    }

    // ① 固定节必须在位
    for (const slot of fixedSlots(this.template)) {
      const sections = bySlot.get(slot.key) ?? []
      if (sections.length === 0) {
        problems.push({ slot: slot.key, what: `补充「${slot.heading}」所需的内容`, why: `模板要求的固定节「${slot.heading}」在大纲中缺失` })
        continue
      }
      const section = sections[0] as OutlineSection
      if (section.sourceIds.length < this.config.minSupport) {
        problems.push({
          slot: slot.key,
          what: `补充能支撑「${section.heading}」的来源`,
          why: `该节只有 ${section.sourceIds.length} 条来源，低于下限 ${this.config.minSupport}`,
        })
      }
    }

    // ② 可展开节至少展开规定数量
    for (const slot of expandableSlots(this.template)) {
      const sections = (bySlot.get(slot.key) ?? []).filter((section) => section.sourceIds.length >= this.config.minSupport)
      if (sections.length < this.template.minExpandedSections) {
        problems.push({
          slot: slot.key,
          what: `补充「${slot.heading}」所需的主题资料`,
          why: `「${slot.heading}」只有 ${sections.length} 节达到支撑下限，要求至少 ${this.template.minExpandedSections} 节`,
        })
      }
    }

    // ③ 地图上有主题、大纲却没安排
    const usedSourceIds = new Set(outline.sections.flatMap((section) => [...section.sourceIds]))
    const uncovered = board.map.nodes.filter(
      (node) => node.sourceIds.length > 0 && !node.sourceIds.some((id) => usedSourceIds.has(id)),
    )
    if (uncovered.length > 0) {
      problems.push({
        slot: 'coverage',
        what: `补充或覆盖这些主题：${uncovered.slice(0, 5).map((node) => node.topic).join('、')}`,
        why: `地图上有 ${uncovered.length} 个主题没有任何一节用到`,
      })
    }

    // ④ 超出节数上限
    if (outline.sections.length > this.config.maxSections) {
      problems.push({
        slot: 'length',
        what: '精简结构',
        why: `大纲有 ${outline.sections.length} 节，超过上限 ${this.config.maxSections}`,
      })
    }

    return problems
  }

  /** 起草/修订大纲。 */
  private async draft(
    board: BlackboardView,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<Outline> {
    const mapListing = describeMap(board.map, this.config.sourceDigestChars)
    const slotListing = this.template.slots
      .map((slot) =>
        `- slot=${slot.key}（${slot.kind === 'fixed' ? '固定节' : `可展开，至少 ${this.template.minExpandedSections} 节`}）`
        + ` 标题「${slot.heading}」目标：${slot.goal}`
        + (slot.hints === undefined ? '' : `\n    要求：${slot.hints.join('；')}`),
      )
      .join('\n')

    const previous = board.outline
    const previousListing = previous === undefined
      ? '（这是初稿）'
      : `上一版大纲：\n${previous.sections.map((section) => `- [${section.slot}] ${section.heading}（${section.sourceIds.length} 条来源）`).join('\n')}`

    const parsed = await completeStructured(
      {
        system: OUTLINE_SYSTEM,
        user: [
          `研究主题：${board.query}`,
          `文档类型：${this.template.title}——${this.template.description}`,
          `写作要求：${this.template.writingGuidance}`,
          '',
          '模板规定的位置：',
          slotListing,
          '',
          '话题地图：',
          mapListing,
          '',
          previousListing,
        ].join('\n'),
        temperature: 0.3,
      },
      (value) => {
        if (!isPlainObject(value)) throw new Error('顶层不是对象')
        const rawSections = Array.isArray(value['sections']) ? value['sections'] : []
        const knownSlots = new Set(this.template.slots.map((slot) => slot.key))
        const sections: OutlineSection[] = []

        for (const [index, raw] of rawSections.entries()) {
          if (!isPlainObject(raw)) continue
          const slot = asString(raw['slot'])
          const heading = asString(raw['heading'])
          if (heading.length === 0) continue
          if (slot.length > 0 && !knownSlots.has(slot)) continue // 模型编造的 slot 直接丢弃
          const sourceIds = asNumberArray(raw['sourceIndexes'])
            .map((position) => board.sources[position - 1]?.id)
            .filter((id): id is string => id !== undefined)
          const hints = this.template.slots.find((item) => item.key === slot)?.hints
          sections.push({
            id: `sec-${index + 1}`,
            slot: slot.length > 0 ? slot : (this.template.slots[0]?.key ?? 'body'),
            heading,
            goal: asString(raw['goal']),
            sourceIds,
            ...(hints === undefined ? {} : { formatHints: hints }),
          })
        }

        if (sections.length === 0) throw new Error('大纲没有任何可用的小节')
        return {
          title: asString(value['title']) || board.query,
          thesis: asString(value['thesis']),
          sections: sections.slice(0, this.config.maxSections),
          coverage: asString(value['coverage']),
        }
      },
      ctx,
      meter,
      '大纲起草',
      signal,
    )

    this.lastCoverage = parsed.coverage
    return {
      title: parsed.title,
      thesis: parsed.thesis,
      sections: parsed.sections,
      builtFromRevision: board.mapRevision,
    }
  }

  private requireMeter(): LlmMeter {
    if (this.meter === undefined) throw new Error('大纲任务缺少用量计量器')
    return this.meter
  }
}

/** 把地图压缩成给模型的清单（每条截断，避免上下文被单条来源吃满）。 */
export function describeMap(map: { nodes: readonly MapNode[]; gaps: readonly string[]; conflicts: readonly { topic: string; positions: readonly string[] }[] }, digestChars: number): string {
  const lines: string[] = []
  map.nodes.forEach((node, index) => {
    lines.push(`${index + 1}. 主题：${node.topic}`)
    if (node.summary.length > 0) lines.push(`   概述：${node.summary.slice(0, digestChars)}`)
    if (node.sourceIds.length > 0) lines.push(`   来源编号：${node.sourceIds.join('、')}`)
    for (const claim of node.claims.slice(0, 4)) {
      lines.push(`   - ${claim.text.slice(0, digestChars)}${claim.quote === undefined ? '' : `（原文：${claim.quote.slice(0, 120)}）`}`)
    }
  })
  if (map.conflicts.length > 0) {
    lines.push('', '存在分歧的问题：')
    for (const conflict of map.conflicts) {
      lines.push(`- ${conflict.topic}：${conflict.positions.join(' / ')}`)
    }
  }
  if (map.gaps.length > 0) {
    lines.push('', '尚未覆盖的方面：', ...map.gaps.map((gap) => `- ${gap}`))
  }
  return lines.length === 0 ? '（地图为空）' : lines.join('\n')
}

/** 从语料里取少量摘要，供写作任务用。 */
export function digestOf(source: CorpusSource, maxChars: number): string {
  const body = source.status === 'full' ? source.text : (source.snippet ?? '')
  return body.slice(0, maxChars)
}

/** 仅供类型引用。 */
export type { CorpusSource }
