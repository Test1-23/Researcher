/**
 * 写作任务的测试。
 *
 * 这是整个流程里唯一真正 agentic 的地方，所以重点验证与「不确定性」相处的部分：
 *   · 工具循环能跑通，并且工具结果真的回到了模型上下文里
 *   · 步数耗尽时**强制收稿并如实标注**，而不是抛错或假装正常
 *   · 自检不通过会重写；重写用尽后**标注未通过**而不是宣称通过
 *   · provider 不支持工具时降级为无工具写作
 *   · 工具本身失败只作为观察结果返回，不打断写作
 */

import { describe, expect, it } from 'vitest'
import { Blackboard } from '../src/main/engine/agent/blackboard.ts'
import { LlmMeter } from '../src/main/engine/agent/llm.ts'
import { WritingTask, TOOL_LIST_SOURCES, TOOL_READ_SOURCE, TOOL_REVISE_OUTLINE, TOOL_SEARCH_MORE } from '../src/main/engine/agent/writing-task.ts'
import type { CorpusSource, MapNode, Outline } from '../src/main/engine/agent/types.ts'
import { templateById } from '../src/templates/index.ts'
import type { CompleteRequest, CompleteResult, LlmProvider, SearchProvider, SearchResult, ToolCall } from '../src/main/engine/types.ts'
import { staticFetch } from './helpers/fake-fetch.ts'
import { makeContext } from './helpers/fake-context.ts'

/** 系统提示词的特征串，用来区分是哪一步在调模型。 */
const SECTION_MARK = '按大纲为一份文档写其中的一节'
const CHECK_MARK = '检查一份文档的某一节是否达标'

/** 一次模型回复。 */
interface Reply {
  readonly text?: string
  readonly toolCalls?: readonly ToolCall[]
}

/** 按系统提示词分派的假模型。 */
class ScriptedWriterLlm implements LlmProvider {
  readonly id = 'scripted-writer'
  readonly kind = 'provider' as const
  supportsTools: boolean
  readonly calls: CompleteRequest[] = []

  constructor(
    private readonly handler: (request: CompleteRequest, index: number, sectionCalls: number) => Reply,
    options: { readonly supportsTools?: boolean } = {},
  ) {
    this.supportsTools = options.supportsTools ?? true
  }

  available(): boolean {
    return true
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const index = this.calls.length
    this.calls.push(request)
    const sectionCalls = this.calls.filter((call) => systemOf(call).includes(SECTION_MARK)).length - 1
    const reply = this.handler(request, index, sectionCalls)
    return {
      text: reply.text ?? '',
      model: 'fake',
      usage: { promptTokens: 10, completionTokens: 10 },
      ...(reply.toolCalls === undefined ? {} : { toolCalls: reply.toolCalls }),
    }
  }
}

/** 取系统提示词。 */
function systemOf(request: CompleteRequest): string {
  return request.messages.find((message) => message.role === 'system')?.content ?? ''
}

/** 造一条来源。 */
function source(id: string, text = '来源正文内容。这是一段用于测试的正文。'): CorpusSource {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `标题 ${id}`,
    text,
    status: 'full',
    foundByQueries: ['q'],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    relevance: 'kept',
  }
}

/** 不使用工具的搜索替身。 */
const unusedSearch: SearchProvider = {
  id: 'unused',
  kind: 'search',
  available: () => true,
  search: async () => ({ providerId: 'unused', sources: [], truncated: false }),
}

/** 一张已经有大纲与语料的黑板。 */
function seedBoard(sectionCount = 1): Blackboard {
  const board = new Blackboard('测试主题')
  board.addSources([source('s1'), source('s2')])
  board.mergeMap([{ id: 'n1', topic: '主题', summary: '概述', claims: [], sourceIds: ['s1', 's2'], level: 1 } satisfies MapNode], [], [])
  const sections = Array.from({ length: sectionCount }, (_, index) => ({
    id: `sec-${index + 1}`,
    slot: 'abstract',
    heading: `第 ${index + 1} 节`,
    goal: `第 ${index + 1} 节的目标`,
    sourceIds: ['s1', 's2'],
  }))
  board.setOutline({ title: '文档', thesis: '主线', sections, builtFromRevision: board.mapRevision } satisfies Outline)
  return board
}

/** 一份最小配置。 */
const CONFIG = {
  maxToolSteps: 3,
  maxRewriteAttempts: 2,
  readSourceChars: 4000,
  searchMoreCandidates: 5,
  contextCharsPerSource: 3000,
}

