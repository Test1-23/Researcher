/**
 * 话题持久化的测试。
 *
 * 重点：
 *   · 同一话题的不同写法（大小写、空格、结尾标点）落到同一个 id
 *   · 存下来能原样读回（语料 + 地图）
 *   · 缓存损坏时返回 undefined 而不是抛错——持久化是加速手段，不是正确性依赖
 *   · 复用后搜索任务会因为「地图已满」而更快饱和（这就是复用的收益）
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Blackboard } from '../src/main/engine/agent/blackboard.ts'
import { FileTopicStore, normalizeTopic, topicIdFor } from '../src/main/engine/agent/topic-store.ts'
import type { CorpusSource, MapNode } from '../src/main/engine/agent/types.ts'

const roots: string[] = []
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'researcher-topics-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 造一条来源。 */
function source(id: string): CorpusSource {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `标题 ${id}`,
    text: '正文内容',
    status: 'full',
    truncated: false,
    foundByQueries: ['q'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    relevance: 'kept',
  }
}

/** 造一个地图节点。 */
function node(id: string, sourceIds: readonly string[]): MapNode {
  return {
    id,
    topic: `主题 ${id}`,
    summary: '概述',
    claims: [{ text: '论断', sourceIds }],
    sourceIds,
    level: 1,
  }
}

/** 一张填好的黑板。 */
function filledBoard(query = 'WebGPU 支持现状'): Blackboard {
  const board = new Blackboard(query)
  board.addSources([source('s1'), source('s2')])
  board.mergeMap([node('n1', ['s1', 's2'])], ['缺移动端实测'], [])
  board.setOutline({ title: 'T', thesis: 'th', sections: [], builtFromRevision: board.mapRevision })
  return board
}

describe('话题 id 稳定性', () => {
  it('大小写、空格、结尾标点的差异都归一到同一个话题', () => {
    expect(normalizeTopic('  WebGPU 支持现状 ')).toBe(normalizeTopic('webgpu支持现状'))
    expect(topicIdFor('WebGPU 支持现状')).toBe(topicIdFor('webgpu支持现状'))
    expect(topicIdFor('这个话题')).toBe(topicIdFor('这个话题。'))
    expect(topicIdFor('这个话题')).toBe(topicIdFor('这个话题！'))
  })

  it('不同话题得到不同 id', () => {
    expect(topicIdFor('话题甲')).not.toBe(topicIdFor('话题乙'))
  })

  it('id 是文件名安全的', () => {
    const id = topicIdFor('../../危险的/话题?*')
    expect(id).toMatch(/^t-[a-z0-9]+$/)
  })
})

describe('话题仓库', () => {
  it('存下来能原样读回语料与地图', async () => {
    const store = new FileTopicStore(await makeRoot())
    const board = filledBoard()
    await store.save(board, 'run-1')

    const loaded = await store.load(board.query)
    expect(loaded).toBeDefined()
    expect(loaded?.board.sources.map((item) => item.id)).toEqual(['s1', 's2'])
    expect(loaded?.board.map.nodes).toHaveLength(1)
    expect(loaded?.board.map.gaps).toEqual(['缺移动端实测'])
    expect(loaded?.board.outline?.title).toBe('T')
    expect(loaded?.info.sources).toBe(2)
    expect(loaded?.info.mapNodes).toBe(1)
  })

  it('话题元信息记录历次运行，并把「按会话」体现在这里', async () => {
    const store = new FileTopicStore(await makeRoot())
    const board = filledBoard()
    await store.save(board, 'run-1')
    await store.save(board, 'run-2')

    const topics = await store.list()
    expect(topics).toHaveLength(1)
    expect(topics[0]?.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2'])
    expect(topics[0]?.createdAt <= (topics[0]?.updatedAt ?? '')).toBe(true)
    expect(topics[0]?.sourceCount).toBe(2)
  })

  it('没存过的话题读回 undefined', async () => {
    const store = new FileTopicStore(await makeRoot())
    expect(await store.load('从没研究过的主题')).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('缓存损坏时返回 undefined，不抛错', async () => {
    const root = await makeRoot()
    const store = new FileTopicStore(root)
    const board = filledBoard()
    await store.save(board, 'run-1')
    // 把快照写坏
    await writeFile(join(root, topicIdFor(board.query), 'board.json'), '{ 这不是 JSON', 'utf8')

    expect(await store.load(board.query)).toBeUndefined()
    // list 也容忍坏文件
    await expect(store.list()).resolves.toBeDefined()
  })

  it('空缓存（没有来源也没有地图）视为无缓存', async () => {
    const store = new FileTopicStore(await makeRoot())
    await store.save(new Blackboard('空话题'), 'run-1')
    expect(await store.load('空话题')).toBeUndefined()
  })

  it('写入是原子的：不留半截文件', async () => {
    const root = await makeRoot()
    const store = new FileTopicStore(root)
    const board = filledBoard()
    await store.save(board, 'run-1')

    const dir = join(root, topicIdFor(board.query))
    const raw = await readFile(join(dir, 'board.json'), 'utf8')
    expect(() => JSON.parse(raw) as unknown).not.toThrow()
    // 临时文件已被 rename 掉
    await expect(readFile(join(dir, 'board.json.tmp'), 'utf8')).rejects.toThrowError()
  })

  it('多个话题各自独立，列表按更新时间倒序', async () => {
    const store = new FileTopicStore(await makeRoot())
    await store.save(filledBoard('话题一'), 'r1', new Date('2026-01-01T00:00:00.000Z'))
    await store.save(filledBoard('话题二'), 'r2', new Date('2026-02-01T00:00:00.000Z'))

    const topics = await store.list()
    expect(topics.map((topic) => topic.query)).toEqual(['话题二', '话题一'])
  })

  it('同一话题的语料在地图上只增不减（复用的前提）', async () => {
    const store = new FileTopicStore(await makeRoot())
    const first = filledBoard()
    await store.save(first, 'run-1')

    // 第二次研究：读回后再加一条来源与节点，再存
    const loaded = await store.load(first.query)
    const board = loaded?.board as Blackboard
    board.addSources([source('s3')])
    board.mergeMap([node('n2', ['s3'])], [], [])
    await store.save(board, 'run-2')

    const again = await store.load(first.query)
    expect(again?.board.sources).toHaveLength(3)
    expect(again?.board.map.nodes).toHaveLength(2)
  })
})
