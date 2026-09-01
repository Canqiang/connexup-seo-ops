import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type MerchantStats } from '../api'
import { formatTime } from '../format'
import { RUN_STATUS_LABELS } from '../labels'

export default function MerchantList() {
  const [merchants, setMerchants] = useState<MerchantStats[]>([])
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('active')
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.listMerchants(filter === 'all' ? undefined : filter)
      .then(ms => { setMerchants(ms); setError('') })
      .catch(e => setError((e as Error).message))
  }, [filter])

  useEffect(load, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      await api.createMerchant({ name: name.trim(), notes: notes.trim() || undefined })
      setName('')
      setNotes('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <main>
      <h1>商户台账</h1>
      {error && <p className="error">{error}</p>}
      <form onSubmit={create}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="商户名称" />
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="备注（可选）" />
        <button type="submit" className="primary">新建商户</button>
      </form>
      <div className="filters">
        {(['active', 'archived', 'all'] as const).map(f => (
          <button key={f} disabled={filter === f} onClick={() => setFilter(f)}>
            {f === 'active' ? '在营' : f === 'archived' ? '已归档' : '全部'}
          </button>
        ))}
      </div>
      <ul className="list">
        {merchants.map(m => (
          <li key={m.id} className="task-row">
            <div className="task-line1">
              <Link to={`/merchants/${m.id}`}>{m.name}</Link>
              <span className={`badge ${m.status}`}>{m.status === 'active' ? '在营' : '已归档'}</span>
              {m.auto_run_interval_days != null && <span className="badge">自动·{m.auto_run_interval_days} 天</span>}
              <span className="muted row-end">
                {m.has_running_run
                  ? <span className="badge running">分析中</span>
                  : m.last_run_at
                    ? <>最近分析 {formatTime(m.last_run_at)} · {m.last_run_status ? RUN_STATUS_LABELS[m.last_run_status] : ''}</>
                    : '未分析过'}
              </span>
            </div>
            <div className="task-line2 muted">
              <span>{m.todo_count > 0 || m.doing_count > 0
                ? `待办 ${m.todo_count} · 进行中 ${m.doing_count}`
                : '无待办任务'}</span>
              {m.notes && <span>{m.notes}</span>}
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}
