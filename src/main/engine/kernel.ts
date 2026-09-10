/**
 * 内核：装配注册表、配置与运行期选择，并对外提供一次运行（run）的入口。
 *
 * 内核不含任何领域知识——它不知道「搜索」背后是 DeepSeek 还是 DuckDuckGo，
 * 只知道配置里写着哪个 id、那个插件是否 `available()`。所有领域逻辑都在插件里。
 */

import { join } from 'node:path'
import { ENGINE_VERSION, createPluginConfigView } from './config.ts'
import { collectSecrets, createLogger, redactSecrets, SimpleEventBus } from './events.ts'
import { HttpFetchService } from './fetch.ts'
import { ResearcherError, toResearcherError } from './errors.ts'
import { PluginRegistry } from './registry.ts'
import { FileRunStore } from './run-store.ts'
import type {
  ActiveSelection,
  AnyPlugin,
  AppConfig,
  Artifact,
  AvailabilityContext,
  EventBus,
  FetchService,
  LlmProvider,
  Logger,
  Organizer,
  OutputPlugin,
  Pipeline,
  PluginConfigSection,
  PluginContext,
  PluginInfo,
  PluginKind,
  Report,
  RunInput,
  SearchProvider,
} from './types.ts'

/** 可以查询可用性的类别（pipeline/output 没有 available 概念）。 */
type AvailabilityKind = 'search' | 'provider' | 'organize'

/** 构造内核所需的依赖。 */
export interface KernelOptions {
  readonly registry: PluginRegistry
  readonly config: AppConfig
  /** 数据根目录：配置与 runs 都在它下面。 */
  readonly dataRoot: string
  /** 是否把日志同时打到控制台（测试时关掉）。 */
  readonly mirrorLogsToConsole?: boolean
  /** 注入抓取实现，测试用。 */
  readonly fetchService?: FetchService
}

/** 一次运行的结果。 */
export interface RunOutcome {
  readonly runId: string
  readonly runDir: string
  readonly report: Report
  readonly artifacts: readonly Artifact[]
}

/** 引擎内核。 */
export class Kernel {
  readonly registry: PluginRegistry
  private config: AppConfig
  private readonly dataRoot: string
  private readonly mirrorLogsToConsole: boolean
  /** 外部注入的抓取服务（测试用）；注入后不受配置变更影响。 */
  private readonly injectedFetch: FetchService | undefined
  private fetchServiceInternal: FetchService
  /** 当前运行的日志器：抓取重试要写进这次运行的日志里。 */
  private activeLogger: Logger | undefined

  constructor(options: KernelOptions) {
    this.registry = options.registry
    this.config = options.config
    this.dataRoot = options.dataRoot
    this.mirrorLogsToConsole = options.mirrorLogsToConsole ?? true
    this.injectedFetch = options.fetchService
    this.fetchServiceInternal = options.fetchService ?? this.buildFetchService(options.config)
  }

  /**
   * 按给定配置构造抓取服务。
   *
   * 超时、体积上限、重试次数都来自配置，因此配置变更时必须重建服务，
   * 否则界面上改了设置、实际行为却要重启应用才生效。
   */
  private buildFetchService(config: AppConfig): HttpFetchService {
    return new HttpFetchService({
      timeoutMs: config.fetch.timeoutMs,
      maxBytes: config.fetch.maxBytes,
      maxTextChars: config.fetch.maxTextChars,
      maxRetries: config.fetch.maxRetries,
      userAgent: config.fetch.userAgent,
      onRetry: (info) => {
        this.activeLogger?.warn(
          `抓取重试 ${info.attempt}/${info.maxAttempts}：${info.url}（${info.reason}），${info.delayMs}ms 后再试`,
        )
      },
    })
  }

  /** 当前配置（只读用途）。 */
  get currentConfig(): AppConfig {
    return this.config
  }

  /** 替换配置（下次运行生效；抓取参数会立即重建）。 */
  setConfig(config: AppConfig): void {
    this.config = config
    if (this.injectedFetch === undefined) {
      this.fetchServiceInternal = this.buildFetchService(config)
    }
  }

  /** run 存放的根目录。 */
  get runsRoot(): string {
    return join(this.dataRoot, 'runs')
  }

  /** 内核提供的抓取服务（界面/探测用）。 */
  get fetchService(): FetchService {
    return this.fetchServiceInternal
  }

