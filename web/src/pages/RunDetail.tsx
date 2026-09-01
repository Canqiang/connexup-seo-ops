import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Run } from '../api'
import { formatTime } from '../format'

const LABELS: Record<Run['status'], string> = { running: '进行中', succeeded: '成功', failed: '失败' }

export default function RunDetail() {
  const { id } = useParams()
  const runId = Number(id)
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getRun(runId).then(setRun).catch(e => setError((e as Error).message))
  }, [runId])

  if (!run) {
    return (
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main>
      <p><Link to={`/merchants/${run.merchant_id}`}>← 返回商户</Link></p>
      <h1>分析 #{run.id}</h1>
      <p>
        <span className={`badge ${run.status}`}>{LABELS[run.status]}</span>
        <span className="muted">{run.trigger_kind === 'auto' ? '自动' : '手动'} · 发起于 {formatTime(run.created_at)}{run.finished_at ? ` · 结束于 ${formatTime(run.finished_at)}` : ''}</span>
      </p>
      {error && <p className="error">{error}</p>}
      {run.error && <p className="error">{run.error}</p>}

      <h2>报告</h2>
      {run.report_text
        ? <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{run.report_text}</pre>
        : <p className="muted">（暂无报告）</p>}
    </main>
  )
}
