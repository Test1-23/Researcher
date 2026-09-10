/**
 * 候选过滤：**只淘汰重复与无关**。
 *
 * 这是本设计里最容易被改坏的一处，所以把约束写在最前面：
 *
 *   禁止按「好坏」排序或择优。淘汰赛会杀掉广度，而广度是大纲唯一的营养来源
 *   （大纲需要知道这个话题由哪些方面构成、有哪些不同说法，而不是「最好的三篇」）。
 *
 * 因此过滤只做两件事：
 *   ① 确定性去重——URL、标题+域名、正文指纹。便宜、不会误杀。
 *   ② 让模型挑**无关**的项——明确要求它只输出「与主题无关」的下标，
 *      不许它按质量排名。
 */

import { asNumber, asString, asStringArray, isPlainObject } from '../json.ts'
import type { CorpusSource } from './types.ts'
import type { PluginContext } from '../types.ts'
import { completeStructured, type LlmMeter } from './llm.ts'

/** 过滤结果。 */
export interface FilterOutcome {
  readonly kept: readonly CorpusSource[]
  readonly dropped: readonly CorpusSource[]
  /** 判定「无关」时用了哪些查询批次（便于回看） */
  readonly notes: readonly string[]
}

/** 规范化 URL：去掉 fragment 与常见追踪参数。 */
export function normalizeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|spm|from|share_|src)/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return undefined
  }
}

/** 正文指纹：取正文里的字符 shingle 做集合，用于近似重复判断。 */
export function contentFingerprint(text: string, shingles = 40): ReadonlySet<string> {
  const normalized = text.replace(/\s+/g, '').toLowerCase()
  const size = 12
  const set = new Set<string>()
  if (normalized.length <= size) {
    if (normalized.length > 0) set.add(normalized)
    return set
  }
  // 等距取样，避免长文与短文的集合规模差异过大
  const step = Math.max(1, Math.floor((normalized.length - size) / shingles))
  for (let index = 0; index + size <= normalized.length; index += step) {
    set.add(normalized.slice(index, index + size))
  }
  return set
}

/** 两个指纹的 Jaccard 相似度。 */
export function similarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * 确定性去重（不改动入参，返回标注后的新数组）。
 *
 * 三档：URL 相同 → 标题+域名相同 → 正文近似（相似度 ≥ 阈值，默认 0.85）。
 */
export function dedupe(sources: readonly CorpusSource[], threshold = 0.85): CorpusSource[] {
  const byUrl = new Set<string>()
  const byTitle = new Set<string>()
  const kept: CorpusSource[] = []
  const fingerprints: ReadonlySet<string>[] = []

  for (const source of sources) {
    const url = normalizeUrl(source.url)
    if (url === undefined) {
      kept.push({ ...source, relevance: 'duplicate', filterReason: 'URL 不合法' })
      continue
    }
    if (byUrl.has(url)) {
      kept.push({ ...source, relevance: 'duplicate', filterReason: 'URL 重复' })
      continue
    }

    const titleKey = `${hostnameOf(url)}|${source.title.trim().toLowerCase()}`
    if (source.title.trim().length > 0 && byTitle.has(titleKey)) {
      kept.push({ ...source, relevance: 'duplicate', filterReason: '同域名同标题' })
      continue
    }

    if (source.status === 'full' && source.text.length > 200) {
      const fingerprint = contentFingerprint(source.text)
      const near = fingerprints.findIndex((other) => similarity(other, fingerprint) >= threshold)
      if (near >= 0) {
        kept.push({ ...source, relevance: 'duplicate', filterReason: '正文与另一来源高度重合' })
        continue
      }
      fingerprints.push(fingerprint)
    }

    byUrl.add(url)
    if (source.title.trim().length > 0) byTitle.add(titleKey)
    kept.push({ ...source, relevance: 'kept' })
  }

  return kept
}

