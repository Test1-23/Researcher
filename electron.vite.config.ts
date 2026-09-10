import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [
      // 抽取库必须**打进主进程包**，不能留给运行期 require：
      // linkedom 的 CJS 构建会 require css-select，而后者已是纯 ESM，
      // Electron 33 内置的 Node 不支持 require(ESM)，启动时直接 ERR_REQUIRE_ESM。
      // 让 Rollup 在打包时把它们解析进来，问题就不存在了。
      externalizeDepsPlugin({ exclude: ['linkedom', '@mozilla/readability'] }),
    ],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // canvas 是 linkedom 的**可选** peer 依赖（真身是需要本地编译的原生模块，我们不装）。
        // 不声明 external，Vite 会替它造一个「解析不到」的替身模块，而这个替身的行为**随构建
        // 模式变化**：生产构建给一个空对象（`createCanvas` 变成 undefined，抽到带 <canvas>
        // 的页面就崩），开发构建直接生成模块级 throw（`pnpm dev` 一启动就弹
        // 「Could not resolve "canvas" imported by "linkedom"」）。
        // 声明成 external，运行期 require 失败后由 linkedom 自带的兜底实现接手。
        external: ['canvas'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})
