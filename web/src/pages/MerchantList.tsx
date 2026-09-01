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
      {merchants.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>商户</th>
                <th>状态</th>
                <th>待办</th>
                <th>进行中</th>
                <th>最近分析</th>
                <th>自动分析</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map(m => (
                <tr key={m.id}>
                  <td className="grow">
                    <Link to={`/merchants/${m.id}`}>{m.name}</Link>
                    {m.notes && <div className="dim">{m.notes}</div>}
                  </td>
                  <td className="nowrap">
                    <span className={`badge ${m.status}`}>{m.status === 'active' ? '在营' : '已归档'}</span>
                  </td>
                  <td>{m.todo_count > 0 ? <strong>{m.todo_count}</strong> : <span className="dim">0</span>}</td>
                  <td>{m.doing_count > 0 ? <strong>{m.doing_count}</strong> : <span className="dim">0</span>}</td>
                  <td className="nowrap">
                    {m.has_running_run
                      ? <span className="badge running">分析中</span>
                      : m.last_run_at
                        ? <>
                            <span className="dim">{formatTime(m.last_run_at)}</span>
                            {' '}
                            {m.last_run_status && <span className={`badge ${m.last_run_status}`}>{RUN_STATUS_LABELS[m.last_run_status]}</span>}
                          </>
                        : <span className="dim">未分析</span>}
                  </td>
                  <td className="dim nowrap">{m.auto_run_interval_days != null ? `每 ${m.auto_run_interval_days} 天` : '关闭'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
