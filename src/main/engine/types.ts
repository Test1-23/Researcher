/**
 * 稳定契约层（seam）。
 *
 * 这是内核与全部插件共享的唯一词汇表：任何插件只依赖本文件，插件之间互不 import。
 * 换掉一个搜索后端、整理策略或输出格式，都不需要改动内核或其它插件。
 *
 * 本文件刻意不 import 任何其它模块，这样它可以被渲染进程、测试与插件安全引用而不产生循环依赖。
 */

/** 插件类别。每个类别对应下面一个接口。 */
export type PluginKind = 'pipeline' | 'search' | 'provider' | 'organize' | 'output'

/** 全部类别，供注册表校验使用。 */
export const PLUGIN_KINDS: readonly PluginKind[] = ['pipeline', 'search', 'provider', 'organize', 'output']

// ─────────────────────────────── 搜索 ───────────────────────────────

/** 一次搜索请求。每个请求只含一个查询；需要多查询时由调用方发起多次。 */
export interface SearchRequest {
  readonly query: string
  /** 返回来源数量上限；由内核在结果返回后强制截断。 */
  readonly maxResults?: number
}

/** 一个可引用的来源。只有 url 是必需的——不是每个后端都返回标题与摘要。 */
export interface SearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** 后端给出的发布时间/抓取时间（ISO-8601 字符串）。 */
  readonly publishedAt?: string
}

/** 归一化后的搜索结果。 */
export interface SearchResult {
  /** 本次实际提供结果的插件 id。 */
  readonly providerId: string
  readonly sources: readonly SearchSource[]
  /** 结果被截断到 maxResults 时为 true。 */
  readonly truncated: boolean
}

/**
 * 插件自己的配置段（只读）。
 *
 * `available()` 拿不到运行上下文，因此由内核把插件自己那一段配置传进来；
 * 插件据此判断「我能不能工作」，但绝不能在这里发网络请求。
 */
export type PluginConfigSection = Readonly<Record<string, unknown>>

/**
 * `available()` 的入参。
 *
 * 除了自己的配置段，插件还可以查询「我依赖的那个插件现在能不能用」——
 * 例如 organize-llm 需要大模型 provider 可用。这是通过内核查询，而不是 import 对方，
 * 因此替换 provider 不会影响 organize-llm。
 */
export interface AvailabilityContext {
  /** 本插件自己的配置段。 */
  readonly section: PluginConfigSection
  /** 查询某类别下某个插件是否可用；不传 id 表示「当前配置里的活动插件」。 */
  isAvailable(kind: 'search' | 'provider' | 'organize', id?: string): boolean
}

/**
 * 一个可搜索的后端。插件实现本接口并在注册表中登记。
 * `id` 在同一类别内唯一且稳定。
 */
export interface SearchProvider {
  readonly id: string
  readonly kind: 'search'
  /** 廉价的本地可用性检查：只看配置，不得发起网络请求。 */
  available(ctx: AvailabilityContext): boolean
  /** 执行一次搜索；必须响应 `signal` 以支持取消。 */
  search(req: SearchRequest, ctx: PluginContext, signal?: AbortSignal): Promise<SearchResult>
}

// ─────────────────────────── 大模型 provider ───────────────────────────

/** 一条对话消息（OpenAI 兼容形状的子集）。 */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  /** `role='assistant'` 时：模型要求调用的工具。 */
  readonly toolCalls?: readonly ToolCall[]
  /** `role='tool'` 时：这条结果对应哪次调用。 */
  readonly toolCallId?: string
}

/**
 * 一个可被模型调用的工具。
 *
 * `parameters` 是 JSON Schema——直接透传给 OpenAI 兼容端点，不做任何加工。
 */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/** 模型发起的一次工具调用。 */
export interface ToolCall {
  readonly id: string
  readonly name: string
  /** 已解析的参数；模型给出非法 JSON 时为 undefined。 */
  readonly arguments?: unknown
  /** 原始参数串：解析失败时保留下来便于排查。 */
  readonly rawArguments?: string
}

