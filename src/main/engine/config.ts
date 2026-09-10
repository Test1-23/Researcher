/**
 * 配置的加载、校验与插件配置视图。
 *
 * 配置文件位于数据根目录下的 `config.json`；缺省值覆盖全部字段，因此文件里只需要写想覆盖的部分。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ResearcherError } from './errors.ts'
import type { AppConfig, PluginConfigView } from './types.ts'

/** 引擎版本，写入 provenance，便于追溯报告是哪个版本生成的。 */
export const ENGINE_VERSION = '0.1.0'

/**
 * 缺省配置。
 *
 * 搜索默认走 DeepSeek 原生 web_search，并以无需 key 的 DuckDuckGo 作为备用，
 * 因此「没有任何 API key」时整条链路依然可以跑通（整理自动降级为抽取式）。
 */
export const DEFAULT_CONFIG: AppConfig = {
  pipeline: {
    // 默认走代理式主流程；它依赖大模型，没有 key 时自动降到 pipeline-default。
    id: 'pipeline-research',
    fallback: 'pipeline-default',
  },
  search: {
    id: 'search-deepseek',
    fallback: 'search-duckduckgo',
    maxSources: 8,
    maxFetch: 5,
  },
  provider: { id: 'provider-openai' },
  organize: {
    id: 'organize-llm',
    fallback: 'organize-extractive',
  },
  output: { ids: ['output-markdown', 'output-html'], template: 'report' },
  agentic: {
    // 这一组是**阈值**：什么时候停由任务观测决定，不是步数。
    saturationWindow: 2,
    saturationThreshold: 0.3,
    minSupport: 2,
    // 下面这几个是防死循环的护栏，设得远超正常所需。
    globalIterations: 60,
    candidatesPerQuery: 30,
    queryFanout: 5,
    fetchConcurrency: 6,
    maxSections: 10,
    maxToolSteps: 12,
    maxRewriteAttempts: 2,
  },
  fetch: {
    concurrency: 4,
    timeoutMs: 15_000,
    maxBytes: 512_000,
    maxTextChars: 20_000,
    // 出口代理/网络偶发抖动不该让整轮研究失败：默认重试 2 次。
    maxRetries: 2,
    extractor: {
      // 实测：Readability 在多数页面最好，但重前端框架的页面会只取到页脚，
      // 因此用比例闸门识别这种情况并回退到整页纯文本。
      mode: 'auto',
      minChars: 400,
      minRatio: 0.2,
    },
    userAgent: `Researcher/${ENGINE_VERSION} (+local desktop research tool)`,
  },
  plugins: {
    'search-deepseek': {
      baseUrl: 'https://api.deepseek.com/anthropic/v1',
      model: 'deepseek-chat',
      maxUses: 5,
      maxTokens: 4096,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
    'search-duckduckgo': {
      baseUrl: 'https://html.duckduckgo.com/html/',
    },
    'provider-openai': {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      temperature: 0.2,
      maxTokens: 4096,
    },
    'organize-llm': {
      maxSourcesInPrompt: 8,
      maxCharsPerSource: 2500,
      maxTotalChars: 24_000,
    },
    'organize-extractive': {
      sentencesPerSource: 4,
      maxExcerptChars: 700,
    },
  },
}

/** 配置文件路径。 */
export function configFilePath(dataRoot: string): string {
  return join(dataRoot, 'config.json')
}

/** 判断一个值是否是普通对象（用于深合并）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深合并：对象递归合并，数组与标量整体替换。 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : (patch as T))
  }
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return result as T
}

/** 校验合并后的配置，字段不合法时抛 CONFIG_INVALID。 */
export function assertValidConfig(config: AppConfig): void {
  const fail = (detail: string): never => {
    throw new ResearcherError(`配置无效：${detail}`, 'CONFIG_INVALID')
  }
  const idOf = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) fail(`${path} 必须是非空字符串`)
    return value as string
  }
  idOf(config.pipeline?.id, 'pipeline.id')
  idOf(config.search?.id, 'search.id')
  idOf(config.provider?.id, 'provider.id')
  idOf(config.organize?.id, 'organize.id')

  const positiveInt = (value: unknown, path: string): void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(`${path} 必须是正整数`)
  }
  positiveInt(config.search?.maxSources, 'search.maxSources')
  positiveInt(config.search?.maxFetch, 'search.maxFetch')
  positiveInt(config.fetch?.concurrency, 'fetch.concurrency')
  positiveInt(config.fetch?.timeoutMs, 'fetch.timeoutMs')
  positiveInt(config.fetch?.maxBytes, 'fetch.maxBytes')
  positiveInt(config.fetch?.maxTextChars, 'fetch.maxTextChars')
  // 允许为 0（即不重试），但不能是负数或小数
  if (typeof config.fetch?.maxRetries !== 'number' || !Number.isInteger(config.fetch.maxRetries) || config.fetch.maxRetries < 0) {
    fail('fetch.maxRetries 必须是非负整数')
  }
  if (typeof config.fetch?.userAgent !== 'string' || config.fetch.userAgent.length === 0) {
    fail('fetch.userAgent 必须是非空字符串')
  }
  const extractor = config.fetch?.extractor
  if (extractor === undefined || !['auto', 'readability', 'plain-text'].includes(extractor.mode)) {
    fail('fetch.extractor.mode 必须是 auto / readability / plain-text 之一')
  }
  positiveInt(extractor.minChars, 'fetch.extractor.minChars')
  if (typeof extractor.minRatio !== 'number' || !(extractor.minRatio >= 0 && extractor.minRatio <= 1)) {
    fail('fetch.extractor.minRatio 必须是 0–1 之间的数')
  }

  if (!Array.isArray(config.output?.ids) || config.output.ids.length === 0) {
    fail('output.ids 必须是非空数组')
  }
  for (const id of config.output.ids) idOf(id, 'output.ids 的元素')
  idOf(config.output?.template, 'output.template')

  if (!isPlainObject(config.agentic)) fail('agentic 必须是对象')
  positiveInt(config.agentic?.globalIterations, 'agentic.globalIterations')
  positiveInt(config.agentic?.candidatesPerQuery, 'agentic.candidatesPerQuery')
  positiveInt(config.agentic?.queryFanout, 'agentic.queryFanout')
  positiveInt(config.agentic?.saturationWindow, 'agentic.saturationWindow')
  positiveInt(config.agentic?.fetchConcurrency, 'agentic.fetchConcurrency')
  positiveInt(config.agentic?.minSupport, 'agentic.minSupport')
  positiveInt(config.agentic?.maxSections, 'agentic.maxSections')
  positiveInt(config.agentic?.maxToolSteps, 'agentic.maxToolSteps')
  if (typeof config.agentic?.maxRewriteAttempts !== 'number'
    || !Number.isInteger(config.agentic.maxRewriteAttempts)
    || config.agentic.maxRewriteAttempts < 0) {
    fail('agentic.maxRewriteAttempts 必须是非负整数')
  }
  if (typeof config.agentic?.saturationThreshold !== 'number'
    || !(config.agentic.saturationThreshold >= 0 && config.agentic.saturationThreshold <= 10)) {
    fail('agentic.saturationThreshold 必须是 0–10 之间的数')
  }

  if (!isPlainObject(config.plugins)) fail('plugins 必须是对象')
}