describe('写作任务的工具循环', () => {
  it('模型调工具 → 执行 → 结果回到上下文 → 最终交稿', async () => {
    const llm = new ScriptedWriterLlm((request, _index, sectionCalls) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      // 第 0 次先调 list_sources，之后交稿
      if (sectionCalls === 0) {
        return { toolCalls: [{ id: 'c1', name: TOOL_LIST_SOURCES, arguments: {} }] }
      }
      return { text: '这一节的正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)

    expect(board.document).toHaveLength(1)
    expect(board.document[0]?.body).toBe('这一节的正文。')
    expect(board.document[0]?.selfCheckPassed).toBe(true)

    // 工具结果确实作为 role=tool 消息回到了上下文
    const sectionRequest = llm.calls.find((call) => systemOf(call).includes(SECTION_MARK) && call.messages.some((message) => message.role === 'tool'))
    expect(sectionRequest).toBeDefined()
    const toolMessage = sectionRequest?.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.toolCallId).toBe('c1')
    expect(toolMessage?.content).toContain('s1')
    expect(task.totalToolCalls).toBe(1)
  })

  it('read_source 带关键词时只返回包含关键词的段落', async () => {
    const body = '第一段讲甲。\n\n第二段讲乙。\n\n第三段又讲甲。'
    let observed = ''
    const llm = new ScriptedWriterLlm((request, _index, sectionCalls) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      if (sectionCalls === 0) {
        return { toolCalls: [{ id: 'c1', name: TOOL_READ_SOURCE, arguments: { sourceId: 'sX', keyword: '甲' } }] }
      }
      observed = request.messages.find((message) => message.role === 'tool')?.content ?? ''
      return { text: '正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    board.addSources([source('sX', body)])
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)

    const parsed = JSON.parse(observed) as { matches: number; text: string }
    expect(parsed.matches).toBe(2)
    expect(parsed.text).toContain('第一段讲甲')
    expect(parsed.text).toContain('第三段又讲甲')
    expect(parsed.text).not.toContain('第二段讲乙')
  })

  it('工具失败只作为观察结果返回，不打断写作', async () => {
    const llm = new ScriptedWriterLlm((request, _index, sectionCalls) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      if (sectionCalls === 0) {
        return { toolCalls: [{ id: 'c1', name: TOOL_READ_SOURCE, arguments: { sourceId: '不存在的来源' } }] }
      }
      const observation = request.messages.find((message) => message.role === 'tool')?.content ?? ''
      return { text: observation.includes('找不到来源') ? '我换个方式写。' : '不该走到这里' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(board.document[0]?.body).toBe('我换个方式写。')
  })

  it('模型调未知工具时返回错误观察而不是崩溃', async () => {
    const llm = new ScriptedWriterLlm((request, _index, sectionCalls) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      if (sectionCalls === 0) return { toolCalls: [{ id: 'c1', name: '不存在的工具', arguments: {} }] }
      const observation = request.messages.find((message) => message.role === 'tool')?.content ?? ''
      return { text: observation.includes('未知工具') ? '好，直接写。' : '不对' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(board.document[0]?.body).toBe('好，直接写。')
  })

  it('工具步数耗尽时强制收稿，并标记 forced', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      // 永远在调工具；只有 toolChoice='none' 时才交稿
      if (request.toolChoice === 'none') return { text: '被迫交出的正文。' }
      return { toolCalls: [{ id: `c${Math.random()}`, name: TOOL_LIST_SOURCES, arguments: {} }] }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)

    expect(board.document[0]?.body).toBe('被迫交出的正文。')
    expect(board.document[0]?.forced).toBe(true)
    expect(task.totalToolCalls).toBe(CONFIG.maxToolSteps)
  })

  it('provider 不支持工具时降级为无工具写作', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      return { text: '无工具模式写出的正文。' }
    }, { supportsTools: false })
    const { ctx, events } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)

    expect(board.document[0]?.body).toBe('无工具模式写出的正文。')
    // 没有任何一次请求带 tools
    expect(llm.calls.every((call) => call.tools === undefined)).toBe(true)
    expect(events.some((event) => event.type === 'log' && event.message.includes('不支持原生工具调用'))).toBe(true)
  })

  it('search_more 会把新来源并入语料库', async () => {
    const search: SearchProvider = {
      id: 's',
      kind: 'search',
      available: () => true,
      search: async (): Promise<SearchResult> => ({
        providerId: 's',
        sources: [{ url: 'https://new.com/1', title: '新来源', snippet: '新摘要' }],
        truncated: false,
      }),
    }
    const fetch = staticFetch({ 'https://new.com/1': '<html><body><p>新抓到的正文</p></body></html>' })
    const llm = new ScriptedWriterLlm((request, _index, sectionCalls) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      if (sectionCalls === 0) {
        return { toolCalls: [{ id: 'c1', name: TOOL_SEARCH_MORE, arguments: { query: '补充查询' } }] }
      }
      const observation = request.messages.find((message) => message.role === 'tool')?.content ?? ''
      return { text: observation.includes('新增') ? '有了新资料，开始写。' : '没拿到新资料' }
    })
    const { ctx } = makeContext({ llm, search, fetch })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)

    expect(board.sources.length).toBe(3)
    expect(board.sources.some((item) => item.url === 'https://new.com/1')).toBe(true)
    expect(board.document[0]?.body).toBe('有了新资料，开始写。')
  })

  it('revise_outline 能改掉某一节的目标', async () => {
    const llm = new ScriptedWriterLlm((request, _index, sectionCalls) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      if (sectionCalls === 0) {
        return {
          toolCalls: [{
            id: 'c1',
            name: TOOL_REVISE_OUTLINE,
            arguments: { sectionId: 'sec-1', goal: '改过的目标' },
          }],
        }
      }
      return { text: '正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(board.outline?.sections[0]?.goal).toBe('改过的目标')
  })
})

