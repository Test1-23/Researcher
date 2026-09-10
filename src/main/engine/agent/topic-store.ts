/**
 * 话题级持久化：把黑板按话题存下来，同一话题再次研究时读回。
 *
 * 这是持久化真正省时间的地方——第二次研究同一话题时，语料与地图已经在手，
 * 搜索任务会因为「新增内容对地图贡献很低」而很快判定饱和并收工，
 * 只去补那些确实新增的东西。**复用走的还是原本那套机制，没有为它加特例。**
 *
 * 目录形状：
 * ```
 * <数据目录>/topics/<topicId>/
 *   ├── topic.json   话题元信息与历次运行
 *   ├── map.json     主题地图
 *   └── corpus.json  语料库
 * ```
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Blackboard } from './blackboard.ts'
import type { CorpusSource, Outline, TopicMap } from './types.ts'

/** 话题元信息。 */
export interface TopicRecord {
  readonly id: string
  /** 最近一次使用的查询原文（话题标题）。 */
  readonly query: string
  readonly createdAt: string
  readonly updatedAt: string
  /** 历次研究（「按会话」在这里落地：话题下挂着它的运行历史）。 */
  readonly runs: readonly { readonly runId: string; readonly at: string }[]
  readonly sourceCount: number
  readonly mapNodeCount: number
}

/** 持久化的黑板快照。 */
interface BoardSnapshot {
  readonly query: string
  readonly sources: readonly CorpusSource[]
  readonly map: TopicMap
  readonly outline: Outline | undefined
  readonly document: readonly unknown[]
}

/** 复用信息，写进 provenance。 */
export interface ReuseInfo {
  readonly topicId: string
  readonly sources: number
  readonly mapNodes: number
  readonly updatedAt: string
}

/** 规范化查询，让「同一话题」的不同写法落到同一个 id。 */
export function normalizeTopic(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, '').replace(/[。，、！？!?,.]+$/g, '')
}

/** 由查询算出稳定的话题 id。中文查询没法做可读 slug，因此用哈希。 */
export function topicIdFor(query: string): string {
  const normalized = normalizeTopic(query)
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `t-${(hash >>> 0).toString(36)}`
}

/** 文件系统话题仓库。 */
export class FileTopicStore {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  /** 话题目录。 */
  private dirOf(topicId: string): string {
    return join(this.root, topicId)
  }

  /**
   * 读回某个话题的黑板。
   *
   * 任何读取或解析失败都返回 undefined——持久化是加速手段，不是正确性依赖：
   * 缓存坏了就重新研究，不该让整次运行失败。
   */
  async load(query: string): Promise<{ board: Blackboard; info: ReuseInfo } | undefined> {
    const topicId = topicIdFor(query)
    const dir = this.dirOf(topicId)
    try {
      const [snapshotRaw, topicRaw] = await Promise.all([
        readFile(join(dir, 'board.json'), 'utf8'),
        readFile(join(dir, 'topic.json'), 'utf8'),
      ])
      const snapshot = JSON.parse(snapshotRaw) as BoardSnapshot
      const topic = JSON.parse(topicRaw) as TopicRecord
      if (snapshot.sources.length === 0 && snapshot.map.nodes.length === 0) return undefined

      const board = Blackboard.fromJSON({
        query: snapshot.query,
        sources: snapshot.sources,
        map: snapshot.map,
        outline: snapshot.outline,
        document: [],
        requests: [],
      })

      return {
        board,
        info: {
          topicId,
          sources: snapshot.sources.length,
          mapNodes: snapshot.map.nodes.length,
          updatedAt: topic.updatedAt,
        },
      }
    } catch {
      return undefined
    }
  }

  /** 写入话题资料。用临时文件 + rename，避免中途失败留下半截 JSON。 */
  async save(board: Blackboard, runId: string, now = new Date()): Promise<TopicRecord> {
    const topicId = topicIdFor(board.query)
    const dir = this.dirOf(topicId)
    await mkdir(dir, { recursive: true })

    const previous = await this.readRecord(topicId)
    const timestamp = now.toISOString()
    const record: TopicRecord = {
      id: topicId,
      query: board.query,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      runs: [...(previous?.runs ?? []), { runId, at: timestamp }].slice(-50),
      sourceCount: board.sources.length,
      mapNodeCount: board.map.nodes.length,
    }

    const snapshot: BoardSnapshot = {
      query: board.query,
      sources: board.sources,
      map: board.map,
      outline: board.outline,
      document: [],
    }

    await Promise.all([
      writeAtomic(join(dir, 'topic.json'), JSON.stringify(record, null, 2)),
      writeAtomic(join(dir, 'board.json'), JSON.stringify(snapshot, null, 2)),
    ])
    return record
  }

  /** 列出全部话题，按最近更新倒序。 */
  async list(): Promise<readonly TopicRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const records: TopicRecord[] = []
    for (const entry of entries) {
      const record = await this.readRecord(entry)
      if (record !== undefined) records.push(record)
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 读单个话题的元信息。 */
  private async readRecord(topicId: string): Promise<TopicRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dirOf(topicId), 'topic.json'), 'utf8')) as TopicRecord
    } catch {
      return undefined
    }
  }
}

/** 先写临时文件再改名：避免进程中断留下半个 JSON 把缓存读坏。 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${content}\n`, 'utf8')
  await rename(temporary, path)
}
