import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import MerchantList from './pages/MerchantList'
import MerchantDetail from './pages/MerchantDetail'
import TaskDetail from './pages/TaskDetail'
import RunDetail from './pages/RunDetail'
import TasksOverview from './pages/TasksOverview'

export default function App() {
  return (
    <BrowserRouter>
      <header className="topbar">
        <Link to="/" className="wordmark">SEO OPS</Link>
        <nav className="topnav">
          <Link to="/">商户</Link>
          <Link to="/tasks">任务总览</Link>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<MerchantList />} />
        <Route path="/merchants/:id" element={<MerchantDetail />} />
        <Route path="/tasks" element={<TasksOverview />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Routes>
    </BrowserRouter>
  )
}
