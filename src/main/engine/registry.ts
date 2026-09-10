/**
 * 插件注册表。
 *
 * 插件在启动时静态注册（编译进主进程 bundle），运行期由配置决定「谁是活动的」。
 * 这与 DSH 一致：可替换性来自统一的接口与运行期选择，而不是把代码热加载进来。
 */

import { ResearcherError } from './errors.ts'
import { PLUGIN_KINDS } from './types.ts'
import type { AnyPlugin, PluginKind, PluginManifest } from './types.ts'

/** 插件 id 的格式：小写字母数字，用连字符分段。 */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 声明式地定义一个插件，返回带类型的清单。 */
export function definePlugin(manifest: PluginManifest): PluginManifest {
  return manifest
}

/** 校验清单，不合法时抛 PLUGIN_INVALID。 */
export function validateManifest(manifest: PluginManifest): void {
  const fail = (detail: string): never => {
    throw new ResearcherError(`插件清单无效：${detail}`, 'PLUGIN_INVALID')
  }

  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) {
    fail(`id "${String(manifest.id)}" 必须匹配 ${ID_PATTERN}`)
  }
  if (!PLUGIN_KINDS.includes(manifest.kind)) {
    fail(`未知的 kind "${String(manifest.kind)}"`)
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    fail(`插件 ${manifest.id} 缺少 version`)
  }
  if (typeof manifest.title !== 'string' || manifest.title.length === 0) {
    fail(`插件 ${manifest.id} 缺少 title`)
  }
  if (typeof manifest.description !== 'string') {
    fail(`插件 ${manifest.id} 的 description 必须是字符串`)
  }
  if (manifest.entry === null || typeof manifest.entry !== 'object') {
    fail(`插件 ${manifest.id} 的 entry 必须是对象`)
  }
  if (manifest.entry.id !== manifest.id) {
    fail(`插件 ${manifest.id} 的 entry.id 是 "${String(manifest.entry.id)}"，与清单 id 不一致`)
  }
  if (manifest.entry.kind !== manifest.kind) {
    fail(`插件 ${manifest.id} 的 entry.kind 是 "${String(manifest.entry.kind)}"，与清单 kind 不一致`)
  }
  if (manifest.kind === 'output') {
    const format = (manifest.entry as { format?: unknown }).format
    if (typeof format !== 'string' || format.length === 0) {
      fail(`输出插件 ${manifest.id} 必须声明 format`)
    }
  }
}

/** 插件注册表。 */
export class PluginRegistry {
  private readonly byKind = new Map<PluginKind, Map<string, PluginManifest>>()

  /** 注册一个插件；重复 id 或清单非法都会抛错。 */
  register(manifest: PluginManifest): void {
    validateManifest(manifest)
    let bucket = this.byKind.get(manifest.kind)
    if (bucket === undefined) {
      bucket = new Map<string, PluginManifest>()
      this.byKind.set(manifest.kind, bucket)
    }
    if (bucket.has(manifest.id)) {
      throw new ResearcherError(`插件 id 重复：${manifest.kind}/${manifest.id}`, 'PLUGIN_DUPLICATE')
    }
    bucket.set(manifest.id, manifest)
  }

  /** 批量注册。 */
  registerAll(manifests: readonly PluginManifest[]): void {
    for (const manifest of manifests) this.register(manifest)
  }

  has(kind: PluginKind, id: string): boolean {
    return this.byKind.get(kind)?.has(id) ?? false
  }

  find(kind: PluginKind, id: string): PluginManifest | undefined {
    return this.byKind.get(kind)?.get(id)
  }

  /** 取清单，找不到时抛 PLUGIN_NOT_FOUND。 */
  requireManifest(kind: PluginKind, id: string): PluginManifest {
    const manifest = this.find(kind, id)
    if (manifest === undefined) {
      const known = this.ids(kind)
      throw new ResearcherError(
        `找不到${kindLabel(kind)}插件 "${id}"。已注册：${known.length > 0 ? known.join('、') : '（无）'}`,
        'PLUGIN_NOT_FOUND',
      )
    }
    return manifest
  }

  /** 取插件实例，找不到时抛 PLUGIN_NOT_FOUND。 */
  requireEntry<T extends AnyPlugin>(kind: PluginKind, id: string): T {
    return this.requireManifest(kind, id).entry as T
  }

  /** 列出插件清单，可按类别过滤。 */
  list(kind?: PluginKind): readonly PluginManifest[] {
    if (kind !== undefined) return [...(this.byKind.get(kind)?.values() ?? [])]
    const all: PluginManifest[] = []
    for (const current of PLUGIN_KINDS) all.push(...(this.byKind.get(current)?.values() ?? []))
    return all
  }

  /** 某类别下已注册的 id。 */
  ids(kind: PluginKind): readonly string[] {
    return [...(this.byKind.get(kind)?.keys() ?? [])]
  }
}

/** 插件类别的中文名，用于错误提示。 */
export function kindLabel(kind: PluginKind): string {
  switch (kind) {
    case 'pipeline':
      return '主流程'
    case 'search':
      return '搜索'
    case 'provider':
      return '大模型'
    case 'organize':
      return '整理'
    case 'output':
      return '输出'
  }
}
