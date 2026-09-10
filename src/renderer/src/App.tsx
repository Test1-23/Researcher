/**
 * 应用外壳：装配状态、订阅运行事件、组织左右两栏布局。
 */

import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, PluginInfo } from '../../main/engine/types.ts'
import type { AppInfo, ConfigSnapshot, RunSummary } from '../../shared/ipc.ts'
import { parseIpcError, requireApi } from './api.ts'
import { IDLE_PROGRESS, reduceRunEvent, type RunProgress } from './state.ts'
import { PluginsPanel } from './components/PluginsPanel.tsx'
import { ProgressPanel } from './components/ProgressPanel.tsx'
import { ResultPanel } from './components/ResultPanel.tsx'
import { SettingsPanel } from './components/SettingsPanel.tsx'

/** 顶栏高度等布局常量在 CSS 里定义，这里只关心结构。 */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)
  const [plugins, setPlugins] = useState<readonly PluginInfo[]>([])
  const [runs, setRuns] = useState<readonly RunSummary[]>([])
  const [progress, setProgress] = useState<RunProgress>(IDLE_PROGRESS)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'progress' | 'report'>('progress')
  const [dialog, setDialog] = useState<'none' | 'settings' | 'plugins'>('none')
  const [notice, setNotice] = useState<string | null>(null)

  /** 拉取配置、插件与历史运行。 */
  const refresh = useCallback(async (): Promise<void> => {
    const api = requireApi()
    try {
      const [nextInfo, nextSnapshot, nextPlugins, nextRuns] = await Promise.all([
        api.appInfo(),
        api.getConfig(),
        api.listPlugins(),
        api.listRuns(),
      ])
      setInfo(nextInfo)
      setSnapshot(nextSnapshot)
      setPlugins(nextPlugins)
      setRuns(nextRuns)
    } catch (error) {
      setNotice(parseIpcError(error).message)
    }
  }, [])

  // 订阅运行事件。返回的是取消订阅函数，卸载或 StrictMode 重挂时都能正确清理。
  useEffect(() => {
    const off = requireApi().onRunEvent((event) => {
      setProgress((previous) => reduceRunEvent(previous, event))
    })
    return off
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 运行结束后刷新历史列表，并自动切到报告页
  useEffect(() => {
    if (progress.status === 'done') {
      setTab('report')
      void refresh()
    }
    if (progress.status === 'error') {
      setTab('progress')
      void refresh()
    }
  }, [progress.status, refresh])

  const running = progress.status === 'running'

  /** 开始一次运行。 */
  const start = async (): Promise<void> => {
    const api = requireApi()
    setNotice(null)
    setProgress(IDLE_PROGRESS)
    setTab('progress')
    try {
      await api.startRun({ query })
    } catch (error) {
      const { code, message } = parseIpcError(error)
      setProgress({ ...IDLE_PROGRESS, status: 'error', error: { code, message } })
    }
  }

  /** 取消当前运行。 */
  const cancel = async (): Promise<void> => {
    try {
      await requireApi().cancelRun()
    } catch (error) {
      setNotice(parseIpcError(error).message)
    }
  }

  /** 打开一次历史运行的产物。 */
  const openRun = async (runId: string): Promise<void> => {
    const api = requireApi()
    try {
      const detail = await api.getRun(runId)
      if (detail === null) {
        setNotice('这次运行没有留下 report.json（可能中途失败）')
        return
      }
      setProgress({
        ...IDLE_PROGRESS,
        runId: detail.runId,
        status: 'done',
        report: detail.report,
        artifacts: detail.artifacts,
      })
      setTab('report')
    } catch (error) {
      setNotice(parseIpcError(error).message)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            <div className="brand-name">Researcher</div>
            <div className="brand-sub">信息搜索与整理引擎</div>
          </div>
        </div>
        <div className="topbar-meta">
          {info === null ? null : (
            <>
              <span className="chip">引擎 {info.engineVersion}</span>
              <span className="chip">{info.platform}</span>
            </>
          )}
          <button type="button" className="btn ghost" onClick={() => setDialog('plugins')}>
            插件
          </button>
          <button type="button" className="btn ghost" onClick={() => setDialog('settings')}>
            设置
          </button>
        </div>
      </header>

      {notice === null ? null : (
        <div className="notice">
          <span>{notice}</span>
          <button type="button" className="btn tiny ghost" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <section className="panel">
            <h2 className="panel-title">要研究什么</h2>
            <textarea
              className="query-input"
              value={query}
              rows={4}
              placeholder="例如：2026 年主流浏览器对 WebGPU 的支持现状"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !running) {
                  void start()
                }
              }}
            />
            <div className="row">
              <button type="button" className="btn primary" disabled={running || query.trim().length === 0} onClick={() => void start()}>
                {running ? '运行中…' : '开始研究'}
              </button>
              {running ? (
                <button type="button" className="btn danger" onClick={() => void cancel()}>
                  取消
                </button>
              ) : null}
            </div>
            <p className="hint">⌘/Ctrl + Enter 直接开始。搜索与整理会用配置里的活动插件。</p>
          </section>

          <section className="panel grow">
            <h2 className="panel-title">
              历史运行
              <button type="button" className="btn tiny ghost" onClick={() => void refresh()}>
                刷新
              </button>
            </h2>
            {runs.length === 0 ? (
              <p className="hint">还没有运行记录。</p>
            ) : (
              <ul className="run-list">
                {runs.map((run) => (
                  <li key={run.runId}>
                    <button type="button" className="run-item" onClick={() => void openRun(run.runId)}>
                      <span className="run-query">{run.query}</span>
                      <span className="run-meta">
                        {run.status === 'done'
                          ? `${run.sourceCount ?? 0} 个来源 · ${run.organize ?? ''}`
                          : '未完成'}
                      </span>
                      <span className="run-time">{formatTime(run.startedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <main className="main">
          <nav className="tabs">
            <button
              type="button"
              className={tab === 'progress' ? 'tab active' : 'tab'}
              onClick={() => setTab('progress')}
            >
              运行进度
              {running ? <span className="dot" /> : null}
            </button>
            <button
              type="button"
              className={tab === 'report' ? 'tab active' : 'tab'}
              onClick={() => setTab('report')}
              disabled={progress.report === undefined}
            >
              报告
            </button>
            {progress.artifacts.length > 0 ? (
              <span className="tabs-meta">{progress.artifacts.length} 个产物</span>
            ) : null}
          </nav>

          <div className="main-body">
            {tab === 'progress' ? (
              <ProgressPanel progress={progress} />
            ) : progress.report === undefined ? (
              <p className="hint">还没有报告。先跑一次研究，或从左侧打开一次历史运行。</p>
            ) : (
              <ResultPanel
                report={progress.report}
                artifacts={progress.artifacts}
                runId={progress.runId}
                onNotice={setNotice}
              />
            )}
          </div>
        </main>
      </div>

      {dialog === 'settings' && snapshot !== null ? (
        <SettingsPanel
          snapshot={snapshot}
          plugins={plugins}
          onSaved={(next) => {
            setSnapshot(next)
            setPlugins([])
            void refresh()
            setDialog('none')
          }}
          onClose={() => setDialog('none')}
        />
      ) : null}

      {dialog === 'plugins' ? (
        <PluginsPanel
          plugins={plugins}
          onClose={() => setDialog('none')}
          onOpenSettings={() => setDialog('settings')}
        />
      ) : null}
    </div>
  )
}

/** 把 ISO 时间显示成本地短格式。 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}
