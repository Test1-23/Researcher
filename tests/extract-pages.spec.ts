/**
 * 抽取的**真实页面**回归网。
 *
 * 合成夹具能覆盖结构，但覆盖不到「Readability 在真实页面上到底选了什么、闸门什么时候回退」。
 * 这里用 `fixtures/pages/` 里录制的真实页面（由 `scripts/record-page-fixtures.ts` 生成）离线断言：
 *
 *   · 三页正常站点的正文被抽出来，且**站点框架文字被去掉了**
 *   · 重前端框架那一页（devsite）触发闸门回退，且**正文标题仍在**——宁可带噪声也不丢内容
 *
 * 夹具体积约 385 KB，换来的是这两条行为不再只靠人工核对。夹具过旧时可以重新录制。
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTRACTOR_OPTIONS, extractContent } from '../src/main/engine/extract.ts'
import { RECORDED_AT, RECORDED_PAGES } from '../fixtures/pages/index.ts'

/** 读一页夹具。 */
async function load(name: string): Promise<string> {
  return await readFile(`fixtures/pages/${name}.html`, 'utf8')
}

/** 每页的断言：应当出现的内容标志、以及**只有整页才有**的框架文字。 */
const EXPECTATIONS: Readonly<Record<string, { readonly content: string; readonly chrome: readonly string[] }>> = {
  csdn: { content: 'GPU for the Web', chrome: ['最新推荐文章'] },
  webdev: { content: 'WebGPU 是一种功能强大的 API', chrome: ['您可以按照自己的节奏'] },
  wikipedia: { content: 'From Wikipedia, the free encyclopedia', chrome: ['Main page', 'Jump to content'] },
  // 回退页：标题必须在（证明内容没丢），导航文字在是可接受的代价
  devsite: { content: 'WebGPU 的新变化', chrome: [] },
}

describe('录制夹具的元信息', () => {
  it('记录了来源 URL 与录制时间，便于判断是否过期', () => {
    expect(RECORDED_PAGES).toHaveLength(4)
    expect(Number.isNaN(Date.parse(RECORDED_AT))).toBe(false)
    for (const page of RECORDED_PAGES) {
      expect(page.url.startsWith('https://')).toBe(true)
      expect(page.bytes).toBeGreaterThan(1000)
    }
  })

  it('每页都有对应的夹具文件与断言', async () => {
    for (const page of RECORDED_PAGES) {
      const html = await load(page.name)
      expect(html.length, `${page.name} 夹具为空`).toBeGreaterThan(1000)
      expect(EXPECTATIONS[page.name], `${page.name} 缺少断言`).toBeDefined()
    }
  })
})

describe('真实页面上的抽取决策', () => {
  it.each(RECORDED_PAGES.map((page) => [page.name, page.method] as const))(
    '%s 仍然选中录制时的实现（%s）',
    async (name, method) => {
      const result = extractContent(await load(name), DEFAULT_EXTRACTOR_OPTIONS)
      expect(result.method).toBe(method)
    },
  )

  it.each(RECORDED_PAGES.map((page) => [page.name, page.method] as const))(
    '%s 的正文包含内容标志',
    async (name) => {
      const result = extractContent(await load(name), DEFAULT_EXTRACTOR_OPTIONS)
      expect(result.text).toContain(EXPECTATIONS[name]?.content)
      expect(result.text.length).toBeGreaterThan(500)
    },
  )
})

describe('Readability 真的去掉了站点框架', () => {
  const readabilityPages = RECORDED_PAGES.filter((page) => page.method === 'readability')

  it.each(readabilityPages.map((page) => [page.name] as const))(
    '%s 的抽取结果里没有导航/推荐位文字',
    async (name) => {
      const result = extractContent(await load(name), DEFAULT_EXTRACTOR_OPTIONS)
      for (const chrome of EXPECTATIONS[name]?.chrome ?? []) {
        expect(result.text, `${name} 的抽取结果里混进了框架文字：${chrome}`).not.toContain(chrome)
      }
    },
  )
})

describe('闸门回退的行为', () => {
  it('devsite 触发回退，并写明理由与闸门数值', async () => {
    const result = extractContent(await load('devsite'), DEFAULT_EXTRACTOR_OPTIONS)
    expect(result.method).toBe('plain-text')
    expect(result.fallbackReason).toContain('低于闸门')
    expect(result.fallbackReason).toMatch(/\d+ 字/)
  })

  it('回退后宁可带噪声也不丢内容：正文标题仍在', async () => {
    const result = extractContent(await load('devsite'), DEFAULT_EXTRACTOR_OPTIONS)
    expect(result.text).toContain('WebGPU 的新变化')
    // 代价是导航文字也进来了——这是刻意的取舍，不是缺陷
    expect(result.text).toContain('跳至主要内容')
  })

  it('强制 readability 时不回退，拿到的是它自己那点内容', async () => {
    const result = extractContent(await load('devsite'), { ...DEFAULT_EXTRACTOR_OPTIONS, mode: 'readability' })
    expect(result.method).toBe('readability')
    expect(result.text.length).toBeLessThan(2000)
  })
})
