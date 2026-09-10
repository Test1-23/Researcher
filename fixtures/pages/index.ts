/**
 * 录制页面的元信息。
 *
 * 由 `scripts/record-page-fixtures.ts` 生成，**不要手改**。
 * 夹具是某一时刻的真实页面快照；`recordedAt` 用来判断它有多旧。
 */

/** 一页录制信息。 */
export interface RecordedPage {
  readonly name: string
  readonly url: string
  /** 录制那一刻，原始页面上实际选中的抽取实现。 */
  readonly method: string
  /** 精简力度（越大越狠）；-1 表示未精简。 */
  readonly reductionLevel: number
  readonly bytes: number
  readonly note: string
}

export const RECORDED_AT = "2026-09-10T09:31:17.449Z"

export const RECORDED_PAGES: readonly RecordedPage[] = [
  { name: "csdn", url: "https://blog.csdn.net/gitblog_01136/article/details/151943535", method: "readability", reductionLevel: 4, bytes: 49890, note: "精简到第 4 级" },
  { name: "webdev", url: "https://web.developers.google.cn/blog/webgpu-supported-major-browsers?hl=zh-cn", method: "readability", reductionLevel: 4, bytes: 58978, note: "精简到第 4 级" },
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/WebGPU", method: "readability", reductionLevel: 4, bytes: 188056, note: "精简到第 4 级" },
  { name: "devsite", url: "https://developer.chrome.com/docs/web-platform/webgpu/news?hl=zh-cn", method: "plain-text", reductionLevel: 4, bytes: 96848, note: "精简到第 4 级" },
]
