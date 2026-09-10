/**
 * 候选抓取与抽取。
 *
 * 与其他地方的抓取共用一个原则：**失败不丢弃**。抓不到正文的候选仍以
 * 「仅摘要」形式进入语料库——搜索结果的标题与摘要本身也是信息，
 * 静默丢掉它们会让地图出现本不存在的空白。
 */

import type { FetchError, } from '../errors.ts'
import { isCancellation, throwIfAborted, toResearcherError } from '../errors.ts'
import type { CorpusSource } from './types.ts'
import type { PluginContext } from '../types.ts'

/** 一个待抓取的候选。 */
export interface Candidate {
  readonly url: string
  readonly title: string
  readonly snippet?: string
  readonly foundByQueries: readonly string[]
}

/** 抓取结果。 */
export interface CollectionResult {
  readonly sources: readonly CorpusSource[]
  /** 抓取失败的数量（这些来源仍以 snippet-only 形式在 `sources` 里）。 */
  readonly failures: number
}

/** 生成稳定的来源 id：s001、s002…… */
export function makeSourceId(index: number): string {
  return `s${String(index).padStart(3, '0')}`
}

/**
 * 并发抓取候选并抽取正文。
 *
 * 结果**保序**（按下标写回），因此同样的输入得到同样的语料顺序。
 */
export async function collectDocuments(
  candidates: readonly Candidate[],
  ctx: PluginContext,
  options: { readonly concurrency: number; readonly startIndex?: number },
  signal?: AbortSignal,
): Promise<CollectionResult> {
  const sources: (CorpusSource | undefined)[] = new Array<CorpusSource | undefined>(candidates.length)
  const startIndex = options.startIndex ?? 0
  let cursor = 0
  let failures = 0

  const workerCount = Math.max(1, Math.min(options.concurrency, candidates.length))
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= candidates.length) return

      const candidate = candidates[index]
      if (candidate === undefined) return
      throwIfAborted(signal)

      const base = {
        id: makeSourceId(startIndex + index),
        url: candidate.url,
        title: candidate.title,
        foundByQueries: candidate.foundByQueries,
        fetchedAt: new Date().toISOString(),
      }

      try {
        const document = await ctx.fetch.fetchText(candidate.url, signal)
        sources[index] = {
          ...base,
          title: document.title !== undefined && document.title.length > 0 ? document.title : candidate.title,
          text: document.text,
          status: 'full',
          ...(candidate.snippet === undefined ? {} : { snippet: candidate.snippet }),
          ...(document.extraction === undefined ? {} : { extraction: document.extraction }),
          ...(document.extractionFallbackReason === undefined
            ? {}
            : { extractionFallbackReason: document.extractionFallbackReason }),
          truncated: document.truncated,
          relevance: 'kept',
        }
        ctx.events.emit({
          type: 'fetch:done',
          url: candidate.url,
          status: document.status,
          bytes: document.text.length,
          ok: true,
        })
      } catch (error) {
        // 取消不是失败：必须向上抛，否则会被记成「抓取失败」并继续跑
        if (isCancellation(error)) throw error
        throwIfAborted(signal)

        failures += 1
        const normalized = toResearcherError(error)
        const status = (error as FetchError).status
        sources[index] = {
          ...base,
          text: '',
          status: 'snippet-only',
          truncated: false,
          ...(candidate.snippet === undefined ? {} : { snippet: candidate.snippet }),
          relevance: 'kept',
          filterReason: `抓取失败：${normalized.message}`,
        }
        ctx.events.emit({
          type: 'fetch:done',
          url: candidate.url,
          status: status ?? 0,
          bytes: 0,
          ok: false,
        })
      }
    }
  })

  await Promise.all(workers)

  return {
    sources: sources.filter((source): source is CorpusSource => source !== undefined),
    failures,
  }
}
