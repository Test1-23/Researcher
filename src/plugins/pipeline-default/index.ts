/**
 * 默认主流程：搜索 → 抓取正文 → 整理 → 输出。
 *
 * 它自己也是插件，因此可以整体替换（例如换成「只搜索不整理」或「多轮迭代检索」的流程）。
 * 它不认识任何具体后端：搜索、整理、输出都是通过 ctx 解析出来的活动插件。
 */

import { ENGINE_VERSION } from '../../main/engine/config.ts'
import { FetchError, isCancellation, throwIfAborted, toResearcherError } from '../../main/engine/errors.ts'
import { renderOutputs, selectOutputs } from '../../main/engine/output.ts'
import { definePlugin } from '../../main/engine/registry.ts'
import type {
  AvailabilityContext,
  FetchedDocument,
  FetchFailure,
  OrganizeInput,
  OrganizeOutput,
  Pipeline,
  PluginContext,
  PluginManifest,
  Provenance,
  Report,
  ReportMaterials,
  RunInput,
  SearchSource,
} from '../../main/engine/types.ts'

/** 归一化 URL：去掉 fragment，只保留 http/https。无法解析时返回 undefined。 */
export function normalizeSourceUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/** 按 URL 去重；同一 URL 重复出现时补齐缺失的标题/摘要，而不是丢弃信息。 */
export function dedupeSources(sources: readonly SearchSource[]): SearchSource[] {
  const byUrl = new Map<string, SearchSource>()
  for (const source of sources) {
    const key = normalizeSourceUrl(source.url)
    if (key === undefined) continue
    const existing = byUrl.get(key)
    if (existing === undefined) {
      byUrl.set(key, { ...source, url: key })
      continue
    }
    byUrl.set(key, {
      ...existing,
      ...(existing.title === undefined && source.title !== undefined ? { title: source.title } : {}),
      ...(existing.snippet === undefined && source.snippet !== undefined ? { snippet: source.snippet } : {}),
      ...(existing.publishedAt === undefined && source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
    })
  }
  return [...byUrl.values()]
}

/** 单个来源的抓取结局。 */
type FetchOutcome =
  | { readonly ok: true; readonly document: FetchedDocument }
  | { readonly ok: false; readonly failure: FetchFailure }

/**
 * 并发抓取，但**保持来源顺序**：结果按下标写回，因此报告里正文的顺序与来源顺序一致，
 * 同样的输入会得到同样的报告。
 */
export async function fetchAll(
  targets: readonly SearchSource[],
  ctx: PluginContext,
  concurrency: number,
  signal?: AbortSignal,
): Promise<{ documents: FetchedDocument[]; failures: FetchFailure[] }> {
  const outcomes: (FetchOutcome | undefined)[] = new Array<FetchOutcome | undefined>(targets.length)
  let cursor = 0

  const workerCount = Math.max(1, Math.min(concurrency, targets.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= targets.length) return

      const source = targets[index]
      throwIfAborted(signal)
      try {
        const document = await ctx.fetch.fetchText(source.url, signal)
        outcomes[index] = { ok: true, document: { ...document, sourceUrl: source.url } }
        ctx.events.emit({
          type: 'fetch:done',
          url: source.url,
          status: document.status,
          bytes: document.text.length,
          ok: true,
        })
      } catch (error) {
        // 取消不是失败：必须向上抛，否则界面会显示成「抓取失败」。
        if (isCancellation(error)) throw error
        throwIfAborted(signal)
        const normalized = toResearcherError(error)
        const status = error instanceof FetchError ? error.status : undefined
        outcomes[index] = {
          ok: false,
          failure: { url: source.url, reason: normalized.message, ...(status === undefined ? {} : { status }) },
        }
        ctx.events.emit({ type: 'fetch:done', url: source.url, status: status ?? 0, bytes: 0, ok: false })
      }
    }
  })

  await Promise.all(workers)

  const documents: FetchedDocument[] = []
  const failures: FetchFailure[] = []
  for (const outcome of outcomes) {
    if (outcome === undefined) continue
    if (outcome.ok) documents.push(outcome.document)
    else failures.push(outcome.failure)
  }
  return { documents, failures }
}

/**
 * 把来源与抓取结果转成资料文件的数据。
 *
 * 默认主流程不建地图，所以 themes 为空——但语料清单**照常给出**，
 * 这样 `output-materials` 在任何一条主流程下都有意义，而不是空转。
 */
export function materialsFromDocuments(
  sources: readonly SearchSource[],
  documents: readonly FetchedDocument[],
  failures: readonly FetchFailure[],
): ReportMaterials {
  const documentBySource = new Map<string, FetchedDocument>()
  for (const document of documents) documentBySource.set(document.sourceUrl ?? document.url, document)
  const failureBySource = new Map<string, FetchFailure>()
  for (const failure of failures) failureBySource.set(failure.url, failure)

  return {
    themes: [],
    gaps: [],
    conflicts: [],
    sources: sources.map((source, index) => {
      const id = `s${String(index + 1).padStart(3, '0')}`
      const document = documentBySource.get(source.url)
      const failure = failureBySource.get(source.url)
      const base = { id, url: source.url, title: source.title ?? source.url, relevance: 'kept' as const }

      if (document !== undefined) {
        return {
          ...base,
          status: 'full' as const,
          ...(document.extraction === undefined ? {} : { extraction: document.extraction }),
          ...(document.extractionFallbackReason === undefined
            ? {}
            : { extractionFallbackReason: document.extractionFallbackReason }),
        }
      }

      return {
        ...base,
        status: 'snippet-only' as const,
        filterReason: failure?.reason ?? '未抓取（超出本次抓取上限）',
      }
    }),
  }
}

