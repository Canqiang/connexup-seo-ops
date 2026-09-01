import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import MerchantList from './pages/MerchantList'
import MerchantDetail from './pages/MerchantDetail'
import TaskDetail from './pages/TaskDetail'
import RunDetail from './pages/RunDetail'

export default function App() {
  return (
    <BrowserRouter>
      <header className="topbar">
        <Link to="/" className="wordmark">SEO OPS</Link>
        <span className="topbar-sub">商户运营台账</span>
      </header>
      <Routes>
        <Route path="/" element={<MerchantList />} />
        <Route path="/merchants/:id" element={<MerchantDetail />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Routes>
    </BrowserRouter>
  )
}
