import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Merchant } from '../api'

export default function MerchantList() {
  const [merchants, setMerchants] = useState<Merchant[]>([])
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
        <button type="submit">新建商户</button>
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
          <li key={m.id}>
            <Link to={`/merchants/${m.id}`}>{m.name}</Link>
            <span className={`badge ${m.status}`}>{m.status === 'active' ? '在营' : '已归档'}</span>
            {m.notes && <span className="muted">{m.notes}</span>}
          </li>
        ))}
      </ul>
    </main>
  )
}
