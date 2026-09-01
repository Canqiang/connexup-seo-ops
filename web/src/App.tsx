import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'
import MerchantList from './pages/MerchantList'
import MerchantDetail from './pages/MerchantDetail'
import TaskDetail from './pages/TaskDetail'
import RunDetail from './pages/RunDetail'
import TasksOverview from './pages/TasksOverview'

function NavGlyph({ name }: { name: 'merchants' | 'tasks' }) {
  const paths = {
    merchants: <><path d="M5 20v-8h14v8M8 12V7h8v5M8 16h2M14 16h2" /></>,
    tasks: <><path d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

function DesktopShell() {
  const { pathname } = useLocation()
  const merchantsActive = pathname === '/' || pathname.startsWith('/merchants/') || pathname.startsWith('/runs/')
  const tasksActive = pathname.startsWith('/tasks')

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="SEO Ops 主导航">
        <Link to="/" className="brand-mark" aria-label="SEO Ops 首页">
          <span>CX</span>
        </Link>
        <nav className="sidebar-nav" aria-label="主要功能">
          <Link to="/" className={merchantsActive ? 'active' : ''} aria-current={merchantsActive ? 'page' : undefined}>
            <NavGlyph name="merchants" />
            <span>商户</span>
          </Link>
          <Link to="/tasks" className={tasksActive ? 'active' : ''} aria-current={tasksActive ? 'page' : undefined}>
            <NavGlyph name="tasks" />
            <span>任务</span>
          </Link>
        </nav>
        <div className="operator-mark" title="SEO Ops Operator">SE</div>
      </aside>

      <section className="workspace">
        <header className="workspace-bar">
          <div className="workspace-context">
            <span className="workspace-kicker">当前工作范围</span>
            <strong>全部商户</strong>
          </div>
          <div className="workspace-operator">
            <span>当前操作员</span>
            <strong>SEO Ops Team</strong>
          </div>
        </header>
        <Routes>
          <Route path="/" element={<MerchantList />} />
          <Route path="/merchants/:id" element={<MerchantDetail />} />
          <Route path="/tasks" element={<TasksOverview />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </section>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <DesktopShell />
    </BrowserRouter>
  )
}
