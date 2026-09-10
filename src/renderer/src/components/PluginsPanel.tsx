/**
 * 插件面板：按类别列出全部插件，显示可用性与活动状态。
 *
 * 「可用性」来自插件的 `available()`（纯本地检查）；「测试连接」会真的发一次请求，
 * 界面上必须把这个区别说清楚。
 */

import { useState } from 'react'
import type { PluginInfo, PluginKind } from '../../../main/engine/types.ts'
import { parseIpcError, requireApi } from '../api.ts'

/** 插件面板属性。 */
export interface PluginsPanelProps {
  readonly plugins: readonly PluginInfo[]
  readonly onClose: () => void
  readonly onOpenSettings: () => void
}

/** 类别的显示名与顺序。 */
const KIND_LABELS: readonly { kind: PluginKind; label: string; hint: string }[] = [
  { kind: 'pipeline', label: '主流程', hint: '编排阶段顺序，可整体替换' },
  { kind: 'search', label: '搜索', hint: '提供来源，可换后端' },
  { kind: 'provider', label: '大模型', hint: 'OpenAI 兼容，可换端点' },
  { kind: 'organize', label: '整理', hint: '把资料变成结构化报告' },
  { kind: 'output', label: '输出', hint: '决定写出哪些格式' },
]

export function PluginsPanel({ plugins, onClose, onOpenSettings }: PluginsPanelProps): React.JSX.Element {
  const [results, setResults] = useState<Readonly<Record<string, string>>>({})
  const [testing, setTesting] = useState<string | null>(null)

  /** 对单个插件做一次真实连通性测试。 */
  const test = async (kind: PluginKind, id: string): Promise<void> => {
    setTesting(id)
    try {
      const result = await requireApi().testPlugin(kind, id)
      setResults((previous) => ({ ...previous, [id]: `${result.ok ? '✓' : '✗'} ${result.detail}` }))
    } catch (error) {
      setResults((previous) => ({ ...previous, [id]: `✗ ${parseIpcError(error).message}` }))
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="modal wide">
        <header className="modal-head">
          <h2>插件</h2>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onOpenSettings}>
              去设置里切换
            </button>
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <p className="hint">
          「可用」是插件根据当前配置做的本地判断（例如有没有 API key），不发网络请求；
          「测试连接」会真的调用一次服务，可能产生费用。
        </p>

        <div className="modal-body">
          {KIND_LABELS.map(({ kind, label, hint }) => {
            const items = plugins.filter((plugin) => plugin.kind === kind)
            return (
              <section key={kind} className="plugin-group">
                <h3 className="section-title">
                  {label}
                  <span className="count">{hint}</span>
                </h3>
                {items.length === 0 ? (
                  <p className="hint">没有注册这一类的插件。</p>
                ) : (
                  <ul className="plugin-list">
                    {items.map((plugin) => (
                      <li key={plugin.id} className="plugin-item">
                        <div className="plugin-head">
                          <span className="plugin-title">{plugin.title}</span>
                          <code className="plugin-id">{plugin.id}</code>
                          {plugin.active ? <span className="badge active">已启用</span> : null}
                          <span className={plugin.available ? 'badge ok' : 'badge off'}>
                            {plugin.available ? '可用' : '不可用'}
                          </span>
                        </div>
                        <p className="plugin-desc">{plugin.description}</p>
                        <div className="row">
                          <span className="plugin-version">v{plugin.version}</span>
                          {kind === 'search' || kind === 'provider' ? (
                            <button
                              type="button"
                              className="btn tiny"
                              disabled={testing !== null || !plugin.available}
                              onClick={() => void test(kind, plugin.id)}
                            >
                              {testing === plugin.id ? '测试中…' : '测试连接'}
                            </button>
                          ) : null}
                        </div>
                        {results[plugin.id] === undefined ? null : (
                          <p className="plugin-result">{results[plugin.id]}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
