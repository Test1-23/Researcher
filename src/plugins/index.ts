/**
 * 内置插件清单。
 *
 * 这里是「有哪些插件」的唯一事实源：加一个插件＝写一个目录 + 在这里登记一行。
 * 插件之间互不 import，只依赖 `src/main/engine/types.ts` 里的稳定接口。
 */

import { PluginRegistry } from '../main/engine/registry.ts'
import type { PluginManifest } from '../main/engine/types.ts'
import { llmOrganizerPlugin } from './organize-llm/index.ts'
import { extractiveOrganizerPlugin } from './organize-extractive/index.ts'
import { htmlOutputPlugin } from './output-html/index.ts'
import { jsonOutputPlugin } from './output-json/index.ts'
import { markdownOutputPlugin } from './output-markdown/index.ts'
import { defaultPipelinePlugin } from './pipeline-default/index.ts'
import { openAiProviderPlugin } from './provider-openai/index.ts'
import { deepSeekSearchPlugin } from './search-deepseek/index.ts'
import { duckDuckGoPlugin } from './search-duckduckgo/index.ts'

/** 全部内置插件。 */
export const BUILT_IN_PLUGINS: readonly PluginManifest[] = [
  // 主流程
  defaultPipelinePlugin,
  // 搜索
  deepSeekSearchPlugin,
  duckDuckGoPlugin,
  // 大模型
  openAiProviderPlugin,
  // 整理
  llmOrganizerPlugin,
  extractiveOrganizerPlugin,
  // 输出
  markdownOutputPlugin,
  htmlOutputPlugin,
  jsonOutputPlugin,
]

/** 建好一个已注册全部内置插件的注册表。 */
export function createRegistry(): PluginRegistry {
  const registry = new PluginRegistry()
  registry.registerAll(BUILT_IN_PLUGINS)
  return registry
}