/** 整理结果，附带实际使用的插件与降级说明。 */interface OrganizeOutcome {
  readonly output: OrganizeOutput
  readonly organizerId: string
  readonly degraded: string | undefined
}

/**
 * 跑整理插件；失败时（且配置了降级插件）改用降级插件，并把原因写进报告。
 * 取消错误不参与降级——用户点了取消，不该再偷偷跑一个备用插件。
 */
export async function organizeWithFallback(
  input: OrganizeInput,
  ctx: PluginContext,
  signal?: AbortSignal,
): Promise<OrganizeOutcome> {
  const organizer = ctx.organize()
  try {
    const output = await organizer.organize(input, ctx, signal)
    return { output, organizerId: organizer.id, degraded: output.meta?.degraded }
  } catch (error) {
    if (isCancellation(error)) throw error

    const fallback = ctx.organizeFallback()
    if (fallback === undefined || fallback.id === organizer.id) throw error

    const reason = toResearcherError(error).message
    ctx.log.warn(`整理插件 ${organizer.id} 失败（${reason}），降级到 ${fallback.id} 后重试`)
    const output = await fallback.organize(input, ctx, signal)
    const note = `主整理插件 ${organizer.id} 失败：${reason}；已降级到 ${fallback.id}`
    return {
      output: { ...output, meta: { ...output.meta, pluginId: fallback.id, degraded: note } },
      organizerId: fallback.id,
      degraded: note,
    }
  }
}

/** 默认主流程插件。 */
export class DefaultPipeline implements Pipeline {
  readonly id = 'pipeline-default'
  readonly kind = 'pipeline' as const

  /** 只依赖搜索插件，没有额外依赖，永远可用——这正是它能当备用主流程的原因。 */
  available(_ctx: AvailabilityContext): boolean {
    return true
  }

  async run(input: RunInput, ctx: PluginContext, signal?: AbortSignal): Promise<Report> {
    const startedAt = new Date()
    const config = ctx.config.all()
    const maxSources = input.maxSources ?? config.search.maxSources
    const maxFetch = input.maxFetch ?? config.search.maxFetch

    throwIfAborted(signal)

    // ── 搜索 ──
    ctx.events.emit({ type: 'stage:start', stage: 'search' })
    const search = ctx.search()
    const result = await search.search({ query: input.query, maxResults: maxSources }, ctx, signal)
    const sources = dedupeSources(result.sources).slice(0, Math.max(maxSources, 0))
    for (const source of sources) ctx.events.emit({ type: 'source:found', source })
    ctx.events.emit({
      type: 'stage:done',
      stage: 'search',
      summary: `${search.id} 返回 ${sources.length} 个来源${result.truncated ? '（已截断）' : ''}`,
    })

    // ── 抓取正文 ──
    ctx.events.emit({ type: 'stage:start', stage: 'fetch' })
    const targets = sources.slice(0, Math.max(maxFetch, 0))
    const { documents, failures } = await fetchAll(targets, ctx, config.fetch.concurrency, signal)
    ctx.events.emit({
      type: 'stage:done',
      stage: 'fetch',
      summary: `尝试 ${targets.length} 篇，成功 ${documents.length} 篇，失败 ${failures.length} 篇`,
    })

    // ── 整理 ──
    ctx.events.emit({ type: 'stage:start', stage: 'organize' })
    const organized = await organizeWithFallback(
      { query: input.query, sources, documents, failures },
      ctx,
      signal,
    )
    ctx.events.emit({
      type: 'stage:done',
      stage: 'organize',
      summary: `${organized.organizerId} 生成 ${organized.output.sections.length} 个小节`,
    })

    // ── 组装报告 ──
    const outputs = ctx.outputs()
    const finishedAt = new Date()

    // 配置的整理插件在选型阶段就不可用时也要如实记录，否则报告会看起来「一切正常」。
    let degraded = organized.degraded
    if (degraded === undefined && organized.organizerId !== config.organize.id) {
      degraded = `配置的整理插件 ${config.organize.id} 不可用，本次改用 ${organized.organizerId}`
    }

    const provenance: Provenance = {
      engine: ENGINE_VERSION,
      pipeline: this.id,
      search: search.id,
      searchFallbackUsed: ctx.active().searchFallbackUsed,
      ...(config.provider.id.length === 0 ? {} : { provider: config.provider.id }),
      organize: organized.organizerId,
      outputs: outputs.map((plugin) => plugin.id),
      ...(organized.output.meta?.model === undefined ? {} : { model: organized.output.meta.model }),
      ...(organized.output.meta?.usage === undefined ? {} : { usage: organized.output.meta.usage }),
      ...(degraded === undefined ? {} : { degraded }),
      generatedAt: finishedAt.toISOString(),
    }

    const report: Report = {
      runId: ctx.runId,
      query: input.query,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      sources,
      documents,
      failures,
      synthesis: organized.output,
      provenance,
      materials: materialsFromDocuments(sources, documents, failures),
    }

    // ── 输出 ──
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

/** 插件清单。 */
export const defaultPipelinePlugin: PluginManifest = definePlugin({
  id: 'pipeline-default',
  kind: 'pipeline',
  version: '0.1.0',
  title: '默认流程：搜索 → 抓取 → 整理 → 输出',
  description: '线性四阶段流程，每个阶段都通过内核解析活动插件，因此替换任意后端都不需要改它。',
  entry: new DefaultPipeline(),
})
