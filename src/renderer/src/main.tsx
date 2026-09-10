/**
 * React 入口。
 *
 * 如果 `window.researcher` 不存在（例如有人直接用浏览器打开了 Vite 页面），
 * 给出明确提示而不是抛一堆 undefined 错误。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('找不到 #root 挂载点')
}

const hasBridge = typeof (window as { researcher?: unknown }).researcher === 'object'

createRoot(container).render(
  <StrictMode>
    {hasBridge ? <App /> : <BridgeMissing />}
  </StrictMode>,
)

/** 缺少 Electron 预加载桥时的提示页。 */
function BridgeMissing(): React.JSX.Element {
  return (
    <div className="bridge-missing">
      <h1>需要通过桌面应用启动</h1>
      <p>
        这个界面依赖 Electron 的预加载桥（<code>window.researcher</code>）来访问引擎。
        直接用浏览器打开 Vite 开发服务器是拿不到它的。
      </p>
      <p>
        请在项目根目录运行 <code>pnpm dev</code>。
      </p>
    </div>
  )
}