describe('写作任务的自检与收尾', () => {
  it('自检不通过时记录原因', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":false,"notes":"缺少来源依据"}' }
      return { text: '一遍过的正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)

    expect(board.document[0]?.selfCheckPassed).toBe(false)
    expect(board.document[0]?.selfCheckNotes).toBe('缺少来源依据')
    // 还有重写余量 → 未满足
    expect(task.isSatisfied(board)).toBe(false)
    expect(task.explain(board)).toContain('待完成')
  })

  it('重写用尽后接受结果，但如实标注未通过', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":false,"notes":"始终不合格"}' }
      return { text: '正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), { ...CONFIG, maxRewriteAttempts: 2 }, new LlmMeter())

    await task.step(board, ctx)
    await task.step(board, ctx)

    expect(task.isSatisfied(board)).toBe(true) // 用尽了重试，接受
    expect(board.document[0]?.selfCheckPassed).toBe(false)
    expect(task.explain(board)).toContain('未通过自检')
  })

  it('重写时会带上上一稿的失败原因', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":false,"notes":"太短了"}' }
      return { text: '正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    await task.step(board, ctx)

    const rewrite = llm.calls.filter((call) => systemOf(call).includes(SECTION_MARK)).at(-1)
    const brief = rewrite?.messages.find((message) => message.role === 'user')?.content ?? ''
    expect(brief).toContain('太短了')
    expect(brief).toContain('上一稿自检未通过')
  })

  it('自检调用本身失败时按未通过处理，绝不宣称通过', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '这不是 JSON' }
      return { text: '正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(board.document[0]?.selfCheckPassed).toBe(false)
    expect(board.document[0]?.selfCheckNotes).toContain('自检未能执行')
  })

  it('模型没有产出正文时如实记为未通过', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      return { text: '' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard()
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(board.document[0]?.selfCheckPassed).toBe(false)
    expect(board.document[0]?.selfCheckNotes).toContain('没有产出正文')
  })

  it('多节时逐节完成，全部通过才满足', async () => {
    const llm = new ScriptedWriterLlm((request) => {
      if (systemOf(request).includes(CHECK_MARK)) return { text: '{"passed":true,"notes":""}' }
      return { text: '正文。' }
    })
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = seedBoard(3)
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(board.document).toHaveLength(1)
    expect(task.isSatisfied(board)).toBe(false)

    await task.step(board, ctx)
    await task.step(board, ctx)
    expect(board.document).toHaveLength(3)
    expect(task.isSatisfied(board)).toBe(true)
    expect(task.explain(board)).toBe('全部小节已通过自检')
  })

  it('没有大纲时不空转', async () => {
    const llm = new ScriptedWriterLlm(() => ({ text: '不该被调用' }))
    const { ctx } = makeContext({ llm, search: unusedSearch, fetch: staticFetch({}) })
    const board = new Blackboard('空')
    const task = new WritingTask(templateById('report'), CONFIG, new LlmMeter())

    await task.step(board, ctx)
    expect(llm.calls).toHaveLength(0)
    expect(task.isSatisfied(board)).toBe(false)
    expect(task.explain(board)).toBe('还没有大纲')
  })
})
