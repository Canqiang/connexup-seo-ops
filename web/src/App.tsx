import { BrowserRouter, Route, Routes } from 'react-router-dom'
import MerchantList from './pages/MerchantList'
import MerchantDetail from './pages/MerchantDetail'

const Placeholder = ({ name }: { name: string }) => <main><h1>{name}</h1></main>

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MerchantList />} />
        <Route path="/merchants/:id" element={<MerchantDetail />} />
        <Route path="/tasks/:id" element={<Placeholder name="任务详情" />} />
      </Routes>
    </BrowserRouter>
  )
}
