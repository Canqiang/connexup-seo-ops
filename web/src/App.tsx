import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'
import { api, type Operator } from './api'
import MerchantList from './pages/MerchantList'
import MerchantDetail from './pages/MerchantDetail'
import TaskDetail from './pages/TaskDetail'
import RunDetail from './pages/RunDetail'
import TasksOverview from './pages/TasksOverview'
import MerchantProfile from './pages/MerchantProfile'
import PerformanceDashboard from './pages/PerformanceDashboard'

function NavGlyph({ name }: { name: 'merchants' | 'tasks' | 'dashboard' }) {
  const paths = {
    merchants: <><path d="M5 20v-8h14v8M8 12V7h8v5M8 16h2M14 16h2" /></>,
    tasks: <><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></>,
    dashboard: <><path d="M4 19V5M4 19h16M7 15l4-4 3 2 5-7M19 6v4h-4" /></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

function DesktopShell({ operator, onLogout }: { operator: Operator; onLogout: () => Promise<void> }) {
  const { pathname } = useLocation()
  const merchantsActive = pathname === '/' || pathname.startsWith('/merchants/') || pathname.startsWith('/runs/')
  const tasksActive = pathname.startsWith('/tasks')
  const dashboardActive = pathname === '/dashboard'

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="SEO Ops 主导航">
        <Link to="/" className="brand-mark" aria-label="SEO Ops 首页">
          <span>SEO</span>
        </Link>
        <nav className="sidebar-nav" aria-label="主要功能">
          <Link to="/dashboard" className={dashboardActive ? 'active' : ''} aria-current={dashboardActive ? 'page' : undefined}>
            <NavGlyph name="dashboard" />
            <span>看板</span>
          </Link>
          <Link to="/" className={merchantsActive ? 'active' : ''} aria-current={merchantsActive ? 'page' : undefined}>
            <NavGlyph name="merchants" />
            <span>商户</span>
          </Link>
          <Link to="/tasks" className={tasksActive ? 'active' : ''} aria-current={tasksActive ? 'page' : undefined}>
            <NavGlyph name="tasks" />
            <span>任务</span>
          </Link>
        </nav>
      </aside>

      <section className="workspace">
        <header className="workspace-bar">
          <div className="workspace-operator" role="group" aria-label="操作员账户">
            <span>当前操作员</span>
            <div className="workspace-operator-row" role="group" aria-label="当前操作员操作">
              <strong className="workspace-operator-name" title={operator.username}>{operator.username}</strong>
              <span className="workspace-operator-divider" aria-hidden="true" />
              <button type="button" className="logout-link" onClick={() => void onLogout()}>退出</button>
            </div>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<MerchantList />} />
          <Route path="/merchants/:id" element={<MerchantDetail />} />
          <Route path="/merchants/:id/profile" element={<MerchantProfile />} />
          <Route path="/tasks" element={<TasksOverview />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/dashboard" element={<PerformanceDashboard />} />
        </Routes>
      </section>
    </div>
  )
}

function LoginPage({ onLogin }: { onLogin: (operator: Operator) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      onLogin(await api.login(username, password))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page" aria-label="SEO Ops 登录">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">SEO</div>
        <p className="eyebrow">CONNEXUP / INTERNAL</p>
        <h1>SEO Ops</h1>
        <p className="page-summary">内部运营控制台</p>
        <label>账号<input aria-label="账号" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label>
        <label>密码<input aria-label="密码" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </main>
  )
}

export default function App() {
  const [operator, setOperator] = useState<Operator | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api.me()
      .then(value => {
        setOperator(value && typeof value.username === 'string'
          ? value
          : { username: 'SEO Ops Team', role: 'operator' })
      })
      .catch(() => setOperator(null))
      .finally(() => setChecking(false))
  }, [])

  const logout = async () => {
    await api.logout()
    setOperator(null)
  }

  if (checking) return <div className="auth-loading" aria-label="正在验证登录">正在验证…</div>

  return (
    <BrowserRouter>
      {operator
        ? <DesktopShell operator={operator} onLogout={logout} />
        : <LoginPage onLogin={setOperator} />}
    </BrowserRouter>
  )
}
