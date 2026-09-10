/**
 * 黑板：任务之间唯一共享的状态。
 *
 * 两条结构性保证，靠「只暴露受控 mutator」实现，而不是靠约定：
 *   ① **地图只增不减**——任务无法替换 map，只能 merge 新节点；
 *      已有的 sourceIds / claims 只会被并集，不会被删。
 *   ② **每次变更都进 journal**——同时推进 revision，
 *      于是「这一轮黑板有没有变化」可被运行器观测，用于无进展检测。
 */

import type {
  BlackboardView,
  CorpusSource,
  DocumentSection,
  GapRequest,
  MapNode,
  Observation,
  Outline,
  TopicMap,
} from './types.ts'

/** 空地图。 */
export function emptyMap(): TopicMap {
  return { nodes: [], gaps: [], conflicts: [], builtFromRevision: -1 }
}

/** 黑板实现。 */
export class Blackboard implements BlackboardView {
  readonly query: string
  private revisionCounter = 0
  private sourceList: CorpusSource[] = []
  private mapValue: TopicMap = emptyMap()
  private outlineValue: Outline | undefined
  private documentList: DocumentSection[] = []
  private requestList: GapRequest[] = []
  private readonly journalList: Observation[] = []

  constructor(query: string) {
    this.query = query
  }

  get revision(): number {
    return this.revisionCounter
  }

  get sources(): readonly CorpusSource[] {
    return this.sourceList
  }

  get map(): TopicMap {
    return this.mapValue
  }

  get outline(): Outline | undefined {
    return this.outlineValue
  }

  get document(): readonly DocumentSection[] {
    return this.documentList
  }

  get requests(): readonly GapRequest[] {
    return this.requestList
  }

  get journal(): readonly Observation[] {
    return this.journalList
  }

  /** 追加来源；同一个 url 只保留第一次出现的。 */
  addSources(sources: readonly CorpusSource[]): number {
    const known = new Set(this.sourceList.map((source) => source.url))
    const fresh = sources.filter((source) => !known.has(source.url))
    if (fresh.length === 0) return 0
    this.sourceList = [...this.sourceList, ...fresh]
    this.bump()
    return fresh.length
  }

  /**
   * 合并地图节点：**只增不减**。
   *
   * 同 id 的节点会被并集（claims / sourceIds 取并），已有内容不会丢。
   * 返回值是新增节点数；**返回值 0 不代表一无所获**——并集可能只是加厚了已有节点，
   * 那时仍然要落盘并推进版本号，否则运行器会误判「本轮无进展」。
   */
  mergeMap(nodes: readonly MapNode[], gaps: readonly string[], conflicts: TopicMap['conflicts']): number {
    const byId = new Map(this.mapValue.nodes.map((item) => [item.id, item]))
    let added = 0
    let thickened = 0

    for (const incoming of nodes) {
      const existing = byId.get(incoming.id)
      if (existing === undefined) {
        byId.set(incoming.id, incoming)
        added += 1
        continue
      }
      const united = unionNode(existing, incoming)
      if (!sameNode(existing, united)) thickened += 1
      byId.set(incoming.id, united)
    }

    const gapSet = new Set(this.mapValue.gaps)
    for (const gap of gaps) gapSet.add(gap)
    const newGaps = gapSet.size - this.mapValue.gaps.length

    const mergedConflicts = mergeConflicts(this.mapValue.conflicts, conflicts)
    const conflictsGrew = mergedConflicts.length !== this.mapValue.conflicts.length
      || mergedConflicts.some((item, index) => item.positions.length !== (this.mapValue.conflicts[index]?.positions.length ?? -1))

    // 毫无变化时直接返回 0 且不推进版本号：这是运行器判定「无进展」的依据
    if (added === 0 && thickened === 0 && newGaps === 0 && !conflictsGrew) return 0

    this.mapValue = {
      nodes: [...byId.values()],
      gaps: [...gapSet],
      conflicts: mergedConflicts,
      builtFromRevision: this.revisionCounter,
    }
    this.bump()
    return added
  }

