/**
 * 设置面板。
 *
 * 表单只写「内核认识的配置结构」，每个插件的参数放在它自己的配置段里
 * （`plugins['provider-openai']` 等），因此加一个插件只需要在这里补一段表单。
 */

import { useState } from 'react'
import type { AppConfig, PluginInfo, PluginKind } from '../../../main/engine/types.ts'
import { parseIpcError, requireApi } from '../api.ts'

/** 设置面板属性。 */
export interface SettingsPanelProps {
  readonly config: AppConfig
  readonly plugins: readonly PluginInfo[]
  readonly onSaved: (config: AppConfig) => void
  readonly onClose: () => void
}

/** 深拷贝，让表单可以自由编辑而不改动父组件的状态。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 读一个字符串字段。 */
function readString(section: Record<string, unknown> | undefined, key: string, fallback = ''): string {
  const value = section?.[key]
  return typeof value === 'string' ? value : fallback
}

/** 读一个数字字段。 */
function readNumber(section: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = section?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 写一个插件配置字段（不可变更新）。 */
function setPluginField(config: AppConfig, pluginId: string, key: string, value: unknown): AppConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      [pluginId]: { ...(config.plugins[pluginId] ?? {}), [key]: value },
    },
  }
}

export function SettingsPanel({ config, plugins, onSaved, onClose }: SettingsPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<AppConfig>(() => clone(config))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerSection = draft.plugins['provider-openai']
  const searchSection = draft.plugins['search-deepseek']
  const organizeSection = draft.plugins['organize-llm']

  const byKind = (kind: PluginKind): readonly PluginInfo[] => plugins.filter((plugin) => plugin.kind === kind)

  /** 保存：主进程会先校验再落盘。 */
  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await requireApi().setConfig(draft))
    } catch (err) {
      setError(parseIpcError(err).message)
    } finally {
      setSaving(false)
    }
  }

  /** 切换输出格式。 */
  const toggleOutput = (id: string): void => {
    const ids = draft.output.ids.includes(id)
      ? draft.output.ids.filter((item) => item !== id)
      : [...draft.output.ids, id]
    setDraft({ ...draft, output: { ids } })
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="modal wide">
        <header className="modal-head">
          <h2>设置</h2>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </header>

        {error === null ? null : (
          <div className="alert error">
            <strong>保存失败</strong>
            <p>{error}</p>
          </div>
        )}

        <div className="modal-body">
          <section className="form-group">
            <h3 className="section-title">大模型（OpenAI 兼容）</h3>
            <label className="field">
              <span>Base URL</span>
              <input
                type="text"
                value={readString(providerSection, 'baseUrl')}
                placeholder="https://api.deepseek.com/v1"
                onChange={(event) => setDraft(setPluginField(draft, 'provider-openai', 'baseUrl', event.target.value))}
              />
            </label>
            <label className="field">
              <span>模型</span>
              <input
                type="text"
                value={readString(providerSection, 'model')}
                placeholder="deepseek-chat"
                onChange={(event) => setDraft(setPluginField(draft, 'provider-openai', 'model', event.target.value))}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>API Key</span>
                <input
                  type="password"
                  value={readString(providerSection, 'apiKey')}
                  placeholder="留空则读环境变量"
                  onChange={(event) => setDraft(setPluginField(draft, 'provider-openai', 'apiKey', event.target.value))}
                />
              </label>
              <label className="field">
                <span>环境变量名</span>
                <input
                  type="text"
                  value={readString(providerSection, 'apiKeyEnv', 'DEEPSEEK_API_KEY')}
                  onChange={(event) => setDraft(setPluginField(draft, 'provider-openai', 'apiKeyEnv', event.target.value))}
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>temperature</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={readNumber(providerSection, 'temperature', 0.2)}
                  onChange={(event) => setDraft(setPluginField(draft, 'provider-openai', 'temperature', Number(event.target.value)))}
                />
              </label>
              <label className="field">
                <span>max tokens</span>
                <input
                  type="number"
                  min="1"
                  value={readNumber(providerSection, 'maxTokens', 4096)}
                  onChange={(event) => setDraft(setPluginField(draft, 'provider-openai', 'maxTokens', Number(event.target.value)))}
                />
              </label>
            </div>
            <p className="hint">
              API Key 以明文保存在应用数据目录的 config.json 里。若不想落盘，请留空并改用环境变量
              （启动应用前设置 <code>DEEPSEEK_API_KEY</code>）。
            </p>
          </section>

          <section className="form-group">
            <h3 className="section-title">搜索</h3>
            <div className="field-row">
              <label className="field">
                <span>主搜索插件</span>
                <select
                  value={draft.search.id}
                  onChange={(event) => setDraft({ ...draft, search: { ...draft.search, id: event.target.value } })}
                >
                  {byKind('search').map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>备用（主插件不可用时）</span>
                <select
                  value={draft.search.fallback ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      search: {
                        ...draft.search,
                        ...(event.target.value === '' ? {} : { fallback: event.target.value }),
                      },
                    })
                  }
                >
                  <option value="">（不降级）</option>
                  {byKind('search').map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>最多来源数</span>
                <input
                  type="number"
                  min="1"
                  value={draft.search.maxSources}
                  onChange={(event) =>
                    setDraft({ ...draft, search: { ...draft.search, maxSources: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="field">
                <span>最多抓取正文数</span>
                <input
                  type="number"
                  min="0"
                  value={draft.search.maxFetch}
                  onChange={(event) =>
                    setDraft({ ...draft, search: { ...draft.search, maxFetch: Number(event.target.value) } })
                  }
                />
              </label>
            </div>
            <p className="hint">DeepSeek 搜索复用大模型那一份 API Key，走它的原生 web_search 工具。</p>
          </section>

          <section className="form-group">
            <h3 className="section-title">整理</h3>
            <div className="field-row">
              <label className="field">
                <span>整理插件</span>
                <select
                  value={draft.organize.id}
                  onChange={(event) => setDraft({ ...draft, organize: { ...draft.organize, id: event.target.value } })}
                >
                  {byKind('organize').map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>失败时降级到</span>
                <select
                  value={draft.organize.fallback ?? ''}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      organize: {
                        ...draft.organize,
                        ...(event.target.value === '' ? {} : { fallback: event.target.value }),
                      },
                    })
                  }
                >
                  <option value="">（不降级）</option>
                  {byKind('organize').map((plugin) => (
                    <option key={plugin.id} value={plugin.id}>
                      {plugin.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>喂给模型的最大来源数</span>
                <input
                  type="number"
                  min="1"
                  value={readNumber(organizeSection, 'maxSourcesInPrompt', 8)}
                  onChange={(event) =>
                    setDraft(setPluginField(draft, 'organize-llm', 'maxSourcesInPrompt', Number(event.target.value)))
                  }
                />
              </label>
              <label className="field">
                <span>每源最大字符数</span>
                <input
                  type="number"
                  min="1"
                  value={readNumber(organizeSection, 'maxCharsPerSource', 2500)}
                  onChange={(event) =>
                    setDraft(setPluginField(draft, 'organize-llm', 'maxCharsPerSource', Number(event.target.value)))
                  }
                />
              </label>
            </div>
          </section>

          <section className="form-group">
            <h3 className="section-title">输出格式</h3>
            <div className="checkbox-row">
              {byKind('output').map((plugin) => (
                <label key={plugin.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={draft.output.ids.includes(plugin.id)}
                    onChange={() => toggleOutput(plugin.id)}
                  />
                  <span>{plugin.title}</span>
                </label>
              ))}
            </div>
            <p className="hint">至少选择一个。未勾选的格式不会生成对应文件。</p>
          </section>

          <section className="form-group">
            <h3 className="section-title">抓取</h3>
            <div className="field-row">
              <label className="field">
                <span>并发数</span>
                <input
                  type="number"
                  min="1"
                  value={draft.fetch.concurrency}
                  onChange={(event) =>
                    setDraft({ ...draft, fetch: { ...draft.fetch, concurrency: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="field">
                <span>单页超时（毫秒）</span>
                <input
                  type="number"
                  min="1000"
                  value={draft.fetch.timeoutMs}
                  onChange={(event) =>
                    setDraft({ ...draft, fetch: { ...draft.fetch, timeoutMs: Number(event.target.value) } })
                  }
                />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>单页体积上限（字节）</span>
                <input
                  type="number"
                  min="1024"
                  value={draft.fetch.maxBytes}
                  onChange={(event) =>
                    setDraft({ ...draft, fetch: { ...draft.fetch, maxBytes: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="field">
                <span>抽取正文上限（字符）</span>
                <input
                  type="number"
                  min="1000"
                  value={draft.fetch.maxTextChars}
                  onChange={(event) =>
                    setDraft({ ...draft, fetch: { ...draft.fetch, maxTextChars: Number(event.target.value) } })
                  }
                />
              </label>
            </div>
          </section>

          <section className="form-group">
            <h3 className="section-title">搜索插件参数</h3>
            <div className="field-row">
              <label className="field">
                <span>DeepSeek 搜索 Endpoint</span>
                <input
                  type="text"
                  value={readString(searchSection, 'baseUrl')}
                  onChange={(event) => setDraft(setPluginField(draft, 'search-deepseek', 'baseUrl', event.target.value))}
                />
              </label>
              <label className="field">
                <span>DeepSeek 搜索模型</span>
                <input
                  type="text"
                  value={readString(searchSection, 'model')}
                  onChange={(event) => setDraft(setPluginField(draft, 'search-deepseek', 'model', event.target.value))}
                />
              </label>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