  /**
   * 对单个插件做一次真实的连通性探测。
   *
   * 注意这是**真的会发请求**（搜索插件会真的搜一次、大模型插件会真的调用一次），
   * 因此界面必须如实告知用户，而不是把它当成免费的本地检查。
   * `available()` 才是免费的本地检查。
   */
  async probe(kind: 'search' | 'provider', id: string, signal?: AbortSignal): Promise<string> {
    const manifest = this.registry.requireManifest(kind, id)
    if (!this.isPluginAvailable(kind, id)) {
      throw new ResearcherError(`插件 ${id} 当前不可用（配置不完整），请先补全设置再测试`, 'CONFIG_INVALID')
    }
    const ctx = this.createProbeContext()

    if (kind === 'search') {
      const provider = manifest.entry as SearchProvider
      const result = await provider.search({ query: 'connectivity test', maxResults: 1 }, ctx, signal)
      return `连接成功，返回 ${result.sources.length} 个来源`
    }

    const provider = manifest.entry as LlmProvider
    const result = await provider.complete(
      { messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, temperature: 0 },
      ctx,
      signal,
    )
    return `连接成功，模型 ${result.model} 已响应`
  }

  /** 为探测构造一个一次性上下文：产物写进 probe 目录，不污染正式 run。 */
  private createProbeContext(): PluginContext {
    const store = new FileRunStore(join(this.dataRoot, 'probe'))
    const bus = new SimpleEventBus()
    const log = createLogger(bus, '[probe] ', collectSecrets(this.config.plugins), false)
    return {
      runId: 'probe',
      config: createPluginConfigView(this.config),
      store,
      events: bus,
      log,
      fetch: this.fetchServiceInternal,
      search: () => this.registry.requireEntry<SearchProvider>('search', this.config.search.id),
      llm: () => this.registry.requireEntry<LlmProvider>('provider', this.config.provider.id),
      organize: () => this.registry.requireEntry<Organizer>('organize', this.config.organize.id),
      organizeFallback: () => undefined,
      outputs: () => [],
      active: () => ({
        pipeline: this.config.pipeline.id,
        search: this.config.search.id,
        searchFallbackUsed: false,
        organize: this.config.organize.id,
        outputs: [],
      }),
    }
  }

  /** 列出全部插件及其可用性/活动状态，供界面「插件面板」展示。 */
  pluginInfos(): readonly PluginInfo[] {
    return this.registry.list().map((manifest) => ({
      id: manifest.id,
      kind: manifest.kind,
      version: manifest.version,
      title: manifest.title,
      description: manifest.description,
      available: this.isPluginAvailable(manifest.kind, manifest.id),
      active: this.isActive(manifest.id, manifest.kind),
    }))
  }

  /**
   * 某个插件是否可用。
   *
   * 会递归解析它通过 `isAvailable()` 声明的依赖（例如 organize-llm → provider），
   * 并用 `seen` 防止配置写出循环依赖时无限递归。
   */
  isPluginAvailable(kind: PluginKind, id: string, seen: ReadonlySet<string> = new Set()): boolean {
    if (kind !== 'search' && kind !== 'provider' && kind !== 'organize') return true
    const manifest = this.registry.find(kind, id)
    if (manifest === undefined) return false

    const key = `${kind}/${id}`
    if (seen.has(key)) return false
    const nextSeen = new Set(seen).add(key)

    const candidate = manifest.entry as { available?: unknown }
    if (typeof candidate.available !== 'function') return true

    const availability: AvailabilityContext = {
      section: this.sectionOf(id),
      isAvailable: (depKind, depId) =>
        this.isPluginAvailable(depKind, depId ?? this.activeIdOf(depKind), nextSeen),
    }

    try {
      return (candidate.available as (ctx: AvailabilityContext) => boolean)(availability) === true
    } catch {
      return false
    }
  }

  /** 读取某个插件的配置段（不存在时给空对象，插件自行套缺省值）。 */
  private sectionOf(pluginId: string): PluginConfigSection {
    return this.config.plugins[pluginId] ?? {}
  }

  /** 某类别当前配置的活动插件 id。 */
  private activeIdOf(kind: AvailabilityKind): string {
    switch (kind) {
      case 'search':
        return this.config.search.id
      case 'provider':
        return this.config.provider.id
      case 'organize':
        return this.config.organize.id
    }
  }

  /** 某个插件在当前配置下是否是活动插件。 */
  private isActive(id: string, kind: PluginKind): boolean {
    switch (kind) {
      case 'pipeline':
        return this.config.pipeline.id === id
      case 'search':
        return this.config.search.id === id || this.config.search.fallback === id
      case 'provider':
        return this.config.provider.id === id
      case 'organize':
        return this.config.organize.id === id || this.config.organize.fallback === id
      case 'output':
        return this.config.output.ids.includes(id)
    }
  }

