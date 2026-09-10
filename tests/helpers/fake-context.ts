/**
 * 测试用的 PluginContext 构造器。
 *
 * 自主任务需要 llm / search / fetch / events / log，但不需要真实的 run 目录与输出插件。
 * 把它做成共享助手，是因为搜索、大纲、写作三个任务的测试都要用同一套。
 */

import { SimpleEventBus } from '../../src/main/engine/events.ts'
import { createLogger } from '../../src/main/engine/events.ts'
import { DEFAULT_CONFIG } from '../../src/main/engine/config.ts'
import type {
  AppConfig,
  Artifact,
  EventBus,
  FetchService,
  LlmProvider,
  Logger,
  Organizer,
  OutputPlugin,
  PluginConfigView,
  PluginContext,
  RunEvent,
  RunStore,
  SearchProvider,
} from '../../src/main/engine/types.ts'

/** 内存 run 仓库：任务测试不关心文件系统。 */
export class MemoryRunStore implements RunStore {
  readonly dir = '/memory-run'
  readonly files = new Map<string, string>()

  async ensure(): Promise<void> {}
  async writeText(relPath: string, content: string, format?: string): Promise<Artifact> {
    this.files.set(relPath, content)
    return { path: relPath, format: format ?? 'text', bytes: content.length }
  }
  async writeJson(relPath: string, value: unknown): Promise<Artifact> {
    return this.writeText(relPath, JSON.stringify(value), 'json')
  }
  async appendLine(relPath: string, line: string): Promise<void> {
    this.files.set(relPath, `${this.files.get(relPath) ?? ''}${line}\n`)
  }
  async list(): Promise<readonly Artifact[]> {
    return [...this.files.entries()].map(([path, content]) => ({ path, format: 'text', bytes: content.length }))
  }
}

/** 什么都不做的日志器（需要完全静音时用）。 */
const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** 构造依赖。 */
export interface ContextOptions {
  readonly llm: LlmProvider
  readonly search: SearchProvider
  readonly fetch: FetchService
  readonly config?: AppConfig
  readonly store?: RunStore
  readonly logger?: Logger
}

/** 构造结果。 */
export interface TestContext {
  readonly ctx: PluginContext
  readonly bus: SimpleEventBus
  readonly events: RunEvent[]
  readonly store: MemoryRunStore
}

/** 造一个可用的 PluginContext，并收集发出的事件。 */
export function makeContext(options: ContextOptions): TestContext {
  const bus = new SimpleEventBus()
  const events: RunEvent[] = []
  bus.on((event) => events.push(event))

  const store = (options.store as MemoryRunStore | undefined) ?? new MemoryRunStore()
  const config = options.config ?? DEFAULT_CONFIG
  const configView: PluginConfigView = {
    section: <T extends Record<string, unknown>>(pluginId: string): T =>
      ((config.plugins[pluginId] ?? {}) as unknown) as T,
    all: () => config,
  }

  const unusedOrganizer: Organizer = {
    id: 'unused',
    kind: 'organize',
    available: () => false,
    organize: async () => {
      throw new Error('测试里不应调用 organize')
    },
  }

  const ctx: PluginContext = {
    runId: 'test-run',
    config: configView,
    store,
    events: bus,
    // 默认用真实日志器接到事件总线上：与内核行为一致，
    // 测试才能断言「降级时确实发了警告」这类可观测性要求。
    log: options.logger ?? createLogger(bus, '[test] ', [], false),
    fetch: options.fetch,
    search: () => options.search,
    llm: () => options.llm,
    organize: () => unusedOrganizer,
    organizeFallback: () => undefined,
    outputs: (): readonly OutputPlugin[] => [],
    active: () => ({
      pipeline: 'test',
      search: options.search.id,
      searchFallbackUsed: false,
      provider: options.llm.id,
      organize: unusedOrganizer.id,
      outputs: [],
    }),
  }

  return { ctx, bus, events, store }
}

/** 仅供类型引用。 */
export type { EventBus }
