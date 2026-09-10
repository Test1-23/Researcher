/**
 * 正文抽取测试。
 *
 * 用**合成的**页面夹具（而不是抓下来的真页面）有三个原因：
 *   ① 测试必须确定性，不能依赖网络；
 *   ② 夹具能精确表达「导航 + 正文 + 页脚」这种结构，失败时指向明确；
 *   ③ 真实页面的行为由 `scripts/check-extraction.ts` 单独实测，不进 CI。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTRACTOR_OPTIONS, extractContent, runReadability, type ExtractorOptions } from '../src/main/engine/extract.ts'

const OPTIONS: ExtractorOptions = { ...DEFAULT_EXTRACTOR_OPTIONS }

/** 一段足够长的正文（超过 minChars=400 的闸门），确保能走通 Readability 这条路。 */
const ARTICLE_BODY = `
  <p>WebGPU 是一套面向现代图形与计算的浏览器 API，它在 WebGL 之外提供了更贴近底层硬件的能力，包括计算着色器与显式的资源绑定。</p>
  <p>与 WebGL 相比，WebGPU 支持计算着色器、显式的资源绑定以及更可预测的性能表现，因此更适合复杂的渲染管线与通用计算任务。</p>
  <p>在浏览器支持方面，主流引擎已经陆续完成了实现，但在移动端与旧版本浏览器上仍然存在明显的覆盖差距，这一点在做技术选型时必须纳入考量。</p>
  <p>开发者需要注意适配层与降级策略，否则在覆盖面不足的环境里会出现功能缺失甚至白屏的问题，而这类问题往往只在特定设备上复现。</p>
  <p>从工程实践角度看，把 WebGPU 用在计算而非渲染上往往收益更明显，因为计算负载对带宽与同步的要求更容易被这套 API 满足。</p>
  <p>调试体验也是选型时容易忽略的一环：浏览器提供的验证层能够捕捉资源绑定与管线状态上的错误，但它带来的开销需要在发布时关掉。</p>
  <p>安全模型方面，浏览器对 GPU 访问做了额外的隔离，这使得某些在原生环境里可行的做法在 Web 上需要绕路实现，性能特征也随之改变。</p>
  <p>总体而言，WebGPU 已经进入了可以用于生产阶段，但前提是团队愿意为覆盖面与降级路径付出额外的工程成本，并接受工具链仍在演进。</p>
`

/** 一个结构正常的文章页：导航 + article + 页脚。 */
const ARTICLE_PAGE = `<!doctype html>
<html><head><title>WebGPU 现状</title></head><body>
  <nav class="site-nav">
    <ul><li><a href="/">首页</a></li><li><a href="/docs">文档</a></li><li><a href="/blog">博客</a></li></ul>
  </nav>
  <header><a href="/">某某技术站</a> · 登录 · 注册</header>
  <article>
    <h1>WebGPU 的现状与限制</h1>
    ${ARTICLE_BODY}
  </article>
  <footer>版权所有 · 联系方式 · 隐私政策</footer>
</body></html>`

/** 一个 Readability 会失手的页面：正文塞在无语义的 div 里，还带一大块脚本与页脚。 */
const AWKWARD_PAGE = `<!doctype html>
<html><head><title>重前端页面</title><style>.a{color:red}</style></head><body>
  <div id="app">
    <div class="toolbar"><a href="/">首页</a><a href="/docs">文档</a></div>
    <div class="content">${ARTICLE_BODY}</div>
  </div>
  <script>window.__DATA__ = ${JSON.stringify({ feedback: ['易于理解', '解决了我的问题'] })};</script>
  <footer>如未另行说明，本页面内容依据知识共享署名 4.0 许可获得许可，代码示例依据 Apache 2.0 许可获得许可。</footer>
</body></html>`

/** 一个只有正文的空壳页。 */
const TINY_PAGE = '<html><body><p>太短了。</p></body></html>'

describe('Readability 封装', () => {
  it('在结构正常的页面上取到正文与标题', () => {
    const result = runReadability(ARTICLE_PAGE)
    expect(result).toBeDefined()
    expect(result?.title).toContain('WebGPU')
    expect(result?.text).toContain('计算着色器')
    // 导航与页脚不该出现在 Readability 的结果里
    expect(result?.text).not.toContain('隐私政策')
  })

  it('解析失败或结果为空时返回 undefined，不抛错', () => {
    expect(runReadability('')).toBeUndefined()
    expect(runReadability('<html><body></body></html>')).toBeUndefined()
    expect(runReadability('<不是 HTML')).toBeUndefined()
  })
})