/** 一次补全请求。 */
export interface CompleteRequest {
  readonly messages: readonly ChatMessage[]
  /** 要求模型返回 JSON 对象（OpenAI 兼容的 response_format）。 */
  readonly json?: boolean
  readonly temperature?: number
  readonly maxTokens?: number
  /** 本次允许模型调用的工具；为空表示不启用工具调用。 */
  readonly tools?: readonly ToolSpec[]
  /** `none` 用于逼模型直接产出内容而不调工具（例如步数将尽时的强制收稿）。 */
  readonly toolChoice?: 'auto' | 'none'
}

/** token 用量，用于成本可见性。 */
export interface TokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
}

/** 一次补全结果。 */
export interface CompleteResult {
  readonly text: string
  /** 实际使用的模型名，写入 provenance。 */
  readonly model: string
  readonly usage?: TokenUsage
  /** 模型要求调用的工具；非空时 `text` 可能为空串。 */
  readonly toolCalls?: readonly ToolCall[]
}

/** 一个大模型后端。OpenAI 兼容适配器即实现本接口。 */
export interface LlmProvider {
  readonly id: string
  readonly kind: 'provider'
  /**
   * 是否支持**原生**工具调用。
   *
   * 不做提示词模拟：那正是「不该手写」的同一个错误。不支持时上层降级为
   * 无工具模式，并如实记录。
   */
  readonly supportsTools: boolean
  /** 廉价的本地可用性检查：只看配置，不得发起网络请求。 */
  available(ctx: AvailabilityContext): boolean
  complete(req: CompleteRequest, ctx: PluginContext, signal?: AbortSignal): Promise<CompleteResult>
}

// ─────────────────────────────── 整理 ───────────────────────────────

/** 抓取成功的一份正文。 */
export interface FetchedDocument {
  /** 跟随重定向后的最终 URL。 */
  readonly url: string
  /** 它是从哪个来源 URL 抓来的。重定向后与 `url` 可能不同，整理阶段靠它对应回来源。 */
  readonly sourceUrl?: string
  readonly status: number
  readonly title?: string
  /** 抽取出的纯文本正文（可能被截断）。 */
  readonly text: string
  readonly truncated: boolean
  /** 实际使用的抽取实现，进入 provenance 供读者判断可信度。 */
  readonly extraction?: 'readability' | 'plain-text'
  /** 为什么没用首选的抽取实现。 */
  readonly extractionFallbackReason?: string
}

/** 一次抓取失败。失败不致命，会被记录并交给整理阶段参考。 */
export interface FetchFailure {
  readonly url: string
  readonly reason: string
  readonly status?: number
}

/** 整理阶段的输入：查询 + 来源 + 已抓正文 + 抓取失败清单。 */
export interface OrganizeInput {
  readonly query: string
  readonly sources: readonly SearchSource[]
  readonly documents: readonly FetchedDocument[]
  readonly failures: readonly FetchFailure[]
}

/** 报告中的一节。citations 必须是输入中出现过的 url。 */
export interface ReportSection {
  readonly heading: string
  readonly body: string
  readonly citations: readonly string[]
}

/** 整理阶段的元信息，写入 provenance。 */
export interface OrganizeMeta {
  readonly pluginId?: string
  readonly model?: string
  readonly usage?: TokenUsage
  /** 非空表示本次整理被降级，值为降级原因。 */
  readonly degraded?: string
  /** LLM 整理的尝试次数。 */
  readonly attempts?: number
}

/** 整理结果：报告的结构化形态。 */
export interface OrganizeOutput {
  readonly title: string
  readonly summary: string
  readonly sections: readonly ReportSection[]
  readonly meta?: OrganizeMeta
}

/** 一个整理策略。既有基于大模型的，也有零依赖的抽取式实现。 */
export interface Organizer {
  readonly id: string
  readonly kind: 'organize'
  /** 廉价的本地可用性检查：只看配置，不得发起网络请求。 */
  available(ctx: AvailabilityContext): boolean
  organize(input: OrganizeInput, ctx: PluginContext, signal?: AbortSignal): Promise<OrganizeOutput>
}

// ─────────────────────────────── 输出 ───────────────────────────────

/** 一个已落盘的产物。 */
export interface Artifact {
  /** 相对 run 目录的路径。 */
  readonly path: string
  /** 产物格式，通常等于输出插件的 format。 */
  readonly format: string
  readonly bytes: number
}

