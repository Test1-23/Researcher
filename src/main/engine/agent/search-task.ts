/**
 * 搜索任务：让地图对这个话题足够充实。
 *
 * **终止条件是观测出来的，不是步数配出来的**：连续若干轮「新内容对地图的贡献率」
 * 低于阈值即视为饱和。它还会被大纲任务写的缺口请求**重新激活**——
 * 这就是任务之间协作的方式（它自己不去读大纲，只读黑板上的请求）。
 *
 * 每轮的查询由「地图当前缺什么」决定（缺口请求 → 盲区 → 最薄弱主题），
 * 而不是执行一份预先生成的查询清单；因此它会自然地转向。
 */

import { ResearcherError, isCancellation, throwIfAborted } from '../errors.ts'
import { asNumberArray, asString, asStringArray, isPlainObject } from '../json.ts'
import type { PluginContext } from '../types.ts'
import { collectDocuments, type Candidate } from './collect.ts'
import { dedupe, filterIrrelevant, normalizeUrl } from './filter.ts'
import { completeStructured, type LlmMeter } from './llm.ts'
import type { AgentTask, BlackboardView, Claim, CorpusSource, MapNode, TopicMap } from './types.ts'

/** 搜索任务配置。 */
export interface SearchTaskConfig {
  /** 每次查询取多少条结果。 */
  readonly candidatesPerQuery: number
  /** 抓取并发。 */
  readonly concurrency: number
  /** 第一轮生成的互补查询数量。 */
  readonly queryFanout: number
  /** 连续多少轮贡献率低于阈值即判定饱和。 */
  readonly saturationWindow: number
  /** 贡献率阈值（新增地图内容 / 本轮并入文档数）。 */
  readonly saturationThreshold: number
  /** 地图归纳时一次送进模型的文档数上限。 */
  readonly integrateBatchSize: number
}

/** 默认配置。阈值可调，步数不可调。 */
export const DEFAULT_SEARCH_TASK: SearchTaskConfig = {
  candidatesPerQuery: 30,
  concurrency: 6,
  queryFanout: 5,
  saturationWindow: 2,
  saturationThreshold: 0.3,
  integrateBatchSize: 6,
}

/** 一轮的贡献观测。 */
export interface ContributionRecord {
  readonly round: number
  readonly query: string
  readonly origin: 'expansion' | 'gap' | 'map-weakness'
  readonly candidates: number
  readonly freshSources: number
  readonly documents: number
  readonly newNodes: number
  readonly newClaims: number
  readonly contribution: number
}

/** 稳定 hash：让同一主题在不同轮次产生同一个节点 id，从而被并集而不是重复。 */
export function topicId(topic: string): string {
  const normalized = topic.trim().toLowerCase().replace(/\s+/g, '')
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `n-${(hash >>> 0).toString(36)}`
}

/** 查询扩展：第一轮把主题拆成互补的子查询。 */
const EXPAND_SYSTEM = [
  '你把一个研究主题拆成若干**互补**的搜索查询，目标是覆盖这个话题的不同方面。',
  '要求：',
  '1. 每个查询针对一个不同角度（例如：概念与原理、现状与数据、限制与争议、实践与案例、替代方案对比）。',
  '2. 中英文各占一部分——中文资料贴近本地实践，英文资料通常更全更深。',
  '3. 查询要具体，不要直接把主题原样重复一遍。',
  '只输出 JSON：{"queries": ["查询1", "查询2"]}',
].join('\n')

/** 缺口/盲区驱动的查询生成。 */
const TARGETED_SYSTEM = [
  '你要为一个研究任务生成**下一个**搜索查询。',
  '用户会告诉你当前已知的主题结构与明显缺口。',
  '要求：',
  '1. 查询必须针对指出的缺口或最薄弱的方面，不要重复已有的主题。',
  '2. 查询要具体、可直接用于搜索引擎。',
  '只输出 JSON：{"query": "查询"}',
].join('\n')

/** 地图归纳。 */
const INTEGRATE_SYSTEM = [
  '你把资料归纳成「话题地图」的节点。',
  '',
  '严格要求：',
  '1. 只依据给定资料，不得引入资料之外的知识。',
  '2. 一个节点是话题的**一个方面/主题**，不是一篇文档的摘要。多篇资料讲同一方面时应合并为同一个节点。',
  '3. 每条论断尽量附上**逐字原文片段**作为 quote；找不到合适原文就省略 quote，不要改写后冒充原文。',
  '4. 不要丢弃资料：如果某篇资料提供了独特信息，它必须体现在某个节点里。',
  '5. 另外指出：尚未覆盖的方面（gaps）、同一问题上的不同或冲突说法（conflicts）。',
  '',
  '只输出 JSON：',
  '{"nodes":[{"topic":"方面名","summary":"这个方面讲了什么","claims":[{"text":"论断","quote":"原文片段","sourceIndexes":[1,3]}],"sourceIndexes":[1,3]}],',
  ' "gaps":["还没覆盖的方面"],',
  ' "conflicts":[{"topic":"有分歧的问题","positions":["说法一（来源1）","说法二（来源2）"]}]}',
].join('\n')

