/**
 * provider 原生工具调用的线格式测试。
 *
 * 只测映射函数（请求体构造 + 响应解析），不发网络请求：
 * 这两处是最容易出错、也最容易被真实调用掩盖的地方。
 */

import { describe, expect, it } from 'vitest'
import { parseToolCalls, toWireMessage } from '../src/plugins/provider-openai/index.ts'

describe('工具调用响应解析', () => {
  it('解析正常的函数调用', () => {
    const calls = parseToolCalls([
      { id: 'call_1', function: { name: 'search_more', arguments: '{"query":"WebGPU","k":5}' } },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'call_1', name: 'search_more' })
    expect(calls[0]?.arguments).toEqual({ query: 'WebGPU', k: 5 })
  })

  it('参数是非法 JSON 时保留原文，不静默当成空参数', () => {
    const calls = parseToolCalls([{ id: 'c', function: { name: 'read_source', arguments: '{坏的' } }])
    expect(calls[0]?.arguments).toBeUndefined()
    expect(calls[0]?.rawArguments).toBe('{坏的')
  })

  it('缺 id 时补一个稳定 id', () => {
    const calls = parseToolCalls([{ function: { name: 'list_sources' } }])
    expect(calls[0]?.id).toBe('call_0')
    expect(calls[0]?.name).toBe('list_sources')
  })

  it('跳过没有名字的项，而不是产生半个调用', () => {
    expect(parseToolCalls([{ id: 'x', function: {} }])).toEqual([])
  })

  it('空参数与未提供都视为无参数', () => {
    expect(parseToolCalls([{ id: 'a', function: { name: 'x', arguments: '  ' } }])[0]?.arguments).toBeUndefined()
    expect(parseToolCalls([{ id: 'a', function: { name: 'x' } }])[0]?.arguments).toBeUndefined()
  })

  it('undefined / 空数组安全返回', () => {
    expect(parseToolCalls(undefined)).toEqual([])
    expect(parseToolCalls([])).toEqual([])
  })

  it('一次多个工具调用全部保留，顺序不变', () => {
    const calls = parseToolCalls([
      { id: '1', function: { name: 'a', arguments: '{}' } },
      { id: '2', function: { name: 'b', arguments: '{}' } },
    ])
    expect(calls.map((call) => call.name)).toEqual(['a', 'b'])
  })
})

describe('工具调用请求形状', () => {
  it('assistant 带工具调用且无正文时 content 置为 null', () => {
    const wire = toWireMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'search_more', arguments: { query: 'x' } }],
    })
    expect(wire['content']).toBeNull()
    expect(wire['tool_calls']).toEqual([
      { id: 'c1', type: 'function', function: { name: 'search_more', arguments: '{"query":"x"}' } },
    ])
  })

  it('assistant 有正文时照常保留', () => {
    const wire = toWireMessage({ role: 'assistant', content: '我想先搜一下' })
    expect(wire['content']).toBe('我想先搜一下')
    expect(wire['tool_calls']).toBeUndefined()
  })

  it('工具结果消息带上 tool_call_id', () => {
    const wire = toWireMessage({ role: 'tool', content: '{"ok":true}', toolCallId: 'c1' })
    expect(wire['tool_call_id']).toBe('c1')
    expect(wire['role']).toBe('tool')
  })

  it('已有原始参数串时原样透传，不重新序列化', () => {
    const wire = toWireMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'x', rawArguments: '{"a": 1 }' }],
    })
    const calls = wire['tool_calls'] as { function: { arguments: string } }[]
    expect(calls[0]?.function.arguments).toBe('{"a": 1 }')
  })
})