/**
 * 读取配置并与缺省值合并，再用 `codec` 解密其中的密钥。
 *
 * 不传 codec 时（命令行场景）密文保持不可解，该插件会被视为没有密钥——
 * 绝不会把密文当成密钥发出去。
 */
export async function loadConfig(dataRoot: string, codec?: SecretCodec): Promise<AppConfig> {
  let raw: string
  try {
    raw = await readFile(configFilePath(dataRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG
    throw new ResearcherError(`读取配置失败：${String(error)}`, 'CONFIG_INVALID', { cause: error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ResearcherError(`配置文件不是合法 JSON：${String(error)}`, 'CONFIG_INVALID', { cause: error })
  }

  const merged = deepMerge(DEFAULT_CONFIG, parsed)
  assertValidConfig(merged)
  return decodeSecrets(merged, codec)
}

/**
 * 容错加载：配置损坏时把坏文件备份为 `config.json.bad` 并回退到缺省配置，
 * 避免一个手改坏的 JSON 让整个应用起不来。
 */
export async function loadConfigResilient(
  dataRoot: string,
  codec?: SecretCodec,
): Promise<{ config: AppConfig; warning?: string }> {
  try {
    return { config: await loadConfig(dataRoot, codec) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const backup = `${configFilePath(dataRoot)}.bad`
    try {
      await rename(configFilePath(dataRoot), backup)
    } catch {
      /* 备份失败不影响回退到缺省配置 */
    }
    return { config: DEFAULT_CONFIG, warning: `${message}；已备份原文件并回退到缺省配置` }
  }
}

/**
 * 写入配置：密钥按 `codec` 加密后落盘，明文永不写入文件。
 *
 * 调用方必须先完成「保留还是替换密钥」的决策——本函数只负责存储形态。
 */
export async function saveConfig(dataRoot: string, config: AppConfig, codec: SecretCodec): Promise<void> {
  assertValidConfig(config)
  const path = configFilePath(dataRoot)
  const onDisk = encodeSecrets(config, codec)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8')
}

/** 构造插件读取自己配置段的视图。 */
export function createPluginConfigView(config: AppConfig): PluginConfigView {
  return {
    section<T extends Record<string, unknown> = Record<string, unknown>>(pluginId: string): T {
      const section = config.plugins[pluginId]
      return (isPlainObject(section) ? { ...section } : {}) as T
    },
    all(): AppConfig {
      return config
    },
  }
}

/**
 * 解析 API key：配置里的字面量优先，其次读环境变量。
 * 环境变量优先于「写死在配置文件里」是不安全的默认；这里让显式字面量优先，
 * 是为了让用户在界面上填的 key 立即生效，而环境变量作为无界面场景的入口。
 */
export function resolveApiKey(section: Record<string, unknown>, defaultEnvName: string): string | undefined {
  const literal = section['apiKey']
  if (typeof literal === 'string' && literal.trim().length > 0) return literal.trim()
  const envName = typeof section['apiKeyEnv'] === 'string' && section['apiKeyEnv'].length > 0
    ? section['apiKeyEnv']
    : defaultEnvName
  const fromEnv = process.env[envName]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return undefined
}

/**
 * 密钥来源。
 *
 * 界面只能看到这个枚举，永远拿不到密钥本身。
 */
export type SecretSource =
  /** 没有配置，也没有环境变量。 */
  | 'none'
  /** 来自环境变量。 */
  | 'env'
  /** 已用 safeStorage 加密保存并成功解密。 */
  | 'encrypted'
  /** 明文保存（用户显式允许，或平台不支持加密）。 */
  | 'plaintext'
  /** 磁盘上是密文，但本次运行解不开（换了机器/系统用户，或是命令行读桌面应用的配置）。 */
  | 'undecryptable'

/**
 * 加解密接缝。
 *
 * 内核不认识 Electron：桌面应用注入 safeStorage 实现，命令行与测试注入明文实现，
 * 引擎代码一行都不用改。
 */
export interface SecretCodec {
  readonly kind: 'safeStorage' | 'plaintext'
  /** 是否提供真实保护（Linux 的 basic_text 后端返回 false）。 */
  readonly secure: boolean
  encrypt(plaintext: string): string
  decrypt(ciphertext: string): string
}

/** 明文编解码器：仅用于命令行/测试，或用户显式接受明文存储时。 */
export const PLAINTEXT_CODEC: SecretCodec = {
  kind: 'plaintext',
  secure: false,
  encrypt: (plaintext) => plaintext,
  decrypt: (ciphertext) => ciphertext,
}

/** 落盘时使用的字段名。 */
const ENCRYPTED_FIELD = 'apiKeyEncrypted'
const STORAGE_FIELD = 'apiKeyStorage'

/** 把内存配置转成落盘形态：密钥加密，明文永不落盘。 */
export function encodeSecrets(config: AppConfig, codec: SecretCodec): AppConfig {
  const plugins: Record<string, Record<string, unknown>> = {}
  for (const [pluginId, section] of Object.entries(config.plugins)) {
    const next: Record<string, unknown> = { ...section }
    delete next['apiKey']
    delete next[ENCRYPTED_FIELD]
    delete next[STORAGE_FIELD]

    const apiKey = section['apiKey']
    if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      if (codec.kind === 'safeStorage') {
        next[ENCRYPTED_FIELD] = codec.encrypt(apiKey.trim())
        next[STORAGE_FIELD] = 'safeStorage'
      } else {
        // 显式选择明文时才写回 apiKey，并且打上标记让界面能持续警告
        next['apiKey'] = apiKey.trim()
        next[STORAGE_FIELD] = 'plaintext'
      }
    }
    plugins[pluginId] = next
  }
  return { ...config, plugins }
}

/**
 * 把落盘形态转回内存配置：解密密钥。
 *
 * 解密失败**不是**致命错误：配置可能来自另一台机器或另一个系统用户。
 * 此时该插件视为没有密钥，由界面提示重新填写。
 */
export function decodeSecrets(config: AppConfig, codec?: SecretCodec): AppConfig {
  const plugins: Record<string, Record<string, unknown>> = {}
  for (const [pluginId, section] of Object.entries(config.plugins)) {
    const next: Record<string, unknown> = { ...section }
    const ciphertext = section[ENCRYPTED_FIELD]
    if (typeof ciphertext === 'string' && ciphertext.length > 0 && codec !== undefined && codec.kind === 'safeStorage') {
      try {
        next['apiKey'] = codec.decrypt(ciphertext)
      } catch {
        delete next['apiKey']
      }
    }
    plugins[pluginId] = next
  }
  return { ...config, plugins }
}

/** 抹掉全部密钥材料（明文与密文），用于下发给渲染进程。 */
export function redactSecrets(config: AppConfig): AppConfig {
  const plugins: Record<string, Record<string, unknown>> = {}
  for (const [pluginId, section] of Object.entries(config.plugins)) {
    const next: Record<string, unknown> = { ...section }
    delete next['apiKey']
    delete next[ENCRYPTED_FIELD]
    plugins[pluginId] = next
  }
  return { ...config, plugins }
}

/** 是否还有明文密钥需要迁移（启动时用）。 */
export function hasPlaintextSecrets(config: AppConfig): boolean {
  return Object.values(config.plugins).some(
    (section) => typeof section['apiKey'] === 'string' && section['apiKey'].length > 0
      && section[STORAGE_FIELD] !== 'safeStorage',
  )
}

/** 取某个插件配置段使用的环境变量名。 */
export function envNameOf(section: Record<string, unknown>, defaultEnvName: string): string {
  const configured = section['apiKeyEnv']
  return typeof configured === 'string' && configured.length > 0 ? configured : defaultEnvName
}

/** 判断一个插件当前的密钥来源——只看本地状态，不发网络请求。 */
export function secretSourceOf(section: Record<string, unknown>, defaultEnvName: string): SecretSource {
  const literal = section['apiKey']
  if (typeof literal === 'string' && literal.length > 0) {
    return section[STORAGE_FIELD] === 'safeStorage' ? 'encrypted' : 'plaintext'
  }
  // 有密文却没有明文，说明这次没能解开
  const ciphertext = section[ENCRYPTED_FIELD]
  if (typeof ciphertext === 'string' && ciphertext.length > 0) return 'undecryptable'
  const fromEnv = process.env[envNameOf(section, defaultEnvName)]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return 'env'
  return 'none'
}

/** 读取一个字符串配置项，缺省时返回 fallback。 */
export function sectionString(section: Record<string, unknown>, key: string, fallback: string): string {
  const value = section[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** 读取一个正整数配置项，缺省或非法时返回 fallback。 */
export function sectionPositiveInt(section: Record<string, unknown>, key: string, fallback: number): number {
  const value = section[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 读取一个数值配置项（允许 0 与小数），缺省或非法时返回 fallback。 */
export function sectionNumber(section: Record<string, unknown>, key: string, fallback: number): number {
  const value = section[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
