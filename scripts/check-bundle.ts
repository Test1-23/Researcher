/**
 * 打包产物体检：确认 Electron 主进程包里没有「运行期才会炸」的替身模块。
 *
 * 存在的意义：类型检查、单元测试和界面冒烟都看不见打包器的产物形态，而有一类缺陷
 * 只存在于产物里——依赖解析失败时，打包器不会报错，而是塞进一个替身模块：
 *
 * - 开发构建里它是模块级 `throw`，Electron 一加载主进程包就崩，窗口根本不会出现；
 * - 生产构建里它是一个空对象，安静得多，直到代码真的用到它才崩。
 *
 * 真实案例：linkedom 把 `canvas` 声明为可选 peer 依赖，于是 `pnpm dev` 弹
 * 「Could not resolve "canvas" imported by "linkedom"」，而 `pnpm build` 出来的包
 * 只是悄悄丢掉了 `createCanvas`（页面里出现 <canvas> 就会崩）。
 * 修复在 electron.vite.config.ts（把它声明成 external）；这个脚本负责保证它不被改回去。
 *
 * 用法：pnpm build && node --no-warnings scripts/check-bundle.ts
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 禁止出现在产物里的标记，以及它为什么危险。 */
interface ForbiddenMarker {
  readonly marker: string
  readonly why: string
}

/**
 * 必须出现在**主进程包**里的标记，以及缺失说明什么。
 *
 * 用字符串字面量而不是函数名：万一哪天开了压缩，函数名会被改掉，字面量不会。
 */
interface RequiredMarker {
  readonly marker: string
  readonly why: string
}

const FORBIDDEN: readonly ForbiddenMarker[] = [
  {
    marker: '__viteOptionalPeerDep',
    why: 'Vite 为解析不到的可选依赖造的替身模块：开发构建抛错，生产构建变空对象',
  },
  {
    marker: 'Could not resolve',
    why: '替身模块的开发构建形态——模块级 throw，主进程一加载就崩',
  },
  {
    marker: '__vite-browser-external',
    why: 'Vite 把 Node 内置模块换成了浏览器空壳，运行期一访问就抛错',
  },
]

const REQUIRED: readonly RequiredMarker[] = [
  {
    marker: 'createCanvas',
    why: 'linkedom 没有被打进主进程包（抽取会在运行期 ERR_REQUIRE_ESM）',
  },
  {
    marker: 'readability-page-1',
    why: '@mozilla/readability 没有被打进主进程包（抽取会在运行期 ERR_REQUIRE_ESM）',
  },
]

/** 产物目录：主进程包和 preload 都由同一个打包器产出，一起检查。 */
const OUT_DIRS: readonly { dir: string; required: boolean }[] = [
  { dir: join('out', 'main'), required: true },
  { dir: join('out', 'preload'), required: false },
]

/** 列出目录下的产物文件；目录不存在时返回 undefined，用来区分「没构建」和「构建为空」。 */
async function bundlePaths(dir: string): Promise<string[] | undefined> {
  try {
    const entries = await readdir(dir)
    return entries
      .filter((name) => name.endsWith('.js') || name.endsWith('.cjs') || name.endsWith('.mjs'))
      .map((name) => join(dir, name))
  } catch {
    return undefined
  }
}

console.log('打包产物体检')
console.log('')

const problems: string[] = []
const scanned: string[] = []
const mainText: string[] = []

for (const { dir, required } of OUT_DIRS) {
  const paths = await bundlePaths(dir)
  if (paths === undefined) {
    problems.push(`${dir} 不存在——先运行 pnpm build`)
    continue
  }
  if (paths.length === 0) {
    problems.push(`${dir} 里没有产物文件`)
    continue
  }

  for (const path of paths) {
    const text = await readFile(path, 'utf8')
    scanned.push(path)
    if (required) mainText.push(text)

    for (const { marker, why } of FORBIDDEN) {
      if (text.includes(marker)) problems.push(`${path} 含替身模块标记「${marker}」：${why}`)
    }
    console.log(`  ${path.padEnd(28)} ${(text.length / 1024).toFixed(1)} kB`)
  }
}

if (mainText.length > 0) {
  const joined = mainText.join('\n')
  for (const { marker, why } of REQUIRED) {
    if (!joined.includes(marker)) problems.push(`主进程包缺少「${marker}」：${why}`)
  }
}

console.log('')
if (problems.length > 0) {
  console.error(`✗ 打包产物体检失败（检查了 ${scanned.length} 个文件）：`)
  for (const problem of problems) console.error(`  · ${problem}`)
  process.exitCode = 1
} else {
  console.log(`✓ 打包产物体检通过（检查了 ${scanned.length} 个文件，无替身模块）`)
}
