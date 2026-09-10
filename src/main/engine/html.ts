/**
 * 极简 HTML → 纯文本抽取。
 *
 * 刻意不引入 DOM 库：v0 只需要「把网页变成喂给大模型的正文」，正则可控、无依赖、易测试。
 * 抽取质量不足时的升级路径是换成真正的可读性算法，调用方无需改动。
 */

/** 抽取结果。 */
export interface HtmlExtraction {
  readonly title?: string
  readonly text: string
}

/** 常见命名实体。未收录的实体保持原样，避免猜错。 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  bull: '•',
  middot: '·',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  prime: '′',
  Prime: '″',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  minus: '−',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  sup1: '¹',
  le: '≤',
  ge: '≥',
  ne: '≠',
  asymp: '≈',
  equiv: '≡',
  infin: '∞',
  sum: '∑',
  prod: '∏',
  radic: '√',
  int: '∫',
  part: '∂',
  nabla: '∇',
  isin: '∈',
  notin: '∉',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  micro: 'µ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
}

/** 把码位转成字符，非法码位保持原文。 */
function fromCodePoint(code: number, original: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return original
  // 代理区码位不是合法字符
  if (code >= 0xd800 && code <= 0xdfff) return original
  try {
    return String.fromCodePoint(code)
  } catch {
    return original
  }
}

/** 解码 HTML 实体（命名实体 + 十进制/十六进制数字实体）。 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, isHex ? 16 : 10)
      return fromCodePoint(code, match)
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** 抽出 `<title>` 内容。 */
export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return undefined
  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
  return title.length > 0 ? title : undefined
}

/** 需要整体删除（含内容）的元素。 */
const DROPPED_PAIRED = 'script|style|noscript|template|svg|math|iframe|object|embed|textarea|head|title'

/**
 * RAWTEXT 类元素：浏览器会把未闭合的它们一直吃到文档结尾。
 * 这里照做，否则页面上未闭合的 <script> 会把脚本源码当成正文喂给大模型。
 */
const DROPPED_RAW_TEXT = 'script|style|noscript|textarea'

/** 块级分隔符：用于把块边界稳定地变成段落（不受源码里有没有换行影响）。 */
const BLOCK_SEPARATOR = '\u0001'

/** 移除不产生正文的元素（含其内容）。 */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`<(${DROPPED_PAIRED})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), ' ')
    .replace(new RegExp(`<(${DROPPED_RAW_TEXT})\\b[^>]*>[\\s\\S]*$`, 'i'), ' ')
    .replace(new RegExp(`<\\/?(?:${DROPPED_PAIRED})\\b[^>]*\\/?>`, 'gi'), ' ')
}

/** 把块级标签变成稳定的段落分隔，让段落边界在纯文本里保留下来。 */
function applyBlockBreaks(html: string): string {
  const closing =
    'p|div|section|article|header|footer|main|aside|nav|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot'
    + '|h[1-6]|blockquote|pre|figure|figcaption|form|fieldset|address|details|summary'
  const opening = closing
  return html
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(new RegExp(`<\\s*(?:${opening})\\b[^>]*>`, 'gi'), BLOCK_SEPARATOR)
    .replace(new RegExp(`<\\/\\s*(?:${closing})\\s*>`, 'gi'), BLOCK_SEPARATOR)
    .replace(/<\s*(td|th)\b[^>]*>/gi, ' ')
}

/** 把 HTML 压成可读纯文本。 */
export function htmlToText(html: string): string {
  let text = stripNonContent(html)
  text = applyBlockBreaks(text)
  text = text.replace(/<[^>]*>/g, ' ')
  text = decodeEntities(text)
  text = text
    .replace(/\r\n?/g, '\n')
    // 非换行空白（含各种 Unicode 空格）先压成单个空格
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    // 连续的块分隔符（不管中间夹了多少空白）统一变成一个空行
    .replace(new RegExp(`(?:\\s*${BLOCK_SEPARATOR}\\s*)+`, 'g'), '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
  return text.trim()
}

/** 一次调用拿到标题与正文。 */
export function extractText(html: string): HtmlExtraction {
  const title = extractTitle(html)
  const text = htmlToText(html)
  return title === undefined ? { text } : { title, text }
}