/** 搜索任务。 */
export class SearchTask implements AgentTask {
  readonly name = 'search'

  /** 护栏：远超正常所需的步数，只为防死循环。真正决定结束的是饱和判据。 */
  readonly safetyLimit = 60

  private readonly rounds: ContributionRecord[] = []
  private pendingQueries: string[] = []
  private expanded = false

  constructor(
    private readonly config: SearchTaskConfig = DEFAULT_SEARCH_TASK,
    private readonly meter?: LlmMeter,
  ) {}

  /** 本轮观测记录（写进 report / provenance）。 */
  get history(): readonly ContributionRecord[] {
    return this.rounds
  }

  isSatisfied(board: BlackboardView): boolean {
    // 大纲提出的缺口没处理完，就还没到收工的时候
    if (board.requests.some((request) => request.status === 'open')) return false
    return this.isSaturated()
  }

  explain(board: BlackboardView): string {
    const open = board.requests.filter((request) => request.status === 'open').length
    if (open > 0) return `还有 ${open} 条缺口请求待处理`
    if (this.rounds.length < this.config.saturationWindow) {
      return `还需至少 ${this.config.saturationWindow - this.rounds.length} 轮才能判断是否饱和`
    }
    const recent = this.recentRates()
    return `最近 ${recent.length} 轮贡献率 ${recent.map((rate) => rate.toFixed(2)).join(' / ')}，阈值 ${this.config.saturationThreshold}`
  }

  async step(board: BlackboardView, ctx: PluginContext, signal?: AbortSignal): Promise<void> {
    const meter = this.requireMeter()
    throwIfAborted(signal)

    // ① 决定这一轮查什么
    const plan = await this.planQuery(board, ctx, meter, signal)

    // ② 搜索
    const found = await ctx.search().search(
      { query: plan.query, maxResults: this.config.candidatesPerQuery },
      ctx,
      signal,
    )

    // ③ 转候选，排除已知 URL（黑板是唯一事实源）
    const known = new Set(
      board.sources.map((source) => normalizeUrl(source.url)).filter((url): url is string => url !== undefined),
    )
    const candidates: Candidate[] = []
    for (const source of found.sources) {
      const url = normalizeUrl(source.url)
      if (url === undefined || known.has(url)) continue
      candidates.push({
        url,
        title: source.title ?? url,
        ...(source.snippet === undefined ? {} : { snippet: source.snippet }),
        foundByQueries: [plan.query],
      })
    }

    if (candidates.length === 0) {
      this.recordRound(plan, 0, 0, 0, 0)
      ctx.events.emit({ type: 'task:step', task: this.name, step: this.rounds.length, message: `「${plan.query}」没有带来新资料` })
      return
    }

    // ④ 抓取 + 抽取
    const collected = await collectDocuments(
      candidates,
      ctx,
      { concurrency: this.config.concurrency, startIndex: board.sources.length + 1 },
      signal,
    )

    // ⑤ 去重（确定性）
    const deduped = dedupe(collected.sources)
    const duplicates = deduped.filter((source) => source.relevance === 'duplicate')

    // ⑥ 只淘汰无关（不许择优）
    const filtered = await filterIrrelevant(board.query, deduped, ctx, meter, { signal })

    // ⑦ 并入黑板——**必须走这一步**：语料库在黑板里，后面的归纳、大纲、写作都从那里读
    board.addSources([...filtered.kept, ...filtered.dropped, ...duplicates])

    // ⑧ 归纳进地图
    const integrated = await this.integrate(board, filtered.kept, ctx, meter, signal)
    const newNodes = board.mergeMap(integrated.nodes, integrated.gaps, integrated.conflicts)

    // ⑨ 缺口请求得到回应后结清
    if (plan.origin === 'gap' && plan.requestId !== undefined) {
      board.resolveRequest(plan.requestId, `已针对缺口执行查询「${plan.query}」`)
    }

    const documents = filtered.kept.filter((source) => source.status === 'full').length
    this.recordRound(plan, candidates.length, filtered.kept.length, documents, newNodes, integrated.newClaims)

    board.record(
      this.name,
      'step',
      `「${plan.query}」→ 新增 ${freshSummary(filtered.kept.length, newNodes, integrated.newClaims)}`,
      {
        query: plan.query,
        origin: plan.origin,
        candidates: candidates.length,
        kept: filtered.kept.length,
        duplicates: duplicates.length,
        irrelevant: filtered.dropped.filter((source) => source.relevance === 'irrelevant').length,
        documents,
        newNodes,
        newClaims: integrated.newClaims,
      },
    )
    ctx.events.emit({
      type: 'task:step',
      task: this.name,
      step: this.rounds.length,
      message: `「${plan.query}」→ ${freshSummary(filtered.kept.length, newNodes, integrated.newClaims)}`,
    })
  }

