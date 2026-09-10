/**
 * 测试用的确定性插件替身。
 *
 * 它们实现与真实插件完全相同的接口，因此可以在不联网、不需要 API key 的前提下
 * 端到端驱动真实的 pipeline 与输出插件。
 */

import { definePlugin } from '../../src/main/engine/registry.ts'
import type {
  Artifact,
  AvailabilityContext,
  CompleteRequest,
  CompleteResult,
  LlmProvider,
  OrganizeInput,
  OrganizeOutput,
  Organizer,
  OutputPlugin,
  PluginContext,
  PluginManifest,
  Report,
  SearchProvider,
  SearchRequest,
  SearchResult,
  SearchSource,
  ToolCall,
} from '../../src/main/engine/types.ts'

/** 可配置的假搜索插件。 */
export class FakeSearch implements SearchProvider {
  readonly kind = 'search' as const
  readonly calls: SearchRequest[] = []

  constructor(
    readonly id: string,
    private readonly options: {
      available?: boolean
      sources?: readonly SearchSource[]
      error?: Error
    } = {},
  ) {}

  available(_ctx: AvailabilityContext): boolean {
    return this.options.available ?? true
  }

  async search(request: SearchRequest, _ctx: PluginContext, _signal?: AbortSignal): Promise<SearchResult> {
    this.calls.push(request)
    if (this.options.error !== undefined) throw this.options.error
    const sources = this.options.sources ?? []
    const limit = request.maxResults
    const limited = limit === undefined ? sources : sources.slice(0, limit)
    return { providerId: this.id, sources: limited, truncated: limited.length < sources.length }
  }
}

/** 可配置的假大模型插件。 */
export class FakeLlm implements LlmProvider {
  readonly kind = 'provider' as const
  readonly supportsTools = true
  readonly calls: CompleteRequest[] = []

  constructor(
    readonly id: string,
    private readonly options: {
      available?: boolean
      reply?: string | ((request: CompleteRequest, index: number) => string)
      /** 返回工具调用而非文本；与 reply 二选一。 */
      toolCalls?: (request: CompleteRequest, index: number) => readonly ToolCall[] | undefined
      error?: Error
    } = {},
  ) {}

  available(_ctx: AvailabilityContext): boolean {
    return this.options.available ?? true
  }

  async complete(request: CompleteRequest, _ctx: PluginContext, _signal?: AbortSignal): Promise<CompleteResult> {
    const index = this.calls.length
    this.calls.push(request)
    if (this.options.error !== undefined) throw this.options.error

    const toolCalls = this.options.toolCalls?.(request, index)
    if (toolCalls !== undefined && toolCalls.length > 0) {
      return { text: '', model: 'fake-model', toolCalls, usage: { promptTokens: 10, completionTokens: 5 } }
    }

    const reply = this.options.reply ?? '{}'
    return {
      text: typeof reply === 'function' ? reply(request, index) : reply,
      model: 'fake-model',
      usage: { promptTokens: 10, completionTokens: 20 },
    }
  }
}

/** 可配置的假整理插件。 */
export class FakeOrganizer implements Organizer {
  readonly kind = 'organize' as const
  readonly calls: OrganizeInput[] = []

  constructor(
    readonly id: string,
    private readonly options: {
      available?: boolean
      output?: OrganizeOutput
      error?: Error
    } = {},
  ) {}

  available(_ctx: AvailabilityContext): boolean {
    return this.options.available ?? true
  }

  async organize(input: OrganizeInput, _ctx: PluginContext, _signal?: AbortSignal): Promise<OrganizeOutput> {
    this.calls.push(input)
    if (this.options.error !== undefined) throw this.options.error
    return this.options.output ?? {
      title: `报告：${input.query}`,
      summary: `共 ${input.documents.length} 篇正文`,
      sections: [{ heading: '概要', body: '假的整理结果', citations: [] }],
    }
  }
}

/** 记录写入内容的假输出插件。 */
export class FakeOutput implements OutputPlugin {
  readonly kind = 'output' as const
  readonly rendered: Report[] = []

  constructor(
    readonly id: string,
    readonly format: string,
    private readonly extension = 'txt',
  ) {}

  async render(report: Report, ctx: PluginContext, _signal?: AbortSignal): Promise<readonly Artifact[]> {
    this.rendered.push(report)
    return [await ctx.store.writeText(`report.${this.extension}`, `fake ${this.format}`, this.format)]
  }
}

/** 把插件实例包成清单。 */
export function manifestOf(entry: { id: string; kind: string }, title = entry.id): PluginManifest {
  return definePlugin({
    id: entry.id,
    // 假插件与真实插件一样受清单校验约束，因此这里直接沿用实例声明。
    kind: entry.kind as PluginManifest['kind'],
    version: '0.0.0',
    title,
    description: `测试替身 ${entry.id}`,
    entry: entry as PluginManifest['entry'],
  })
}

/** 一批常用来源，供抓取/整理测试复用。 */
export const SAMPLE_SOURCES: readonly SearchSource[] = [
  { url: 'https://example.com/a', title: '来源 A', snippet: '关于 A 的摘要' },
  { url: 'https://example.com/b', title: '来源 B', snippet: '关于 B 的摘要' },
  { url: 'https://example.com/c', title: '来源 C' },
]
