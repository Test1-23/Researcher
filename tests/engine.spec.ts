/**
 * 内核纯函数的单元测试：HTML 抽取、配置合并与校验、插件清单校验。
 * 这些都不联网、不落盘，是整套测试里最快的反馈回路。
 */

import { describe, expect, it } from 'vitest'
import {
  assertValidConfig,
  DEFAULT_CONFIG,
  deepMerge,
  resolveApiKey,
  sectionPositiveInt,
  sectionString,
} from '../src/main/engine/config.ts'
import { decodeEntities, extractText, htmlToText } from '../src/main/engine/html.ts'
import { PluginRegistry, validateManifest } from '../src/main/engine/registry.ts'
import { ResearcherError } from '../src/main/engine/errors.ts'
import { FakeSearch, manifestOf } from './helpers/fakes.ts'

describe('HTML → 文本抽取', () => {
  it('去掉脚本与样式，保留正文', () => {
    const html = `
      <html><head><title>标题</title><style>body{color:red}</style></head>
      <body>
        <script>const secret = 1</script>
        <h1>大标题</h1>
        <p>第一段。</p>
        <p>第二段。</p>
      </body></html>`
    const text = htmlToText(html)
    expect(text).toContain('大标题')
    expect(text).toContain('第一段。')
    expect(text).toContain('第二段。')
    expect(text).not.toContain('color:red')
    expect(text).not.toContain('const secret')
  })

  it('块级标签转成稳定的段落分隔（源码有无换行都一致）', () => {
    expect(htmlToText('<p>a    b</p>\n\n\n<p>c</p>')).toBe('a b\n\nc')
    expect(htmlToText('<p>a    b</p><p>c</p>')).toBe('a b\n\nc')
    expect(htmlToText('<p>one</p><p>two</p><div>three</div>').split('\n'))
      .toEqual(['one', '', 'two', '', 'three'])
  })

  it('块级标签转成换行，段落不粘在一起', () => {
    const text = htmlToText('<p>one</p><p>two</p><div>three</div>')
    expect(text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('把 <br> 变成单换行，列表项加前缀且不插入空行', () => {
    expect(htmlToText('a<br>b')).toBe('a\nb')
    expect(htmlToText('<ul><li>甲</li><li>乙</li></ul>')).toBe('- 甲\n- 乙')
  })

  it('解码命名实体与数字实体', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe('a & b <c> "d" \'e\'')
    expect(decodeEntities('&#x4e2d;&#25991;')).toBe('中文')
    expect(decodeEntities('&nbsp;x')).toBe(' x')
  })

  it('非法实体保持原样，不猜', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;')
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;')
  })

  it('抽取标题，空标题返回 undefined', () => {
    expect(extractText('<title> 你好 世界 </title><p>x</p>').title).toBe('你好 世界')
    expect(extractText('<title>   </title><p>x</p>').title).toBeUndefined()
    expect(extractText('<p>无标题</p>').title).toBeUndefined()
  })

  it('压缩多余空白但不吞掉段落边界', () => {
    expect(htmlToText('<p>a    b</p>\n\n\n<p>c</p>')).toBe('a b\n\nc')
  })

  it('处理未闭合的 script 标签也不会泄漏脚本内容', () => {
    const text = htmlToText('<p>正文</p><script>var x = "<p>假的</p>"')
    expect(text).toContain('正文')
    expect(text).not.toContain('var x')
    expect(text).not.toContain('假的')
  })

  it('成对的 style/title/svg 整体删除，不影响正文', () => {
    const text = htmlToText('<title>页面标题</title><style>.a{color:red}</style><p>正文</p><svg><path d="M0 0"/></svg>')
    expect(text).toBe('正文')
  })
})

describe('配置合并与校验', () => {
  it('深合并覆盖部分字段，未覆盖的保留缺省值', () => {
    const merged = deepMerge(DEFAULT_CONFIG, {
      search: { id: 'search-custom', maxSources: 3 },
    })
    expect(merged.search.id).toBe('search-custom')
    expect(merged.search.maxSources).toBe(3)
    expect(merged.search.fallback).toBe(DEFAULT_CONFIG.search.fallback)
    expect(merged.fetch.timeoutMs).toBe(DEFAULT_CONFIG.fetch.timeoutMs)
  })

  it('数组整体替换而不是合并', () => {
    const merged = deepMerge(DEFAULT_CONFIG, { output: { ids: ['output-json'] } })
    expect(merged.output.ids).toEqual(['output-json'])
  })

  it('缺省配置本身合法', () => {
    expect(() => assertValidConfig(DEFAULT_CONFIG)).not.toThrow()
  })

  it('拒绝非法的上限值', () => {
    const broken = deepMerge(DEFAULT_CONFIG, { search: { maxSources: 0 } })
    expect(() => assertValidConfig(broken)).toThrowError(/maxSources/)
  })

  it('拒绝空的输出插件列表', () => {
    const broken = deepMerge(DEFAULT_CONFIG, { output: { ids: [] } })
    expect(() => assertValidConfig(broken)).toThrowError(/output\.ids/)
  })

  it('config 解析辅助函数忽略类型错误并回退', () => {
    expect(sectionString({ a: '  x  ' }, 'a', 'd')).toBe('x')
    expect(sectionString({ a: 42 }, 'a', 'd')).toBe('d')
    expect(sectionPositiveInt({ n: 5 }, 'n', 1)).toBe(5)
    expect(sectionPositiveInt({ n: -5 }, 'n', 1)).toBe(1)
    expect(sectionPositiveInt({ n: 1.5 }, 'n', 1)).toBe(1)
  })

  it('API key 优先取配置字面量，其次取环境变量', () => {
    const envName = 'RESEARCHER_TEST_KEY'
    process.env[envName] = 'from-env'
    try {
      expect(resolveApiKey({ apiKey: 'literal' }, envName)).toBe('literal')
      expect(resolveApiKey({ apiKeyEnv: envName }, 'IGNORED')).toBe('from-env')
      expect(resolveApiKey({}, envName)).toBe('from-env')
      expect(resolveApiKey({}, 'RESEARCHER_DEFINITELY_MISSING')).toBeUndefined()
    } finally {
      delete process.env[envName]
    }
  })
})

describe('插件注册表', () => {
  it('注册并查到插件', () => {
    const registry = new PluginRegistry()
    const entry = new FakeSearch('search-fake')
    registry.register(manifestOf(entry))
    expect(registry.has('search', 'search-fake')).toBe(true)
    expect(registry.requireEntry<FakeSearch>('search', 'search-fake')).toBe(entry)
    expect(registry.ids('search')).toEqual(['search-fake'])
  })

  it('拒绝重复 id', () => {
    const registry = new PluginRegistry()
    registry.register(manifestOf(new FakeSearch('search-fake')))
    expect(() => registry.register(manifestOf(new FakeSearch('search-fake')))).toThrowError(/重复/)
  })

  it('缺失插件时报出已注册的候选', () => {
    const registry = new PluginRegistry()
    registry.register(manifestOf(new FakeSearch('search-fake')))
    expect(() => registry.requireManifest('search', 'search-missing')).toThrowError(/search-fake/)
  })

  it('拒绝非法 id、未知 kind 与 entry 不一致的清单', () => {
    const base = manifestOf(new FakeSearch('search-fake'))
    expect(() => validateManifest({ ...base, id: 'Bad Id' })).toThrowError(/id/)
    expect(() => validateManifest({ ...base, kind: 'nope' as never })).toThrowError(/kind/)
    expect(() => validateManifest({ ...base, title: '' })).toThrowError(/title/)
    expect(() => validateManifest({ ...base, id: 'search-other' })).toThrowError(/entry\.id/)
  })

  it('输出插件必须声明 format', () => {
    const entry = { id: 'output-x', kind: 'output' as const, render: async () => [] } as never
    expect(() => validateManifest({
      id: 'output-x',
      kind: 'output',
      version: '1.0.0',
      title: 'x',
      description: '',
      entry: entry as PluginManifestEntry,
    })).toThrowError(/format/)
  })

  it('错误带稳定错误码', () => {
    const registry = new PluginRegistry()
    try {
      registry.requireManifest('search', 'nope')
      expect.unreachable('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ResearcherError)
      expect((error as ResearcherError).code).toBe('PLUGIN_NOT_FOUND')
    }
  })
})

/** 仅为类型断言的别名，避免在测试里散落 any。 */
type PluginManifestEntry = Parameters<typeof validateManifest>[0]['entry']
