/**
 * 输出阶段的测试：格式筛选与失败隔离。
 *
 * 「一个输出插件出错不该毁掉整轮运行」是这里唯一重要的规则，
 * 所以两条主流程共用同一份实现（`engine/output.ts`），测试也直接打它。
 */

import { describe, expect, it } from 'vitest'
import { ResearcherError } from '../src/main/engine/errors.ts'
import { renderOutputs, selectOutputs } from '../src/main/engine/output.ts'
import type { Artifact, OutputPlugin, PluginContext, Report } from '../src/main/engine/types.ts'
import { makeContext } from './helpers/fake-context.ts'
import { FakeLlm, FakeSearch } from './helpers/fakes.ts'
import { staticFetch } from './helpers/fake-fetch.ts'

/** 一个可控的输出插件。 */
class TestOutput implements OutputPlugin {
  readonly kind = 'output' as const
  calls = 0

  constructor(
    readonly id: string,
    readonly format: string,
    private readonly behaviour: { readonly error?: string; readonly paths?: readonly string[] } = {},
  ) {}

  async render(_report: Report, ctx: PluginContext): Promise<readonly Artifact[]> {
    this.calls += 1
    if (this.behaviour.error !== undefined) throw new Error(this.behaviour.error)
    const paths = this.behaviour.paths ?? [`report.${this.format}`]
    const out: Artifact[] = []
    for (const path of paths) out.push(await ctx.store.writeText(path, `由 ${this.id} 生成`, this.format))
    return out
  }
}

/** 一份最小报告。 */
function makeReport(): Report {
  return {
    runId: 'r1',
    query: 'q',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    sources: [],
    documents: [],
    failures: [],
    synthesis: { title: 'T', summary: 'S', sections: [] },
    provenance: {
      engine: '0.1.0',
      pipeline: 'test',
      search: 'test',
      searchFallbackUsed: false,
      organize: 'test',
      outputs: [],
      generatedAt: '2026-01-01T00:00:01.000Z',
    },
  }
}

/** 造一个测试用上下文。 */
function context(): PluginContext {
  return makeContext({
    llm: new FakeLlm('fake-llm'),
    search: new FakeSearch('fake-search'),
    fetch: staticFetch({}),
  }).ctx
}

describe('按格式筛选输出插件', () => {
  const plugins = [
    new TestOutput('output-markdown', 'markdown'),
    new TestOutput('output-html', 'html'),
    new TestOutput('output-json', 'json'),
  ]

  it('未指定 formats 时全部启用', () => {
    expect(selectOutputs(plugins, undefined).plugins).toHaveLength(3)
    expect(selectOutputs(plugins, []).plugins).toHaveLength(3)
  })

  it('按 format 过滤，大小写与空白不敏感', () => {
    expect(selectOutputs(plugins, ['markdown']).plugins.map((plugin) => plugin.id)).toEqual(['output-markdown'])
    expect(selectOutputs(plugins, [' markdown ']).plugins.map((plugin) => plugin.id)).toEqual(['output-markdown'])
    expect(selectOutputs(plugins, ['JSON']).plugins.map((plugin) => plugin.id)).toEqual(['output-json'])
  })

  it('要求了未启用的格式时不算错，但要如实报告 missing', () => {
    // 只启用了 markdown 与 html，却要求 md + json
    const enabled = plugins.slice(0, 2)
    const selection = selectOutputs(enabled, ['markdown', 'json'])
    expect(selection.plugins.map((plugin) => plugin.id)).toEqual(['output-markdown'])
    expect(selection.missing).toEqual(['json'])
  })

  it('一个都没匹配上时抛出可读错误，并列出已启用的格式', () => {
    expect(() => selectOutputs(plugins, ['pdf'])).toThrowError(/没有对应的输出插件/)
    try {
      selectOutputs(plugins, ['pdf'])
    } catch (error) {
      expect((error as Error).message).toContain('markdown')
      expect((error as Error).message).toContain('html')
    }
  })
})

describe('输出失败隔离', () => {
  it('一个插件失败不影响其余，并记入 outputFailures', async () => {
    const ok = new TestOutput('output-markdown', 'markdown')
    const bad = new TestOutput('output-html', 'html', { error: '模板炸了' })
    const alsoOk = new TestOutput('output-json', 'json')

    const outcome = await renderOutputs(makeReport(), [ok, bad, alsoOk], context())

    expect(outcome.artifacts.map((artifact) => artifact.path)).toEqual(['report.markdown', 'report.json'])
    expect(outcome.failures).toEqual([{ plugin: 'output-html', reason: '模板炸了' }])
    expect(ok.calls).toBe(1)
    expect(alsoOk.calls).toBe(1)
  })

  it('后续插件能在报告里看到先前插件的失败', async () => {
    let seen: readonly { plugin: string }[] = []
    const bad = new TestOutput('output-html', 'html', { error: '坏了' })
    const observer: OutputPlugin = {
      id: 'output-observer',
      kind: 'output',
      format: 'observer',
      render: async (report) => {
        seen = report.outputFailures ?? []
        return []
      },
    }

    await renderOutputs(makeReport(), [bad, observer], context())
    expect(seen).toEqual([{ plugin: 'output-html', reason: '坏了' }])
  })

  it('最终报告带上完整的失败列表', async () => {
    const bad1 = new TestOutput('output-html', 'html', { error: '甲' })
    const bad2 = new TestOutput('output-json', 'json', { error: '乙' })
    const ok = new TestOutput('output-markdown', 'markdown')

    const outcome = await renderOutputs(makeReport(), [ok, bad1, bad2], context())
    expect(outcome.report.outputFailures).toEqual([
      { plugin: 'output-html', reason: '甲' },
      { plugin: 'output-json', reason: '乙' },
    ])
  })

  it('全部失败才让运行失败', async () => {
    const bad = new TestOutput('output-html', 'html', { error: '全坏了' })
    await expect(renderOutputs(makeReport(), [bad], context())).rejects.toMatchObject({ code: 'OUTPUT_FAILED' })
  })

  it('一个插件产出多个产物时全部计入', async () => {
    const multi = new TestOutput('output-markdown', 'markdown', { paths: ['a.md', 'b.md'] })
    const outcome = await renderOutputs(makeReport(), [multi], context())
    expect(outcome.artifacts.map((artifact) => artifact.path)).toEqual(['a.md', 'b.md'])
  })

  it('一个插件不产文件也不算失败——「全部抛错」才是失败', async () => {
    // 有的输出插件本来就不产文件（例如推送到外部服务）
    const notifier: OutputPlugin = {
      id: 'output-notifier',
      kind: 'output',
      format: 'notifier',
      render: async () => [],
    }
    const outcome = await renderOutputs(makeReport(), [notifier], context())
    expect(outcome.failures).toEqual([])
    expect(outcome.artifacts).toEqual([])
  })

  it('取消不是失败：直接向上抛，不会被记成格式错误', async () => {
    const controller = new AbortController()
    controller.abort()
    const cancelling: OutputPlugin = {
      id: 'output-slow',
      kind: 'output',
      format: 'slow',
      render: async () => {
        throw new ResearcherError('运行已取消', 'CANCELLED')
      },
    }
    await expect(renderOutputs(makeReport(), [cancelling], context(), controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    })
  })
})