/** 一个输出格式插件。可同时启用多个。 */
export interface OutputPlugin {
  readonly id: string
  readonly kind: 'output'
  /** 格式标识（markdown / html / json ...），同时决定文件扩展名。 */
  readonly format: string
  render(report: Report, ctx: PluginContext, signal?: AbortSignal): Promise<readonly Artifact[]>
}

// ─────────────────────────── 报告与来源记录 ───────────────────────────

/** 本次运行实际使用了哪些插件与模型——报告的可信度取决于此。 */
export interface Provenance {
  readonly engine: string
  readonly pipeline: string
  readonly search: string
  /** true 表示主搜索插件不可用，实际使用了备用插件。 */
  readonly searchFallbackUsed: boolean
  readonly provider?: string
  readonly organize: string
  readonly outputs: readonly string[]
  readonly model?: string
  readonly usage?: TokenUsage
  readonly degraded?: string
  readonly generatedAt: string
  /** 使用的文档模板 id（代理式主流程才有）。 */
  readonly template?: string
  /** 代理式主流程的观测数据：让读者判断这次产出值多少信任。 */
  readonly agentic?: AgenticProvenance
}

/** 代理式主流程的运行观测。 */
export interface AgenticProvenance {
  /** 不动点迭代了几轮。 */
  readonly iterations: number
  /** 收敛 / 卡死 / 撞上护栏。 */
  readonly outcome: 'converged' | 'stalled' | 'limits'
  readonly outcomeMessage: string
  /** 搜索进行了多少轮。 */
  readonly searchRounds: number
  /** 话题地图的规模。 */
  readonly mapNodes: number
  readonly gaps: number
  readonly conflicts: number
  /** 写作阶段的工具调用次数。 */
  readonly toolCalls: number
  /** 大模型调用次数与 token 用量。 */
  readonly llmCalls: number
  readonly promptTokens: number
  readonly completionTokens: number
  /** 抽取实现分布：多少篇走了 Readability，多少篇回退到纯文本。 */
  readonly extraction: { readonly readability: number; readonly plainText: number }
  /** 每个任务自己报告的状态与停下的理由。 */
  readonly tasks: readonly {
    readonly name: string
    readonly steps: number
    readonly satisfied: boolean
    readonly reason: string
  }[]
}

/** 一个输出插件渲染失败。 */
export interface OutputFailure {
  readonly plugin: string
  readonly reason: string
}

/** 一次运行的最终产物。 */
export interface Report {
  readonly runId: string
  readonly query: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly sources: readonly SearchSource[]
  readonly documents: readonly FetchedDocument[]
  readonly failures: readonly FetchFailure[]
  readonly synthesis: OrganizeOutput
  readonly provenance: Provenance
  /**
   * 渲染失败的输出插件。
   *
   * 单个格式失败不让整轮运行失败——报告已经算完了，不该因为一个渲染器出错就全丢。
   */
  readonly outputFailures?: readonly OutputFailure[]
}

// ─────────────────────────────── 主 pipeline ───────────────────────────────

/** 一次运行的输入。可选字段用于按次覆盖配置上限。 */
export interface RunInput {
  readonly query: string
  readonly maxSources?: number
  readonly maxFetch?: number
  readonly formats?: readonly string[]
}

/** 主 pipeline：编排阶段顺序。本身也是插件，因此可以整体替换。 */
export interface Pipeline {
  readonly id: string
  readonly kind: 'pipeline'
  /**
   * 这条主流程现在可用吗。
   *
   * 代理式主流程依赖大模型；没有 key 时它为假，内核会自动降到配置的备用主流程。
   * 默认实现（无依赖）返回 true。
   */
  available(ctx: AvailabilityContext): boolean
  run(input: RunInput, ctx: PluginContext, signal?: AbortSignal): Promise<Report>
}

// ─────────────────────────────── 内核服务 ───────────────────────────────

