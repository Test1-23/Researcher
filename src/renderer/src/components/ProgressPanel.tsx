/**
 * 运行进度面板：阶段状态、找到的来源、抓取结果与日志。
 *
 * 目的是让「引擎此刻在干什么、拿到了什么」一直可见，而不是只给一个转圈。
 */

import { useState } from 'react'
import { stageLabel, type RunProgress } from '../state.ts'

/** 进度面板属性。 */
export interface ProgressPanelProps {
  readonly progress: RunProgress
}

export function ProgressPanel({ progress }: ProgressPanelProps): React.JSX.Element {
  const [showLogs, setShowLogs] = useState(false)
  const fetchedCount = progress.fetches.filter((item) => item.ok).length

  if (progress.status === 'idle') {
    return (
      <div className="empty">
        <h2>准备就绪</h2>
        <p>在左侧输入一个问题并点击「开始研究」。运行过程会在这里实时展开。</p>
      </div>
    )
  }

  return (
    <div className="progress">
      {progress.status === 'error' && progress.error !== undefined ? (
        <div className="alert error">
          <strong>{progress.error.code}</strong>
          <p>{progress.error.message}</p>
        </div>
      ) : null}

      {progress.status === 'running' ? (
        <div className="alert running">
          <span className="spinner" />
          <span>正在运行…{progress.runId === null ? '' : `（run ${progress.runId}）`}</span>
        </div>
      ) : null}

      <section>
        <h3 className="section-title">阶段</h3>
        <ol className="stages">
          {progress.stages.length === 0 ? <li className="hint">尚未开始</li> : null}
          {progress.stages.map((stage) => (
            <li key={stage.stage} className={`stage ${stage.status}`}>
              <span className="stage-mark">{stage.status === 'done' ? '✓' : '⋯'}</span>
              <div>
                <div className="stage-name">{stageLabel(stage.stage)}</div>
                {stage.summary === undefined ? null : <div className="stage-summary">{stage.summary}</div>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {progress.tasks.length === 0 ? null : (
        <section>
          <h3 className="section-title">
            任务
            <span className="count">每个任务达成自己的条件才算完成</span>
          </h3>
          <ul className="stages">
            {progress.tasks.map((task) => (
              <li key={task.task} className={`stage ${task.satisfied ? 'done' : ''}`}>
                <span className="stage-mark">{task.satisfied ? '✓' : '⋯'}</span>
                <div>
                  <div className="stage-name">
                    {task.task}
                    <span className="count"> · {task.steps} 步</span>
                  </div>
                  <div className="stage-summary">{task.reason}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="section-title">
          来源
          <span className="count">
            {progress.sources.length} 个 · 正文成功 {fetchedCount} 篇
          </span>
        </h3>
        {progress.sources.length === 0 ? (
          <p className="hint">还没有找到来源。</p>
        ) : (
          <ul className="source-list">
            {progress.sources.map((source) => {
              const fetch = progress.fetches.find((item) => item.url === source.url)
              return (
                <li key={source.url} className="source-item">
                  <a href={source.url} target="_blank" rel="noreferrer noopener" className="source-title">
                    {source.title !== undefined && source.title.length > 0 ? source.title : source.url}
                  </a>
                  <div className="source-url">{source.url}</div>
                  {source.snippet === undefined ? null : <div className="source-snippet">{source.snippet}</div>}
                  <div className="source-status">{describeFetch(fetch)}</div>
                </li>
              )
            })}
          </ul>
        )}
        {progress.sources.length > 0 && progress.fetches.length < progress.sources.length && progress.status === 'done' ? (
          <p className="hint">未出现在上面的来源表示超出了本次抓取上限，没有抓取正文。</p>
        ) : null}
      </section>

      <section>
        <h3 className="section-title">
          日志
          <button type="button" className="btn tiny ghost" onClick={() => setShowLogs((value) => !value)}>
            {showLogs ? '收起' : `展开（${progress.logs.length}）`}
          </button>
        </h3>
        {showLogs ? (
          <pre className="logs">
            {progress.logs.length === 0
              ? '（暂无日志）'
              : progress.logs
                  .map((line) => `${new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })} [${line.level}] ${line.message}`)
                  .join('\n')}
          </pre>
        ) : null}
      </section>
    </div>
  )
}

/** 描述一个来源的抓取状态。 */
function describeFetch(fetch: { ok: boolean; status: number; bytes: number } | undefined): string {
  if (fetch === undefined) return ''
  if (fetch.ok) return `已抓取 ${fetch.bytes} 字`
  return `抓取失败（HTTP ${fetch.status === 0 ? '—' : fetch.status}）`
}