describe('抽取升级—回退链', () => {
  it('正常页面走 Readability', () => {
    const result = extractContent(ARTICLE_PAGE, OPTIONS)
    expect(result.method).toBe('readability')
    expect(result.fallbackReason).toBeUndefined()
    expect(result.text).toContain('计算着色器')
  })

  it('Readability 结果低于闸门时回退到整页纯文本，并写明原因', () => {
    // 把比例闸门提到不可能满足的高度，强制触发回退
    const result = extractContent(ARTICLE_PAGE, { ...OPTIONS, minRatio: 0.99 })
    expect(result.method).toBe('plain-text')
    expect(result.fallbackReason).toContain('低于闸门')
    // 回退结果包含全部内容（含导航），这正是「宁可多给噪声也不丢内容」的取舍
    expect(result.text).toContain('计算着色器')
  })

  it('纯文本回退时绝不返回空文本（只要页面有内容）', () => {
    const result = extractContent(AWKWARD_PAGE, { ...OPTIONS, minRatio: 0.99 })
    expect(result.method).toBe('plain-text')
    expect(result.text.length).toBeGreaterThan(100)
  })

  it('mode=plain-text 时强制走纯文本', () => {
    const result = extractContent(ARTICLE_PAGE, { ...OPTIONS, mode: 'plain-text' })
    expect(result.method).toBe('plain-text')
    expect(result.text).toContain('隐私政策') // 整页文本当然包含页脚
  })

  it('mode=readability 时即使低于闸门也不回退', () => {
    const result = extractContent(ARTICLE_PAGE, { ...OPTIONS, mode: 'readability', minRatio: 0.99 })
    expect(result.method).toBe('readability')
  })

  it('极短页面不会因为闸门算出 0 而误判', () => {
    const result = extractContent(TINY_PAGE, OPTIONS)
    // 不管走哪条路，都不能是空字符串
    expect(result.text.length).toBeGreaterThan(0)
  })

  it('超过上限时截断并标记', () => {
    const result = extractContent(ARTICLE_PAGE, { ...OPTIONS, maxTextChars: 30 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBe(30)
  })

  it('损坏的 HTML 不抛错，仍返回文本', () => {
    const broken = `<html><body><div><p>${'内容'.repeat(300)}</p>`
    const result = extractContent(broken, OPTIONS)
    expect(result.text.length).toBeGreaterThan(0)
  })
})

describe('纯文本回退的取舍', () => {
  it('回退结果里保留导航文字——这是刻意的：下游是 LLM，噪声可忽略，丢内容不可挽回', () => {
    const result = extractContent(ARTICLE_PAGE, { ...OPTIONS, mode: 'plain-text' })
    expect(result.text).toContain('首页')
    expect(result.text).toContain('计算着色器')
  })

  it('脚本内容不会进入纯文本', () => {
    const result = extractContent(AWKWARD_PAGE, { ...OPTIONS, mode: 'plain-text' })
    expect(result.text).not.toContain('__DATA__')
    expect(result.text).not.toContain('解决了我的问题')
  })
})

/**
 * linkedom 把 `canvas` 声明为**可选** peer 依赖：解析不到就用它自带的空壳。
 * 这个兜底一旦失效（打包器替身模块会让 `createCanvas` 变成 undefined），
 * 代价不是「画不出图」而是「整篇抽不出来」——只要页面里有 <canvas> 就在构造元素时抛错。
 * canvas 元素在现代页面里很常见，所以这条路径必须钉住。
 */
describe('页面里的画布元素不该拖垮抽取', () => {
  const CANVAS_PAGE = `<!doctype html>
<html><head><title>带画布的页面</title></head><body>
  <article>
    <h1>带画布的页面</h1>
    <canvas id="chart" width="600" height="300"></canvas>
    ${ARTICLE_BODY}
  </article>
</body></html>`

  it('含 <canvas> 的页面仍然抽出正文', () => {
    const result = extractContent(CANVAS_PAGE, OPTIONS)
    expect(result.text).toContain('计算着色器')
    expect(result.text.length).toBeGreaterThan(400)
  })

  it('整页纯文本路径同样不受影响', () => {
    const result = extractContent(CANVAS_PAGE, { ...OPTIONS, mode: 'plain-text' })
    expect(result.text).toContain('计算着色器')
  })
})