/** 日志接口。实现负责脱敏。 */
export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** 运行过程中发出的事件载荷（`at` 由事件总线补上）。 */
export type RunEventPayload =
  | { readonly type: 'run:start'; readonly runId: string; readonly query: string; readonly pipeline: string }
  | { readonly type: 'stage:start'; readonly stage: string }
  | { readonly type: 'stage:done'; readonly stage: string; readonly summary: string }
  | { readonly type: 'source:found'; readonly source: SearchSource }
  | { readonly type: 'fetch:done'; readonly url: string; readonly status: number; readonly bytes: number; readonly ok: boolean }
  | { readonly type: 'log'; readonly level: 'debug' | 'info' | 'warn' | 'error'; readonly message: string }
  /** 自主任务走了一步。 */
  | { readonly type: 'task:step'; readonly task: string; readonly step: number; readonly message: string }
  /** 任务的满足状态变化（含为什么不能停）。 */
  | { readonly type: 'task:state'; readonly task: string; readonly satisfied: boolean; readonly reason: string }
  | { readonly type: 'run:done'; readonly report: Report; readonly artifacts: readonly Artifact[] }
  | { readonly type: 'run:error'; readonly code: string; readonly message: string }

/** 带时间戳的完整事件。 */
export type RunEvent = RunEventPayload & { readonly at: string }

/** 进度事件总线：内核与插件发事件，Electron 主进程转发给界面。 */
export interface EventBus {
  emit(event: RunEventPayload): void
  on(listener: (event: RunEvent) => void): () => void
}

/** run 产物仓库。append-only，任何阶段失败都保留已完成产物。 */
export interface RunStore {
  /** run 目录的绝对路径。 */
  readonly dir: string
  /** 确保 run 目录存在。 */
  ensure(): Promise<void>
  /** 写入文本产物，返回产物描述。 */
  writeText(relPath: string, content: string, format?: string): Promise<Artifact>
  /** 写入 JSON 产物。 */
  writeJson(relPath: string, value: unknown): Promise<Artifact>
  /** 追加一行（用于 events.jsonl）。 */
  appendLine(relPath: string, line: string): Promise<void>
  /** 列出 run 目录下全部产物。 */
  list(): Promise<readonly Artifact[]>
}

/** 一次原始 HTTP 抓取的结果（未做正文抽取）。 */
export interface RawResponse {
  /** 跟随重定向后的最终 URL。 */
  readonly url: string
  readonly status: number
  /** 响应头里的 content-type（可能为空字符串）。 */
  readonly contentType: string
  /** 原始响应体；受 fetch.maxBytes 限制。 */
  readonly body: string
  readonly truncated: boolean
}

/** 网页抓取服务，由内核提供（通用管道能力，不属于领域插件）。 */
export interface FetchService {
  readonly userAgent: string
  /** 抓取原始响应体，不做 HTML→文本抽取（需要自己解析页面的插件用这个）。 */
  fetchRaw(url: string, signal?: AbortSignal): Promise<RawResponse>
  /** 抓取一个 URL 并抽取正文。非 2xx / 超时 / 超限 / 不支持的类型都抛 ResearcherError。 */
  fetchText(url: string, signal?: AbortSignal): Promise<FetchedDocument>
}

/** 本次运行实际选中的插件 id。 */
export interface ActiveSelection {
  readonly pipeline: string
  readonly search: string
  readonly searchFallbackUsed: boolean
  readonly provider?: string
  readonly organize: string
  readonly outputs: readonly string[]
}

/** 插件读取自己那一段配置的视图。 */
export interface PluginConfigView {
  /** 读取指定插件自己的配置段。 */
  section<T extends Record<string, unknown> = Record<string, unknown>>(pluginId: string): T
  /** 读取完整配置（只读用途）。 */
  all(): AppConfig
}

/**
 * 插件唯一的能力入口——插件之间从不互相 import，只通过它协作。
 */
export interface PluginContext {
  readonly runId: string
  readonly config: PluginConfigView
  readonly store: RunStore
  readonly events: EventBus
  readonly log: Logger
  readonly fetch: FetchService
  /** 活动搜索插件（已解析 available 与备用降级）。 */
  search(): SearchProvider
  /** 活动大模型插件。 */
  llm(): LlmProvider
  /** 活动整理插件。 */
  organize(): Organizer
  /** 配置的降级整理插件（若主整理插件失败，pipeline 可用它兜底）。未配置时为 undefined。 */
  organizeFallback(): Organizer | undefined
  /** 全部启用的输出插件。 */
  outputs(): readonly OutputPlugin[]
  /** 本次运行实际选中的插件 id 集合。 */
  active(): ActiveSelection
}

