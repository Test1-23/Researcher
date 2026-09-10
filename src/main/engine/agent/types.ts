/**
 * 自主任务的领域类型。
 *
 * 设计前提：**任务是「目标 + 自己观测得到的终止条件」，不是步骤序列**。
 * 任务之间不通过顺序连接，只通过黑板互相影响。
 */

import type { PluginContext } from '../types.ts'

/** 语料库里的一条来源。 */
export interface CorpusSource {
  readonly id: string
  readonly url: string
  readonly title: string
  /** 抽取后的正文；仅摘要来源为空串。 */
  readonly text: string
  /** `snippet-only` 表示抓取或抽取失败，只拿到搜索结果里的摘要。 */
  readonly status: 'full' | 'snippet-only'
  readonly snippet?: string
  /** 实际使用的抽取实现，进入 provenance。 */
  readonly extraction?: string
  readonly extractionFallbackReason?: string
  /** 由哪些查询找到的（影响后续判断，也便于回溯）。 */
  readonly foundByQueries: readonly string[]
  readonly fetchedAt: string
  /** 过滤判定结果。 */
  readonly relevance: 'kept' | 'duplicate' | 'irrelevant'
  /** 被判为重复或无关时的原因。 */
  readonly filterReason?: string
}

/** 地图里的一条论断。 */
export interface Claim {
  /** 转述的说法。 */
  readonly text: string
  /** 逐字原文片段（保真）。 */
  readonly quote?: string
  readonly sourceIds: readonly string[]
}

/** 地图上的一个主题节点。 */
export interface MapNode {
  readonly id: string
  readonly topic: string
  readonly summary: string
  readonly claims: readonly Claim[]
  /** 支撑该主题的来源，**只增不减**。 */
  readonly sourceIds: readonly string[]
  readonly parentId?: string
  readonly level: number
}

/** 主题地图：话题的全景结构。 */
export interface TopicMap {
  readonly nodes: readonly MapNode[]
  /** 尚未覆盖的方面。 */
  readonly gaps: readonly string[]
  /** 同一问题上的不同/冲突说法。 */
  readonly conflicts: readonly { readonly topic: string; readonly positions: readonly string[] }[]
  /** 地图构建到哪个黑板版本为止，避免重复劳动。 */
  readonly builtFromRevision: number
}

/** 大纲的一节。 */
export interface OutlineSection {
  readonly id: string
  /** 对应模板里的 slot key——校验覆盖度靠它，而不是靠标题文字。 */
  readonly slot: string
  readonly heading: string
  /** 这一节要回答什么。 */
  readonly goal: string
  /** 本节依据的来源。 */
  readonly sourceIds: readonly string[]
  /** 模板给出的本节特殊要求（如「要包含例题」）。 */
  readonly formatHints?: readonly string[]
}

/** 大纲。 */
export interface Outline {
  readonly title: string
  /** 一句话主线。 */
  readonly thesis: string
  readonly sections: readonly OutlineSection[]
  /** 依据哪个黑板版本产出。 */
  readonly builtFromRevision: number
}

/** 已写出的一节。 */
export interface DocumentSection {
  readonly outlineSectionId: string
  readonly heading: string
  readonly body: string
  readonly sourceIds: readonly string[]
  /** 该节是否通过自检。 */
  readonly selfCheckPassed: boolean
  /** 没通过时的原因。 */
  readonly selfCheckNotes?: string
  /** 工具步数耗尽后强制收稿。 */
  readonly forced?: boolean
}

/** 缺口请求：任务之间唯一的协作通道。 */
export interface GapRequest {
  readonly id: string
  /** 谁提的。 */
  readonly from: string
  /** 希望谁来处理（一般是搜索任务）。 */
  readonly to: string
  /** 缺什么，用自然语言说清。 */
  readonly what: string
  /** 为什么需要（通常是某一节支撑不足）。 */
  readonly why: string
  readonly status: 'open' | 'resolved' | 'abandoned'
  readonly resolution?: string
}

/** 一次观测：记进 journal，可审计、可回放。 */
export interface Observation {
  readonly at: string
  readonly task: string
  readonly kind: 'step' | 'satisfied' | 'unsatisfied' | 'stall' | 'exhausted' | 'note'
  /** 人可读的一句话。 */
  readonly message: string
  /** 结构化细节，便于界面展示与调试。 */
  readonly detail?: Readonly<Record<string, unknown>>
}

/**
 * 一个自主任务。
 *
 * `isSatisfied` 是**任务自己观测黑板得出的判断**，不是外部给的步数目标；
 * `safetyLimit` 只是防止死循环的护栏，触顶时会如实报告「条件未满足就停了」。
 */
export interface AgentTask {
  readonly name: string
  /** 我现在算完成了吗？ */
  isSatisfied(board: BlackboardView): boolean
  /** 走一步：观察 → 行动 → 更新黑板。 */
  step(board: BlackboardView, ctx: PluginContext, signal?: AbortSignal): Promise<void>
  /** 安全护栏（步数），**不是目标**。 */
  readonly safetyLimit: number
  /** 为什么满足/不满足，给人看的一句话。 */
  explain(board: BlackboardView): string
}

/**
 * 任务看到的黑板接口。
 *
 * 只暴露读与受控的写：任务不能直接把 `map` 换掉，只能通过 mutator 追加，
 * 这样「地图只增不减」与「每次变更都进 journal」是结构上保证的。
 */
export interface BlackboardView {
  readonly query: string
  readonly revision: number
  /**
   * **只在地图/语料真的变化时**递增的版本号。
   *
   * 与 `revision` 分开是必要的：`revision` 连记一条观测都会推进，
   * 若用它判断「大纲是否过期」，大纲一写完就会立刻被判定为过期。
   */
  readonly mapRevision: number
  readonly sources: readonly CorpusSource[]
  readonly map: TopicMap
  readonly outline: Outline | undefined
  readonly document: readonly DocumentSection[]
  readonly requests: readonly GapRequest[]
  readonly journal: readonly Observation[]

  /** 追加来源，返回真正新增的数量。 */
  addSources(sources: readonly CorpusSource[]): number
  /** 合并地图节点（只增不减），返回新增节点数。 */
  mergeMap(nodes: readonly MapNode[], gaps: readonly string[], conflicts: TopicMap['conflicts']): number
  setOutline(outline: Outline): void
  writeSection(section: DocumentSection): void
  addRequest(request: GapRequest): void
  resolveRequest(id: string, resolution: string): void
  /** 记一条观测（不改变数据，但推进版本号以便被其他任务看到）。 */
  record(task: string, kind: Observation['kind'], message: string, detail?: Readonly<Record<string, unknown>>): void
}
