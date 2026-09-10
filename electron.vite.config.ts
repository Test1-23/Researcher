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