// ─────────────────────────────── 配置 ───────────────────────────────

/** 应用配置。每个插件读取 `plugins[自己的 id]` 段。 */
export interface AppConfig {
  readonly pipeline: {
    readonly id: string
    /** 主流程不可用时使用的备用主流程（例如没有大模型 key 时降到默认流程）。 */
    readonly fallback?: string
  }
  readonly search: {
    readonly id: string
    /** 主插件不可用时使用的备用搜索插件。 */
    readonly fallback?: string
    readonly maxSources: number
    readonly maxFetch: number
  }
  readonly provider: { readonly id: string }
  readonly organize: {
    readonly id: string
    /** 整理失败（如 LLM 输出非法 JSON）时降级到的插件。 */
    readonly fallback?: string
  }
  readonly output: {
    readonly ids: readonly string[]
    /** 文档模板 id（代理式主流程用它约束大纲与写作）。 */
    readonly template: string
  }
  /**
   * 代理式主流程的参数。
   *
   * 注意这里配的是**阈值**而不是步数：什么时候停由任务观测决定，
   * 只有 `globalIterations` / `maxToolSteps` 这类是防死循环的护栏。
   */
  readonly agentic: {
    /** 不动点迭代的全局护栏（防任务互相激活导致不收敛）。 */
    readonly globalIterations: number
    /** 每次查询取多少条候选。 */
    readonly candidatesPerQuery: number
    /** 第一轮生成的互补查询数。 */
    readonly queryFanout: number
    /** 连续多少轮贡献率低于阈值即判定地图饱和。 */
    readonly saturationWindow: number
    /** 饱和阈值：新增地图内容 / 本轮并入文档数。 */
    readonly saturationThreshold: number
    /** 抓取并发。 */
    readonly fetchConcurrency: number
    /** 大纲每节至少要多少条来源支撑。 */
    readonly minSupport: number
    /** 大纲最多多少节。 */
    readonly maxSections: number
    /** 单节写作的工具循环步数护栏。 */
    readonly maxToolSteps: number
    /** 单节自检不过时的最大重写次数。 */
    readonly maxRewriteAttempts: number
  }
  readonly fetch: {
    readonly concurrency: number
    readonly timeoutMs: number
    readonly maxBytes: number
    /** 抽取后正文的字符上限，超出则截断。 */
    readonly maxTextChars: number
    /** 瞬时网络故障（连接被重置、TLS 握手被丢、超时、429、5xx）的重试次数，不含首次。 */
    readonly maxRetries: number
    /** 正文抽取策略。 */
    readonly extractor: {
      /** `auto` 走「Readability → 纯文本」的升级—回退链。 */
      readonly mode: 'auto' | 'readability' | 'plain-text'
      /** 质量闸门：Readability 结果的绝对下限（字符）。 */
      readonly minChars: number
      /** 质量闸门：Readability 结果 / 整页纯文本 的最低比例。 */
      readonly minRatio: number
    }
    readonly userAgent: string
  }
  readonly plugins: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

// ─────────────────────────────── 插件清单 ───────────────────────────────

/** 任意插件实例的联合。 */
export type AnyPlugin = Pipeline | SearchProvider | LlmProvider | Organizer | OutputPlugin

/**
 * 插件清单。`entry` 就是插件实例；`kind` 决定它必须实现哪个接口。
 * 目前 manifest 是 TypeScript 对象（编译期可校验），未来要做运行时热加载时，
 * 它可以被序列化成 JSON，本结构仍是唯一事实源。
 */
export interface PluginManifest {
  readonly id: string
  readonly kind: PluginKind
  readonly version: string
  readonly title: string
  readonly description: string
  readonly entry: AnyPlugin
}

/** 注册表中列出的插件摘要，供界面「插件面板」展示。 */
export interface PluginInfo {
  readonly id: string
  readonly kind: PluginKind
  readonly version: string
  readonly title: string
  readonly description: string
  readonly available: boolean
  readonly active: boolean
}