  /**
   * 执行一次运行。
   *
   * 事件通过 `bus` 实时发出（界面据此渲染进度）；运行失败时抛出类型化错误，
   * 但在此之前已经落盘的产物一律保留。
   */
  async run(input: RunInput, bus: EventBus, signal?: AbortSignal): Promise<RunOutcome> {
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (query.length === 0) {
      throw new ResearcherError('查询不能为空', 'INVALID_INPUT')
    }
    if (query.length > 2000) {
      throw new ResearcherError(`查询过长（${query.length} 字符，上限 2000）`, 'INVALID_INPUT')
    }

    const secrets = collectSecrets(this.config.plugins)
    const log = createLogger(bus, '[kernel] ', secrets, this.mirrorLogsToConsole)
    // 让抓取重试在本次运行的日志里可见
    this.activeLogger = log

    const pipeline = this.registry.requireEntry<Pipeline>('pipeline', this.config.pipeline.id)
    const runId = makeRunId()
    const store = new FileRunStore(join(this.runsRoot, runId))
    await store.ensure()

    const scope = new RunScope({
      registry: this.registry,
      config: this.config,
      log,
      isAvailable: (kind, id) => this.isPluginAvailable(kind, id),
    })

    const ctx: PluginContext = {
      runId,
      config: createPluginConfigView(this.config),
      store,
      events: bus,
      log,
      fetch: this.fetchServiceInternal,
      search: () => scope.search().provider,
      llm: () => scope.llm(),
      organize: () => scope.organize(),
      organizeFallback: () => scope.organizeFallback(),
      outputs: () => scope.outputs(),
      active: () => scope.active(),
    }

    // 事件同时落盘成 events.jsonl：事后排查以文件为准，不依赖界面是否开着。
    const unsubscribe = bus.on((event) => {
      void store.appendLine('events.jsonl', JSON.stringify(event)).catch(() => {
        /* 事件落盘失败不应影响运行 */
      })
    })

    bus.emit({ type: 'run:start', runId, query, pipeline: pipeline.id })
    try {
      const report = await pipeline.run({ ...input, query }, ctx, signal)
      await store.writeJson('report.json', report)
      await store.writeJson('provenance.json', report.provenance)
      const artifacts = await store.list()
      // 先记日志再发终止事件：`run:done` 必须是本次运行的最后一个事件，
      // 否则界面按它收尾后还会收到游离事件。
      log.info(`运行完成，产物 ${artifacts.length} 个：${store.dir}`)
      bus.emit({ type: 'run:done', report, artifacts })
      return { runId, runDir: store.dir, report, artifacts }
    } catch (error) {
      const normalized = toResearcherError(error)
      const message = redactSecrets(normalized.message, secrets)
      log.error(`运行失败（${normalized.code}）：${message}`)
      bus.emit({ type: 'run:error', code: normalized.code, message })
      throw normalized
    } finally {
      unsubscribe()
      this.activeLogger = undefined
    }
  }
}

/** 构造 RunScope 的依赖。 */
interface RunScopeOptions {
  readonly registry: PluginRegistry
  readonly config: AppConfig
  readonly log: Logger
  readonly isAvailable: (kind: AvailabilityKind, id: string) => boolean
}

/**
 * 一次运行范围内的插件解析结果。
 *
 * 解析结果会被缓存：整次运行使用同一组插件，避免「搜索用 A、整理用 B」这种中途切换。
 */
class RunScope {
  private searchSelection?: { provider: SearchProvider; fallbackUsed: boolean }
  private llmSelection?: LlmProvider
  private organizeSelection?: Organizer
  private fallbackOrganizeResolved?: Organizer | undefined
  private outputSelection?: readonly OutputPlugin[]
  private readonly options: RunScopeOptions

  constructor(options: RunScopeOptions) {
    this.options = options
  }

