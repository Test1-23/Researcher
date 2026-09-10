/**
 * 代理式主流程：把黑板、任务、运行器装配起来，并产出报告。
 *
 * 它不做任何「阶段编排」——那是运行器的事。这里只负责：
 *   ① 按配置造出三个任务
 *   ② 跑到不动点
 *   ③ 把黑板上的最终状态转成 `Report`（**契约与其它主流程完全一致**，
 *      因此三个输出插件一行都不用改）
 *
 * 没有大模型时 `available()` 为假，内核会自动降到配置的备用主流程。
 */

import { ENGINE_VERSION } from '../../main/engine/config.ts'
import { isCancellation, ResearcherError, throwIfAborted } from '../../main/engine/errors.ts'
import { renderOutputs, selectOutputs } from '../../main/engine/output.ts'
import { definePlugin } from '../../main/engine/registry.ts'
import { join } from 'node:path'
import { templateById } from '../../templates/index.ts'
import { Blackboard } from '../../main/engine/agent/blackboard.ts'
import { LlmMeter } from '../../main/engine/agent/llm.ts'
import { OutlineTask } from '../../main/engine/agent/outline-task.ts'
import { runToFixedPoint, type RunOutcome } from '../../main/engine/agent/runner.ts'
import { SearchTask } from '../../main/engine/agent/search-task.ts'
import { FileTopicStore, type ReuseInfo } from '../../main/engine/agent/topic-store.ts'
import { WritingTask } from '../../main/engine/agent/writing-task.ts'
import type {
  AgenticProvenance,
  AvailabilityContext,
  FetchedDocument,
  FetchFailure,
  OrganizeOutput,
  Pipeline,
  PluginContext,
  PluginManifest,
  Provenance,
  Report,
  ReportMaterials,
  ReportSection,
  RunInput,
  SearchSource,
} from '../../main/engine/types.ts'

/** 代理式主流程。 */
export class ResearchPipeline implements Pipeline {
  readonly id = 'pipeline-research'
  readonly kind = 'pipeline' as const

  /** 需要大模型：整条流程的判断、归纳、写作都依赖它。 */
  available(ctx: AvailabilityContext): boolean {
    return ctx.isAvailable('provider')
  }

