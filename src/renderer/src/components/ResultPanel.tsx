/**
 * 报告面板：合成结果、来源清单与产物文件。
 *
 * 报告正文一律当作文本渲染（不使用 dangerouslySetInnerHTML），
 * 因此即使抓下来的网页里带脚本，也不可能在这里被执行。
 */

import { useState } from 'react'
import type { Artifact, Report } from '../../../main/engine/types.ts'
import { parseIpcError, requireApi } from '../api.ts'

/** 报告面板属性。 */
export interface ResultPanelProps {
  readonly report: Report
  readonly artifacts: readonly Artifact[]
  readonly runId: string | null
  readonly onNotice: (message: string) => void
}

export function ResultPanel({ report, artifacts, runId, onNotice }: ResultPanelProps): React.JSX.Element {
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const fetchedBySource = new Map<string, { chars: number; truncated: boolean }>()
  for (const document of report.documents) {
    fetchedBySource.set(document.sourceUrl ?? document.url, { chars: document.text.length, truncated: document.truncated })
  }
  const failedBySource = new Map(report.failures.map((failure) => [failure.url, failure.reason]))

  /** 打开产物预览。 */
  const openPreview = async (path: string): Promise<void> => {
    if (runId === null) return
    setBusy(true)
    try {
      setPreview({ path, content: await requireApi().readArtifact(runId, path) })
    } catch (error) {
      onNotice(parseIpcError(error).message)
    } finally {
      setBusy(false)
    }
  }

  /** 在文件管理器中定位产物。 */
  const reveal = async (path: string): Promise<void> => {
    if (runId === null) return
    try {
      await requireApi().revealArtifact(runId, path)
    } catch (error) {
      onNotice(parseIpcError(error).message)
    }
  }

  return (
    <article className="report">
      <header className="report-head">
        <h2>{report.synthesis.title}</h2>
        <div className="chips">
          <span className="chip">查询：{report.query}</span>
          <span className="chip">{new Date(report.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
          <span className="chip">用时 {(report.durationMs / 1000).toFixed(1)}s</span>
          <span className="chip">来源 {report.sources.length}</span>
          <span className="chip">整理 {report.provenance.organize}</span>
          {report.provenance.model === undefined ? null : <span className="chip">模型 {report.provenance.model}</span>}
          {report.provenance.searchFallbackUsed ? <span className="chip warn">搜索已降级</span> : null}
        </div>
      </header>

      {report.provenance.degraded === undefined ? null : (
        <div className="alert warn">
          <strong>本次整理发生了降级</strong>
          <p>{report.provenance.degraded}</p>
        </div>
      )}

      {report.synthesis.summary.length === 0 ? null : (
        <section>
          <h3 className="section-title">摘要</h3>
          <p className="summary">{report.synthesis.summary}</p>
        </section>
      )}

      <section>
        <h3 className="section-title">
          正文
          <span className="count">{report.synthesis.sections.length} 节</span>
        </h3>
        {report.synthesis.sections.length === 0 ? (
          <p className="hint">没有生成任何小节：没有取得可用的正文或摘要。</p>
        ) : (
          report.synthesis.sections.map((section, index) => (
            <div key={`${section.heading}-${index}`} className="report-section">
              <h4>{section.heading}</h4>
              {section.body.split(/\n{2,}/).map((paragraph, paragraphIndex) => (
                <p key={paragraphIndex}>{paragraph}</p>
              ))}
              {section.citations.length === 0 ? null : (
                <div className="citations">
                  引用：
                  {section.citations.map((url) => {
                    const position = report.sources.findIndex((source) => source.url === url)
                    return (
                      <a key={url} href={url} target="_blank" rel="noreferrer noopener" className="citation">
                        {position === -1 ? url : `#${position + 1}`}
                      </a>
                    )
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </section>

      <section>
        <h3 className="section-title">来源</h3>
        <ol className="source-list numbered">
          {report.sources.map((source) => {
            const fetched = fetchedBySource.get(source.url)
            const failure = failedBySource.get(source.url)
            return (
              <li key={source.url} className="source-item">
                <a href={source.url} target="_blank" rel="noreferrer noopener" className="source-title">
                  {source.title !== undefined && source.title.length > 0 ? source.title : source.url}
                </a>
                <div className="source-url">{source.url}</div>
                <div className={`source-status ${failure === undefined ? '' : 'bad'}`}>
                  {fetched !== undefined
                    ? `已抓取 ${fetched.chars} 字${fetched.truncated ? '（已截断）' : ''}`
                    : failure !== undefined
                      ? `抓取失败：${failure}`
                      : '未抓取（超出本次抓取上限）'}
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      <section>
        <h3 className="section-title">
          产物
          {runId === null ? null : <span className="count">{report.runId}</span>}
        </h3>
        <ul className="artifact-list">
          {artifacts.map((artifact) => (
            <li key={artifact.path} className="artifact-item">
              <span className="artifact-path">{artifact.path}</span>
              <span className="artifact-size">{formatBytes(artifact.bytes)}</span>
              <button type="button" className="btn tiny" disabled={busy} onClick={() => void openPreview(artifact.path)}>
                预览
              </button>
              <button type="button" className="btn tiny ghost" onClick={() => void reveal(artifact.path)}>
                定位
              </button>
            </li>
          ))}
        </ul>
      </section>

      {preview === null ? null : (
        <section className="preview">
          <h3 className="section-title">
            {preview.path}
            <button type="button" className="btn tiny ghost" onClick={() => setPreview(null)}>
              关闭
            </button>
          </h3>
          <pre className="preview-body">{preview.content}</pre>
        </section>
      )}

      <footer className="report-foot">
        引用编号对应「来源」列表。大模型整理可能概括失准，关键结论请点开来源原文核对。
      </footer>
    </article>
  )
}

/** 人类可读的字节数。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
