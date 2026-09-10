/**
 * 抽取实现的真实页面实测（人工核对用，不进 CI）。
 *
 * 测试用合成夹具保证确定性；这个脚本负责回答「在真实网页上到底行不行」。
 * 用法：node --no-warnings scripts/check-extraction.ts
 */

import { DEFAULT_EXTRACTOR_OPTIONS, extractContent, runReadability } from '../src/main/engine/extract.ts'
import { extractText } from '../src/main/engine/html.ts'

/** 一组覆盖不同页面类型的样本，含一个已知会让 Readability 失手的重前端页面。 */
const PAGES: readonly { label: string; url: string }[] = [
  { label: 'CSDN 文章', url: 'https://blog.csdn.net/gitblog_01136/article/details/151943535' },
  { label: 'web.dev 博客', url: 'https://web.developers.google.cn/blog/webgpu-supported-major-browsers?hl=zh-cn' },
  { label: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/WebGPU' },
  { label: 'Chrome devsite（已知难点）', url: 'https://developer.chrome.com/docs/web-platform/webgpu/news?hl=zh-cn' },
]

/** 带退避重试的抓取：出口代理偶发丢 TLS 握手，实测脚本也要扛得住。 */
async function get(url: string, tries = 4): Promise<string | undefined> {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      if (attempt === tries) {
        console.log(`  抓取失败：${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
    }
  }
  return undefined
}

/** 取前 n 个字符做单行预览。 */
function preview(text: string, n = 80): string {
  return text.slice(0, n).replace(/\s+/g, ' ')
}

console.log('抽取实现实测')
console.log('')

for (const page of PAGES) {
  console.log(`── ${page.label}`)
  console.log(`   ${page.url.slice(0, 96)}`)

  const html = await get(page.url)
  if (html === undefined) {
    console.log('   跳过')
    console.log('')
    continue
  }

  const plain = extractText(html)
  const readable = runReadability(html)
  const chosen = extractContent(html, DEFAULT_EXTRACTOR_OPTIONS)

  const readableLen = readable === undefined ? -1 : readable.text.length
  const ratio = plain.text.length === 0 ? 0 : Math.round((Math.max(readableLen, 0) / plain.text.length) * 100)

  console.log(`   HTML ${html.length} 字 | 整页纯文本 ${plain.text.length} 字`)
  console.log(`   Readability ${readableLen < 0 ? '解析失败' : `${readableLen} 字（占整页 ${ratio}%）`}`)
  console.log(`   → 实际采用：${chosen.method}${chosen.fallbackReason === undefined ? '' : `（${chosen.fallbackReason}）`}`)
  console.log(`   → 标题：${chosen.title ?? '（无）'}`)
  console.log(`   → 开头：${preview(chosen.text)}`)
  console.log('')
}
