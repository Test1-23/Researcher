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
  pipeline: { id: 'pipeline-default' },
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
  output: { ids: ['output-markdown', 'output-html'] },
  fetch: {
    concurrency: 4,
    timeoutMs: 15_000,
    maxBytes: 512_000,
    maxTextChars: 20_000,
    // 出口代理/网络偶发抖动不该让整轮研究失败：默认重试 2 次。
    maxRetries: 2,
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

  if (!Array.isArray(config.output?.ids) || config.output.ids.length === 0) {
    fail('output.ids 必须是非空数组')
  }
  for (const id of config.output.ids) idOf(id, 'output.ids 的元素')

  if (!isPlainObject(config.plugins)) fail('plugins 必须是对象')
}

/** 读取配置并与缺省值合并。文件缺失时返回缺省值，文件损坏时抛 CONFIG_INVALID。 */
export async function loadConfig(dataRoot: string): Promise<AppConfig> {
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
  return merged
}

/**
 * 容错加载：配置损坏时把坏文件备份为 `config.json.bad` 并回退到缺省配置，
 * 避免一个手改坏的 JSON 让整个应用起不来。
 */
export async function loadConfigResilient(dataRoot: string): Promise<{ config: AppConfig; warning?: string }> {
  try {
    return { config: await loadConfig(dataRoot) }
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

/** 写入配置。 */
export async function saveConfig(dataRoot: string, config: AppConfig): Promise<void> {
  assertValidConfig(config)
  const path = configFilePath(dataRoot)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
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