/** 取域名。 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return url
  }
}

/** 无关判定的系统提示词。约束就写在提示词里。 */
const IRRELEVANT_SYSTEM = [
  '你是一名资料筛选员。用户会给你一个研究主题和一批资料的标题与摘要。',
  '',
  '你的唯一任务是：找出**与这个主题无关**的条目。',
  '',
  '严格要求：',
  '1. 不要按质量、权威性、深度排序，也不要挑选「最好的几篇」——那不是你的工作。',
  '2. 只有当一条资料**与主题无关**（例如不同领域、不同主题、纯广告、纯导航页、与主题毫无交集）时才剔除。',
  '3. 只要它可能对主题的**某个方面**有用，就必须保留，哪怕它质量一般、篇幅很短、观点片面。',
  '4. 宁可少剔除，也不要误伤。保留是默认选择。',
  '',
  '只输出一个 JSON 对象：{"irrelevant": [下标数组], "notes": ["一句话说明"]}',
  '下标从 1 开始，与资料清单里的编号一致。',
].join('\n')

/**
 * 用模型挑出无关项。
 *
 * 失败时**返回全部保留**——过滤是收敛优化，不是正确性依赖；
 * 因为一次模型抽风就丢掉一批资料，代价远大于多留几条噪声。
 */
export async function filterIrrelevant(
  query: string,
  sources: readonly CorpusSource[],
  ctx: PluginContext,
  meter: LlmMeter,
  options: { readonly batchSize?: number; readonly signal?: AbortSignal } = {},
): Promise<FilterOutcome> {
  const kept = sources.filter((source) => source.relevance === 'kept')
  const alreadyDropped = sources.filter((source) => source.relevance !== 'kept')
  if (kept.length === 0) return { kept: [], dropped: alreadyDropped, notes: [] }

  const batchSize = options.batchSize ?? 25
  const dropIndexes = new Set<number>()
  const notes: string[] = []

  for (let start = 0; start < kept.length; start += batchSize) {
    const batch = kept.slice(start, start + batchSize)
    // 下标统一用**从 1 开始**：与归一化归纳的提示词保持一致，
    // 也符合人对「第几条」的直觉，避免模型与代码各按一套解释导致差一位。
    const listing = batch
      .map((source, index) => {
        const snippet = (source.snippet ?? source.text).slice(0, 300).replace(/\s+/g, ' ')
        return `[${index + 1}] 标题：${source.title}\n    摘要：${snippet}`
      })
      .join('\n')

    try {
      const verdict = await completeStructured(
        {
          system: IRRELEVANT_SYSTEM,
          user: `研究主题：${query}\n\n资料清单：\n${listing}`,
          temperature: 0,
        },
        (value) => {
          if (!isPlainObject(value)) throw new Error('顶层不是对象')
          const indexes = Array.isArray(value['irrelevant'])
            ? value['irrelevant']
                .map((item) => asNumber(item, -1))
                .filter((item) => item >= 1 && item <= batch.length)
            : []
          return { indexes, notes: asStringArray(value['notes']) }
        },
        ctx,
        meter,
        '无关判定',
        options.signal,
      )

      for (const index of verdict.indexes) {
        dropIndexes.add(start + index - 1)
      }
      notes.push(...verdict.notes)
    } catch (error) {
      // 判定失败就整批保留：多留噪声的代价远小于误删资料
      ctx.log.warn(`无关判定失败，本批全部保留：${error instanceof Error ? error.message : String(error)}`)
      notes.push('无关判定失败，本批已全部保留')
    }
  }

  const keptFinal: CorpusSource[] = []
  const droppedFinal: CorpusSource[] = [...alreadyDropped]
  kept.forEach((source, index) => {
    if (dropIndexes.has(index)) {
      droppedFinal.push({ ...source, relevance: 'irrelevant', filterReason: '模型判定与主题无关' })
    } else {
      keptFinal.push(source)
    }
  })

  return { kept: keptFinal, dropped: droppedFinal, notes }
}

/** 从模型输出里取一句字符串（供其它模块复用）。 */
export { asString }