  setOutline(outline: Outline): void {
    this.outlineValue = outline
    this.bump()
  }

  writeSection(section: DocumentSection): void {
    const others = this.documentList.filter((item) => item.outlineSectionId !== section.outlineSectionId)
    this.documentList = [...others, section]
    this.bump()
  }

  addRequest(request: GapRequest): void {
    if (this.requestList.some((item) => item.id === request.id)) return
    this.requestList = [...this.requestList, request]
    this.bump()
  }

  resolveRequest(id: string, resolution: string): void {
    const target = this.requestList.find((item) => item.id === id)
    if (target === undefined || target.status !== 'open') return
    this.requestList = this.requestList.map((item) =>
      item.id === id ? { ...item, status: 'resolved' as const, resolution } : item,
    )
    this.bump()
  }

  record(
    task: string,
    kind: Observation['kind'],
    message: string,
    detail?: Readonly<Record<string, unknown>>,
  ): void {
    this.journalList.push({
      at: new Date().toISOString(),
      task,
      kind,
      message,
      ...(detail === undefined ? {} : { detail }),
    })
    this.bump()
  }

  /** 以追加观测的方式推进版本号：让「什么都没做」本身也是可观测的。 */
  private bump(): void {
    this.revisionCounter += 1
  }

  /** 未处理的缺口请求。 */
  openRequests(): readonly GapRequest[] {
    return this.requestList.filter((item) => item.status === 'open')
  }

  /** 取一条来源。 */
  sourceById(id: string): CorpusSource | undefined {
    return this.sourceList.find((source) => source.id === id)
  }

  /** 导出为可持久化的纯数据。 */
  toJSON(): {
    query: string
    sources: readonly CorpusSource[]
    map: TopicMap
    outline: Outline | undefined
    document: readonly DocumentSection[]
    requests: readonly GapRequest[]
  } {
    return {
      query: this.query,
      sources: this.sourceList,
      map: this.mapValue,
      outline: this.outlineValue,
      document: this.documentList,
      requests: this.requestList,
    }
  }

  /** 从持久化数据恢复（按话题复用）。 */
  static fromJSON(data: ReturnType<Blackboard['toJSON']>): Blackboard {
    const board = new Blackboard(data.query)
    board.sourceList = [...data.sources]
    board.mapValue = data.map
    board.outlineValue = data.outline
    board.documentList = [...data.document]
    board.requestList = [...data.requests]
    board.bump()
    return board
  }
}

/** 两个节点在「只增不减」意义上是否等价。 */
function sameNode(a: MapNode, b: MapNode): boolean {
  return a.sourceIds.length === b.sourceIds.length
    && a.claims.length === b.claims.length
    && a.summary === b.summary
}

/** 两个同 id 节点的并集：来源与论断都只增不减。 */
function unionNode(existing: MapNode, incoming: MapNode): MapNode {
  const sourceIds = [...new Set([...existing.sourceIds, ...incoming.sourceIds])]
  const claims: Claim[] = [...existing.claims]
  for (const claim of incoming.claims) {
    if (!claims.some((item) => item.text === claim.text)) claims.push(claim)
  }
  return {
    ...existing,
    sourceIds,
    claims,
    // 摘要与主题名取更长的那个：通常是信息更多的版本
    summary: incoming.summary.length > existing.summary.length ? incoming.summary : existing.summary,
  }
}

/** 合并冲突记录，同一个主题下的不同说法取并集。 */
function mergeConflicts(
  existing: TopicMap['conflicts'],
  incoming: TopicMap['conflicts'],
): TopicMap['conflicts'] {
  const byTopic = new Map(existing.map((item) => [item.topic, new Set(item.positions)]))
  for (const item of incoming) {
    const set = byTopic.get(item.topic) ?? new Set<string>()
    for (const position of item.positions) set.add(position)
    byTopic.set(item.topic, set)
  }
  return [...byTopic.entries()].map(([topic, positions]) => ({ topic, positions: [...positions] }))
}

/** 仅为类型引用。 */
type Claim = MapNode['claims'][number]
