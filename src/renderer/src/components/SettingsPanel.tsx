/**
 * 设置面板。
 *
 * 表单只写「内核认识的配置结构」，每个插件的参数放在它自己的配置段里
 * （`plugins['provider-openai']` 等），因此加一个插件只需要在这里补一段表单。
 */

import { useState } from 'react'
import type { AppConfig, PluginInfo, PluginKind } from '../../../main/engine/types.ts'
import type { ConfigSnapshot, SecretStatus } from '../../../shared/ipc.ts'
import { parseIpcError, requireApi } from '../api.ts'

/** 设置面板属性。 */
export interface SettingsPanelProps {
  readonly snapshot: ConfigSnapshot
  readonly plugins: readonly PluginInfo[]
  readonly onSaved: (snapshot: ConfigSnapshot) => void
  readonly onClose: () => void
}

/** 密钥状态徽章文案。 */
function secretBadge(status: SecretStatus | undefined): { text: string; tone: string } {
  switch (status?.source) {
    case 'encrypted':
      return { text: '已加密保存', tone: 'ok' }
    case 'env':
      return { text: `来自环境变量 ${status.envName}`, tone: 'ok' }
    case 'plaintext':
      return { text: '明文保存（有风险）', tone: 'warn' }
    case 'undecryptable':
      return { text: '无法解密，请重新填写', tone: 'warn' }
    default:
      return { text: '未设置', tone: '' }
  }
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

export function SettingsPanel({ snapshot, plugins, onSaved, onClose }: SettingsPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<AppConfig>(() => clone(snapshot.config))
  // 密钥由主进程保管：这里只持有「用户这次新输入的」（空 = 不修改）与「是否要清除」。
  const [keyInput, setKeyInput] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerSection = draft.plugins['provider-openai']
  const searchSection = draft.plugins['search-deepseek']
  const organizeSection = draft.plugins['organize-llm']

  const storage = snapshot.storage
  const providerSecret = snapshot.secrets['provider-openai']
  const badge = secretBadge(providerSecret)
  const hasStoredKey = providerSecret !== undefined
    && providerSecret.source !== 'none'
    && providerSecret.source !== 'env'
  const canEditKey = storage.canPersist

  const byKind = (kind: PluginKind): readonly PluginInfo[] => plugins.filter((plugin) => plugin.kind === kind)

  /** 保存：主进程会先校验再落盘，并按平台能力加密密钥。 */
  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const secrets: Record<string, string | null> = {}
      if (clearKey) secrets['provider-openai'] = null
      else if (keyInput.trim().length > 0) secrets['provider-openai'] = keyInput.trim()

      onSaved(await requireApi().setConfig({ config: draft, secrets }))
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
                <span>
                  API Key
                  <span className={badge.tone === '' ? 'badge' : `badge ${badge.tone}`}>{badge.text}</span>
                </span>
                <input
                  type="password"
                  value={keyInput}
                  disabled={!canEditKey}
                  placeholder={
                    !canEditKey
                      ? '当前平台无法安全保存，请用环境变量'
                      : hasStoredKey
                        ? '已保存，留空表示不修改'
                        : '粘贴你的 API key'
                  }
                  onChange={(event) => {
                    setKeyInput(event.target.value)
                    if (event.target.value.length > 0) setClearKey(false)
                  }}
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
            {hasStoredKey ? (
              <div className="row">
                <button
                  type="button"
                  className="btn tiny ghost"
                  disabled={!canEditKey}
                  onClick={() => {
                    setClearKey(true)
                    setKeyInput('')
                  }}
                >
                  {clearKey ? '将清除（保存后生效）' : '清除已保存的密钥'}
                </button>
              </div>
            ) : null}
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
              密钥由系统密钥库加密后保存在应用数据目录；<strong>明文既不写入配置文件，也不下发到界面</strong>。
              留空即保持原值；想改用环境变量就在上面填变量名并留空此处。
            </p>
            {storage.reason === undefined ? null : <p className="hint warn-text">{storage.reason}</p>}
            {storage.plaintext && storage.canPersist ? (
              <p className="hint warn-text">当前为明文存储，任何能读取配置文件的程序都能拿到密钥。</p>
            ) : null}
            <p className="hint">
              环境变量入口：启动应用前设置 <code>DEEPSEEK_API_KEY</code>。
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
            <div className="field-row">
              <label className="field">
                <span>瞬时故障重试次数</span>
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={draft.fetch.maxRetries}
                  onChange={(event) =>
                    setDraft({ ...draft, fetch: { ...draft.fetch, maxRetries: Number(event.target.value) } })
                  }
                />
              </label>
            </div>
            <p className="hint">
              只对瞬时故障重试（连接被重置、TLS 握手被丢、超时、429、5xx）；4xx 不重试。
              设为 0 表示一次失败就放弃。
            </p>
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