  /** 是否已经饱和。 */
  private isSaturated(): boolean {
    if (this.rounds.length < this.config.saturationWindow) return false
    return this.recentRates().every((rate) => rate < this.config.saturationThreshold)
  }

  private recentRates(): number[] {
    return this.rounds.slice(-this.config.saturationWindow).map((record) => record.contribution)
  }

  /** 决定这一轮的查询：缺口请求 > 预生成的互补查询 > 地图最薄弱处。 */
  private async planQuery(
    board: BlackboardView,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<{ query: string; origin: ContributionRecord['origin']; requestId?: string }> {
    const open = board.requests.find((request) => request.status === 'open')
    if (open !== undefined) {
      const query = await this.generateQuery(
        board.query,
        `存在的缺口：${open.what}\n为什么需要：${open.why}`,
        ctx,
        meter,
        signal,
      )
      return { query, origin: 'gap', requestId: open.id }
    }

    if (!this.expanded) {
      this.expanded = true
      this.pendingQueries = await this.expandQueries(board, ctx, meter, signal)
    }

    const next = this.pendingQueries.shift()
    if (next !== undefined) return { query: next, origin: 'expansion' }

    // 预生成查询用完了但还没饱和：针对地图当前最薄弱处再生成一条
    const weakened = describeMapWeakness(board)
    const query = await this.generateQuery(board.query, weakened, ctx, meter, signal)
    return { query, origin: 'map-weakness' }
  }

  private async expandQueries(
    board: BlackboardView,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    try {
      return await completeStructured(
        {
          system: EXPAND_SYSTEM,
          user: `研究主题：${board.query}\n请给出 ${this.config.queryFanout} 个互补查询。`,
          temperature: 0.3,
        },
        (value) => {
          if (!isPlainObject(value)) throw new Error('顶层不是对象')
          const queries = asStringArray(value['queries'])
          if (queries.length === 0) throw new Error('没有 queries')
          return queries
        },
        ctx,
        meter,
        '查询扩展',
        signal,
      )
    } catch (error) {
      if (isCancellation(error)) throw error
      // 扩展失败就退回主题本身，绝不因此不搜
      ctx.log.warn(`查询扩展失败，改用主题本身作为查询：${error instanceof Error ? error.message : String(error)}`)
      return [board.query]
    }
  }

  private async generateQuery(
    topic: string,
    context: string,
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    try {
      return await completeStructured(
        {
          system: TARGETED_SYSTEM,
          user: `研究主题：${topic}\n\n${context}`,
          temperature: 0.3,
        },
        (value) => {
          if (!isPlainObject(value)) throw new Error('顶层不是对象')
          const query = asString(value['query'])
          if (query.length === 0) throw new Error('没有 query')
          return query
        },
        ctx,
        meter,
        '缺口查询',
        signal,
      )
    } catch (error) {
      if (isCancellation(error)) throw error
      throw new ResearcherError(
        `无法为缺口生成查询：${error instanceof Error ? error.message : String(error)}`,
        'LLM_BAD_JSON',
        { cause: error },
      )
    }
  }

  /** 把新资料归纳成地图节点。 */
  private async integrate(
    board: BlackboardView,
    fresh: readonly CorpusSource[],
    ctx: PluginContext,
    meter: LlmMeter,
    signal: AbortSignal | undefined,
  ): Promise<{ nodes: MapNode[]; gaps: string[]; conflicts: TopicMap['conflicts']; newClaims: number }> {
    const usable = fresh.filter((source) => source.status === 'full' || (source.snippet ?? '').length > 0)
    if (usable.length === 0) return { nodes: [], gaps: [], conflicts: [], newClaims: 0 }

    const nodes: MapNode[] = []
    const gaps: string[] = []
    const conflicts: { topic: string; positions: string[] }[] = []
    let newClaims = 0

    for (let start = 0; start < usable.length; start += this.config.integrateBatchSize) {
      const batch = usable.slice(start, start + this.config.integrateBatchSize)
      const listing = batch
        .map((source, index) => {
          const body = source.status === 'full' ? source.text.slice(0, 3000) : (source.snippet ?? '')
          return `[${index + 1}] 标题：${source.title}\n    正文：${body}`
        })
        .join('\n\n')

      try {
        const verdict = await completeStructured(
          {
            system: INTEGRATE_SYSTEM,
            user: `研究主题：${board.query}\n\n资料：\n${listing}`,
            temperature: 0.2,
          },
          (value) => {
            if (!isPlainObject(value)) throw new Error('顶层不是对象')
            const rawNodes = Array.isArray(value['nodes']) ? value['nodes'] : []
            const parsed: MapNode[] = []
            let claims = 0

            for (const raw of rawNodes) {
              if (!isPlainObject(raw)) continue
              const topic = asString(raw['topic'])
              if (topic.length === 0) continue
              const sourceIds = resolveSourceIds(asNumberArray(raw['sourceIndexes']), batch)
              const claimList: Claim[] = []
              const rawClaims = Array.isArray(raw['claims']) ? raw['claims'] : []
              for (const rawClaim of rawClaims) {
                if (!isPlainObject(rawClaim)) continue
                const text = asString(rawClaim['text'])
                if (text.length === 0) continue
                const quote = asString(rawClaim['quote'])
                const claimSources = resolveSourceIds(asNumberArray(rawClaim['sourceIndexes']), batch)
                claimList.push({
                  text,
                  ...(quote.length === 0 ? {} : { quote }),
                  sourceIds: claimSources.length > 0 ? claimSources : sourceIds,
                })
                claims += 1
              }
              parsed.push({
                id: topicId(topic),
                topic,
                summary: asString(raw['summary']),
                claims: claimList,
                sourceIds,
                level: 1,
              })
            }

            const rawConflicts = Array.isArray(value['conflicts']) ? value['conflicts'] : []
            const parsedConflicts = rawConflicts
              .filter(isPlainObject)
              .map((item) => ({ topic: asString(item['topic']), positions: asStringArray(item['positions']) }))
              .filter((item) => item.topic.length > 0 && item.positions.length > 0)

            return { nodes: parsed, gaps: asStringArray(value['gaps']), conflicts: parsedConflicts, claims }
          },
          ctx,
          meter,
          '地图归纳',
          signal,
        )

        nodes.push(...verdict.nodes)
        gaps.push(...verdict.gaps)
        conflicts.push(...verdict.conflicts)
        newClaims += verdict.claims
      } catch (error) {
        if (isCancellation(error)) throw error
        // 归纳失败不能让这一轮的资料白抓：记一条观测，资料本身仍留在语料库里
        ctx.log.warn(`地图归纳失败（本批 ${batch.length} 篇资料仍保留在语料库）：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return { nodes, gaps, conflicts, newClaims }
  }

  private recordRound(
    plan: { query: string; origin: ContributionRecord['origin'] },
    candidates: number,
    freshSources: number,
    documents: number,
    newNodes: number,
    newClaims = 0,
  ): void {
    const contribution = (newNodes + newClaims) / Math.max(1, documents)
    this.rounds.push({
      round: this.rounds.length + 1,
      query: plan.query,
      origin: plan.origin,
      candidates,
      freshSources,
      documents,
      newNodes,
      newClaims,
      contribution,
    })
  }

  private requireMeter(): LlmMeter {
    if (this.meter === undefined) {
      throw new ResearcherError('搜索任务缺少用量计量器', 'INTERNAL')
    }
    return this.meter
  }
}

/** 把模型给的 1-based 下标解析成真实来源 id。 */
function resolveSourceIds(indexes: readonly number[], batch: readonly CorpusSource[]): string[] {
  const ids: string[] = []
  for (const index of indexes) {
    const source = batch[index - 1]
    if (source !== undefined && !ids.includes(source.id)) ids.push(source.id)
  }
  return ids
}

/** 描述地图当前最薄弱的地方，供生成下一条查询。 */
export function describeMapWeakness(board: BlackboardView): string {
  const nodes = board.map.nodes
  const lines: string[] = ['当前已知的主题结构：']
  if (nodes.length === 0) {
    lines.push('（还没有任何主题节点）')
  } else {
    for (const node of nodes.slice(0, 20)) {
      lines.push(`- ${node.topic}（${node.sourceIds.length} 条来源，${node.claims.length} 条论断）`)
    }
  }
  if (board.map.gaps.length > 0) {
    lines.push('', '已知尚未覆盖的方面：', ...board.map.gaps.map((gap) => `- ${gap}`))
  }
  lines.push('', '请给出一个能补上最薄弱处的搜索查询。')
  return lines.join('\n')
}

/** 一句话概括本轮收获。 */
function freshSummary(kept: number, newNodes: number, newClaims: number): string {
  if (newNodes === 0 && newClaims === 0) return `并入 ${kept} 篇资料，但地图没有新增内容`
  return `并入 ${kept} 篇资料，地图新增 ${newNodes} 个主题 / ${newClaims} 条论断`
}