  /** 解析活动搜索插件，主插件不可用时降到备用插件。 */
  search(): { provider: SearchProvider; fallbackUsed: boolean } {
    if (this.searchSelection !== undefined) return this.searchSelection
    const { config, log, isAvailable } = this.options

    const primaryId = config.search.id
    const primary = this.options.registry.requireEntry<SearchProvider>('search', primaryId)
    if (isAvailable('search', primaryId)) {
      this.searchSelection = { provider: primary, fallbackUsed: false }
      return this.searchSelection
    }

    const fallbackId = config.search.fallback
    if (fallbackId !== undefined && fallbackId !== primaryId && this.options.registry.has('search', fallbackId)) {
      if (isAvailable('search', fallbackId)) {
        log.warn(`搜索插件 ${primaryId} 不可用，已降级到 ${fallbackId}`)
        this.searchSelection = {
          provider: this.options.registry.requireEntry<SearchProvider>('search', fallbackId),
          fallbackUsed: true,
        }
        return this.searchSelection
      }
    }

    throw new ResearcherError(
      `没有可用的搜索插件：${primaryId} 不可用`
      + (fallbackId !== undefined ? `，备用 ${fallbackId} 也不可用` : '（未配置备用插件）')
      + '。请在设置中填写 API key，或把备用搜索插件设为 search-duckduckgo。',
      'SEARCH_UNAVAILABLE',
    )
  }

  /** 解析活动大模型插件。 */
  llm(): LlmProvider {
    if (this.llmSelection !== undefined) return this.llmSelection
    const providerId = this.options.config.provider.id
    const provider = this.options.registry.requireEntry<LlmProvider>('provider', providerId)
    if (!this.options.isAvailable('provider', providerId)) {
      throw new ResearcherError(
        `大模型插件 ${providerId} 不可用：缺少 API key 或 base URL 不合法。`
        + '请在设置中填写，或把整理插件切换为 organize-extractive（无需大模型）。',
        'LLM_UNAVAILABLE',
      )
    }
    this.llmSelection = provider
    return provider
  }

  /** 解析活动整理插件；主插件不可用时自动降级。 */
  organize(): Organizer {
    if (this.organizeSelection !== undefined) return this.organizeSelection
    const primaryId = this.options.config.organize.id
    const primary = this.options.registry.requireEntry<Organizer>('organize', primaryId)
    if (this.options.isAvailable('organize', primaryId)) {
      this.organizeSelection = primary
      return primary
    }

    const fallback = this.organizeFallback()
    if (fallback !== undefined) {
      this.options.log.warn(`整理插件 ${primaryId} 不可用，已降级到 ${fallback.id}`)
      this.organizeSelection = fallback
      return fallback
    }

    throw new ResearcherError(
      `没有可用的整理插件：${primaryId} 不可用（通常是缺少 API key 或大模型 provider 不可用）。`
      + '请在设置中填写 API key，或把整理插件切换为 organize-extractive。',
      'LLM_UNAVAILABLE',
    )
  }

  /** 配置的降级整理插件，未配置或不可用时返回 undefined。 */
  organizeFallback(): Organizer | undefined {
    if (this.fallbackOrganizeResolved !== undefined) return this.fallbackOrganizeResolved
    const { config, registry, isAvailable } = this.options
    const fallbackId = config.organize.fallback
    if (fallbackId === undefined || fallbackId === config.organize.id) return undefined
    if (!registry.has('organize', fallbackId)) return undefined
    const fallback = registry.requireEntry<Organizer>('organize', fallbackId)
    const resolved = isAvailable('organize', fallbackId) ? fallback : undefined
    this.fallbackOrganizeResolved = resolved
    return resolved
  }

  /** 全部启用的输出插件。 */
  outputs(): readonly OutputPlugin[] {
    if (this.outputSelection !== undefined) return this.outputSelection
    const plugins: OutputPlugin[] = []
    for (const id of this.options.config.output.ids) {
      const manifest = this.options.registry.find('output', id)
      if (manifest === undefined) {
        this.options.log.warn(`配置里启用了未注册的输出插件 ${id}，已跳过`)
        continue
      }
      plugins.push(manifest.entry as OutputPlugin)
    }
    if (plugins.length === 0) {
      throw new ResearcherError('没有可用的输出插件：请检查 output.ids 配置', 'OUTPUT_FAILED')
    }
    this.outputSelection = plugins
    return plugins
  }

  /** 本次运行实际选中的插件 id（尽力反映已解析的结果）。 */
  active(): ActiveSelection {
    const search = this.searchSelection
    const organize = this.organizeSelection
    const outputs = this.outputSelection
    return {
      pipeline: this.options.config.pipeline.id,
      search: search?.provider.id ?? this.options.config.search.id,
      searchFallbackUsed: search?.fallbackUsed ?? false,
      ...(this.llmSelection === undefined ? {} : { provider: this.llmSelection.id }),
      organize: organize?.id ?? this.options.config.organize.id,
      outputs: (outputs ?? []).map((plugin) => plugin.id),
    }
  }
}

/** 生成文件系统安全、且按时间可排序的 run id。 */
export function makeRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const random = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${random}`
}

export { ENGINE_VERSION }
export type { AnyPlugin }
