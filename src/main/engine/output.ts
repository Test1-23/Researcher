/**
 * 输出阶段的公共逻辑：按格式筛选 + 逐个渲染并隔离失败。
 *
 * 抽出来是因为两条主流程都要用，而「一个输出插件出错不该毁掉整轮运行」这条规则
 * 只应该有一份实现——否则迟早会有一条路径忘了它。
 *
 * 失败会被记录成 `Report.outputFailures`，并且**传给后续插件**，
 * 这样报告本身就能写明「某个格式没写出来」。
 */

import { isCancellation, ResearcherError, toResearcherError } from './errors.ts'
import type { Artifact, OutputFailure, OutputPlugin, PluginContext, Report } from './types.ts'

/** 格式筛选结果。 */
export interface OutputSelection {
  readonly plugins: readonly OutputPlugin[]
  /** 用户要求、但没有任何**已启用**插件能产出的格式。 */
  readonly missing: readonly string[]
}

/**
 * 按 `formats` 筛选本次要用的输出插件。
 *
 * `formats` 是在**已启用**的插件里再挑一层，因此要求了未启用的格式时不算错，
 * 但必须让调用方知道——调用方会把它写进日志，避免用户以为 json 也生成了。
 *
 * @throws ResearcherError 一个都没匹配上——那说明要求的格式全都没启用
 */
export function selectOutputs(
  outputs: readonly OutputPlugin[],
  formats: readonly string[] | undefined,
): OutputSelection {
  if (formats === undefined || formats.length === 0) return { plugins: outputs, missing: [] }

  const wanted = [...new Set(formats.map((format) => format.trim().toLowerCase()).filter((format) => format.length > 0))]
  if (wanted.length === 0) return { plugins: outputs, missing: [] }

  const available = new Set(outputs.map((plugin) => plugin.format.toLowerCase()))
  const missing = wanted.filter((format) => !available.has(format))
  const selected = outputs.filter((plugin) => wanted.includes(plugin.format.toLowerCase()))

  if (selected.length === 0) {
    throw new ResearcherError(
      `本次要求的输出格式（${wanted.join('、')}）没有对应的输出插件。`
      + `已启用：${[...available].join('、')}。请在设置里启用对应格式，或改掉 formats。`,
      'OUTPUT_FAILED',
    )
  }

  return { plugins: selected, missing }
}

/** 渲染结果。 */
export interface RenderOutcome {
  readonly artifacts: readonly Artifact[]
  readonly failures: readonly OutputFailure[]
  /** 带上全部失败信息的最终报告。 */
  readonly report: Report
}

/**
 * 逐个渲染输出插件，隔离单个插件的失败。
 *
 * 调用方拿到的 `report` 已经带上完整失败列表，应当用它去落盘 report.json。
 * **全部插件都失败**才抛错——那说明确实什么都没有产出。
 */
export async function renderOutputs(
  report: Report,
  plugins: readonly OutputPlugin[],
  ctx: PluginContext,
  signal?: AbortSignal,
): Promise<RenderOutcome> {
  const artifacts: Artifact[] = []
  const failures: OutputFailure[] = []
  let current = report

  for (const plugin of plugins) {
    // 把「目前为止的失败」交给下一个插件，好让报告能写明它
    current = { ...current, outputFailures: [...failures] }
    try {
      const produced = await plugin.render(current, ctx, signal)
      artifacts.push(...produced)
      ctx.log.debug(`输出插件 ${plugin.id} 写出 ${produced.map((artifact) => artifact.path).join('、')}`)
    } catch (error) {
      // 取消不是失败：必须向上抛，否则会被记成「格式渲染失败」并继续跑
      if (isCancellation(error)) throw error

      const reason = toResearcherError(error).message
      failures.push({ plugin: plugin.id, reason })
      ctx.log.warn(`输出插件 ${plugin.id} 失败（${reason}），继续渲染其余格式`)
      ctx.events.emit({ type: 'log', level: 'warn', message: `输出插件 ${plugin.id} 失败：${reason}` })
    }
  }

  // 只有当**每一个**插件都抛错时才算整轮失败。
  // 不能用「产物数为 0」判断：有的输出插件本来就不产文件（例如推送到外部服务）。
  if (plugins.length > 0 && failures.length === plugins.length) {
    throw new ResearcherError(
      `所有输出插件都失败了：${failures.map((failure) => `${failure.plugin}（${failure.reason}）`).join('；')}`,
      'OUTPUT_FAILED',
    )
  }

  return { artifacts, failures, report: { ...report, outputFailures: [...failures] } }
}
