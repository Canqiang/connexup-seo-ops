import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type MerchantStats } from '../api'
import { formatTime } from '../format'
import { RUN_STATUS_LABELS } from '../labels'

export default function MerchantList() {
  const navigate = useNavigate()
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
    <main aria-label="商户台账" className="merchant-ledger-page">
      {error && <p className="error">{error}</p>}
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="section-code">MERCHANTS / 商户</p>
            <h1 id="merchant-list-title">商户</h1>
          </div>
          <form onSubmit={create} aria-label="新建商户" className="compact-form">
            <input aria-label="商户名称" value={name} onChange={e => setName(e.target.value)} placeholder="商户名称" />
            <input aria-label="商户备注" value={notes} onChange={e => setNotes(e.target.value)} placeholder="备注（可选）" />
            <button type="submit" className="primary">＋ 新建商户</button>
          </form>
        </div>
        <div className="table-toolbar">
          <div className="filters" role="group" aria-label="商户状态筛选">
            {(['active', 'archived', 'all'] as const).map(f => (
              <button key={f} disabled={filter === f} onClick={() => setFilter(f)}>
                {f === 'active' ? '在营' : f === 'archived' ? '已归档' : '全部'}
              </button>
            ))}
          </div>
          <span className="result-count">{merchants.length} 个商户</span>
        </div>
        {merchants.length > 0 ? (
          <div className="table-wrap flush">
            <table aria-label="商户列表">
            <thead>
              <tr>
                <th>商户</th>
                <th>状态</th>
                <th>待办</th>
                <th>进行中</th>
                <th>最近分析</th>
                <th>自动分析</th>
                <th aria-label="进入商户" />
              </tr>
            </thead>
            <tbody>
              {merchants.map(m => (
                <tr
                  key={m.id}
                  className="merchant-row"
                  role="link"
                  tabIndex={0}
                  aria-label={`打开商户 ${m.name}`}
                  onClick={() => navigate(`/merchants/${m.id}`)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      navigate(`/merchants/${m.id}`)
                    }
                  }}
                >
                  <td className="grow">
                    <strong className="merchant-name">{m.name}</strong>
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
                  <td className="merchant-enter" aria-hidden="true">→</td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">当前筛选下没有商户。</div>
        )}
      </section>
    </main>
  )
}