  async run(input: RunInput, ctx: PluginContext, signal?: AbortSignal): Promise<Report> {
    const startedAt = new Date()
    const config = ctx.config.all()
    const agentic = config.agentic
    const template = templateById(config.output.template)
    const meter = new LlmMeter()

    throwIfAborted(signal)

    // 按话题复用：同一话题已有语料与地图时读回来，搜索任务会因为
    // 「新增内容对地图贡献很低」而很快饱和——复用走的就是原本那套机制。
    const topics = new FileTopicStore(join(ctx.dataRoot, 'topics'))
    let board = new Blackboard(input.query)
    let reuse: ReuseInfo | undefined
    if (agentic.reuseTopicMaps) {
      const loaded = await topics.load(input.query)
      if (loaded !== undefined) {
        board = loaded.board
        reuse = loaded.info
        ctx.log.info(
          `复用话题缓存：${reuse.sources} 条来源、${reuse.mapNodes} 个主题节点（更新于 ${reuse.updatedAt}）`,
        )
      }
    }

    const searchTask = new SearchTask(
      {
        candidatesPerQuery: agentic.candidatesPerQuery,
        concurrency: agentic.fetchConcurrency,
        queryFanout: agentic.queryFanout,
        saturationWindow: agentic.saturationWindow,
        saturationThreshold: agentic.saturationThreshold,
        integrateBatchSize: 6,
      },
      meter,
    )
    const outlineTask = new OutlineTask(
      template,
      { minSupport: agentic.minSupport, maxSections: agentic.maxSections, sourceDigestChars: 400 },
      meter,
    )
    const writingTask = new WritingTask(
      template,
      {
        maxToolSteps: agentic.maxToolSteps,
        maxRewriteAttempts: agentic.maxRewriteAttempts,
        readSourceChars: 4000,
        searchMoreCandidates: 12,
        contextCharsPerSource: 3000,
      },
      meter,
    )

    ctx.events.emit({ type: 'stage:start', stage: 'research' })
    ctx.log.info(`代理式调研开始：模板「${template.title}」，${agentic.queryFanout} 个互补查询起步`)

    let outcome: RunOutcome
    try {
      outcome = await runToFixedPoint([searchTask, outlineTask, writingTask], board, ctx, {
        globalLimit: agentic.globalIterations,
        emit: (event) => ctx.events.emit(event),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (isCancellation(error)) throw error
      throw new ResearcherError(
        `代理式调研中断：${error instanceof Error ? error.message : String(error)}`,
        'INTERNAL',
        { cause: error },
      )
    }

    const outline = board.outline
    if (outline === undefined || board.document.length === 0) {
      throw new ResearcherError(
        `调研没有产出可用内容（${outcome.message}）。已收集 ${board.sources.length} 条来源、`
        + `${board.map.nodes.length} 个主题节点，但没有形成大纲或正文。`
        + '可以尝试放宽 agentic.minSupport，或检查搜索是否可用。',
        'INTERNAL',
      )
    }

    ctx.events.emit({
      type: 'stage:done',
      stage: 'research',
      summary: `${outcome.message}；地图 ${board.map.nodes.length} 个主题，正文 ${board.document.length} 节`
        + (reuse === undefined ? '' : `；复用了 ${reuse.sources} 条既有资料`),
    })

    // 把这次的语料与地图写回话题缓存，供下次复用。
    // 失败不影响本次产出——持久化是加速手段，不是正确性依赖。
    try {
      await topics.save(board, ctx.runId)
    } catch (error) {
      ctx.log.warn(`话题缓存写入失败（不影响本次结果）：${error instanceof Error ? error.message : String(error)}`)
    }

    // ── 组装报告（契约与 pipeline-default 完全一致）──
    const outputs = ctx.outputs()
    const finishedAt = new Date()
    const degradation = outcome.status === 'converged'
      ? undefined
      : `${outcome.message}（未收敛就收工，产物可能不完整）`

    const synthesis: OrganizeOutput = {
      title: outline.title,
      summary: buildSummary(board.sources.length, board.map.nodes.length, board.map.gaps),
      sections: board.document.map((section): ReportSection => ({
        heading: section.heading,
        body: section.body.length > 0 ? section.body : '（这一节没有产出内容）',
        citations: section.sourceIds
          .map((id) => board.sources.find((source) => source.id === id)?.url)
          .filter((url): url is string => url !== undefined),
      })),
      meta: {
        pluginId: this.id,
        model: ctx.active().provider ?? 'unknown',
        usage: { promptTokens: meter.promptTokens, completionTokens: meter.completionTokens },
        attempts: 1,
        ...(degradation === undefined ? {} : { degraded: degradation }),
      },
    }

    const provenance: Provenance = {
      engine: ENGINE_VERSION,
      pipeline: this.id,
      search: ctx.active().search,
      searchFallbackUsed: ctx.active().searchFallbackUsed,
      ...(config.provider.id.length === 0 ? {} : { provider: config.provider.id }),
      organize: this.id,
      outputs: outputs.map((plugin) => plugin.id),
      model: ctx.active().provider ?? 'unknown',
      usage: { promptTokens: meter.promptTokens, completionTokens: meter.completionTokens },
      ...(degradation === undefined ? {} : { degraded: degradation }),
      generatedAt: finishedAt.toISOString(),
      template: template.id,
      agentic: buildAgenticProvenance(outcome, board, searchTask, writingTask, meter, reuse),
    }

    const report: Report = {
      runId: ctx.runId,
      query: input.query,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      sources: board.sources.map(toSearchSource),
      documents: board.sources.filter((source) => source.status === 'full').map(toDocument),
      failures: board.sources
        .filter((source) => source.status !== 'full')
        .map((source): FetchFailure => ({
          url: source.url,
          reason: source.filterReason ?? '未抓到正文',
        })),
      synthesis,
      provenance,
      materials: materialsFromBoard(board),
    }

    ctx.events.emit({ type: 'stage:start', stage: 'output' })
    const selection = selectOutputs(outputs, input.formats)
    if (selection.missing.length > 0) {
      ctx.log.warn(`要求的格式 ${selection.missing.join('、')} 没有启用对应输出插件，本次不会产出`)
    }
    const rendered = await renderOutputs(report, selection.plugins, ctx, signal)
    ctx.events.emit({
      type: 'stage:done',
      stage: 'output',
      summary: `写出 ${rendered.artifacts.length} 个产物${rendered.failures.length === 0 ? '' : `，${rendered.failures.length} 个格式失败`}`,
    })

    return rendered.report
  }
}

/** 把黑板上的地图与语料转成资料文件的数据。 */
function materialsFromBoard(board: Blackboard): ReportMaterials {
  return {
    themes: board.map.nodes.map((node) => ({
      id: node.id,
      topic: node.topic,
      summary: node.summary,
      claims: node.claims.map((claim) => ({
        text: claim.text,
        ...(claim.quote === undefined ? {} : { quote: claim.quote }),
        sourceIds: claim.sourceIds,
      })),
      sourceIds: node.sourceIds,
    })),
    gaps: board.map.gaps,
    conflicts: board.map.conflicts.map((conflict) => ({
      topic: conflict.topic,
      positions: conflict.positions,
    })),
    sources: board.sources.map((source) => ({
      id: source.id,
      url: source.url,
      title: source.title,
      status: source.status,
      ...(source.extraction === undefined ? {} : { extraction: source.extraction }),
      ...(source.extractionFallbackReason === undefined
        ? {}
        : { extractionFallbackReason: source.extractionFallbackReason }),
      relevance: source.relevance,
      ...(source.filterReason === undefined ? {} : { filterReason: source.filterReason }),
    })),
  }
}

/** 一句话交代这次调研的覆盖情况。 */
function buildSummary(sourceCount: number, nodeCount: number, gaps: readonly string[]): string {
  const parts = [`本次调研收集 ${sourceCount} 条来源，归纳为 ${nodeCount} 个主题`]
  if (gaps.length > 0) parts.push(`仍有 ${gaps.length} 个方面没有覆盖到：${gaps.slice(0, 3).join('、')}`)
  return `${parts.join('；')}。`
}

/** 来源 → 报告里的来源记录。被过滤的也保留，并在摘要里写明原因——筛必有漏，藏起来更糟。 */
function toSearchSource(source: {
  url: string
  title: string
  snippet?: string
  relevance: string
  filterReason?: string
}): SearchSource {
  const rejected = source.relevance !== 'kept'
  const note = rejected ? `［已过滤：${source.filterReason ?? source.relevance}］` : undefined
  const snippet = [note, source.snippet].filter((part): part is string => part !== undefined && part.length > 0).join(' ')
  return {
    url: source.url,
    ...(source.title.length === 0 ? {} : { title: source.title }),
    ...(snippet.length === 0 ? {} : { snippet }),
  }
}

/** 来源 → 已抓取正文。 */
function toDocument(source: {
  url: string
  title: string
  text: string
  truncated?: boolean
  extraction?: string
  extractionFallbackReason?: string
}): FetchedDocument {
  return {
    url: source.url,
    sourceUrl: source.url,
    status: 200,
    ...(source.title.length === 0 ? {} : { title: source.title }),
    text: source.text,
    truncated: source.truncated ?? false,
    ...(source.extraction === 'readability' || source.extraction === 'plain-text'
      ? { extraction: source.extraction }
      : {}),
    ...(source.extractionFallbackReason === undefined ? {} : { extractionFallbackReason: source.extractionFallbackReason }),
  }
}

/** 汇总代理式运行的观测数据。 */
function buildAgenticProvenance(
  outcome: RunOutcome,
  board: Blackboard,
  searchTask: SearchTask,
  writingTask: WritingTask,
  meter: LlmMeter,
  reuse: ReuseInfo | undefined,
): AgenticProvenance {
  let readability = 0
  let plainText = 0
  for (const source of board.sources) {
    if (source.extraction === 'readability') readability += 1
    else if (source.extraction === 'plain-text') plainText += 1
  }

  return {
    iterations: outcome.iterations,
    outcome: outcome.status,
    outcomeMessage: outcome.message,
    searchRounds: searchTask.history.length,
    mapNodes: board.map.nodes.length,
    gaps: board.map.gaps.length,
    conflicts: board.map.conflicts.length,
    toolCalls: writingTask.totalToolCalls,
    llmCalls: meter.calls,
    promptTokens: meter.promptTokens,
    completionTokens: meter.completionTokens,
    extraction: { readability, plainText },
    // 步数与理由直接来自运行器：这里不再自己拼一份（之前那份 steps 是硬编码的 0）
    tasks: outcome.tasks,
    ...(reuse === undefined ? {} : { reused: reuse }),
  }
}

/** 插件清单。 */
export const researchPipelinePlugin: PluginManifest = definePlugin({
  id: 'pipeline-research',
  kind: 'pipeline',
  version: '0.1.0',
  title: '代理式调研：搜索收敛 → 大纲 → 工具循环写作',
  description: '每个 agent 是带自我终止条件的任务，通过共享黑板协作；收敛条件来自观测（地图饱和、覆盖度、自检），不是步数。',
  entry: new ResearchPipeline(),
})
