import { BrowserRouter, Route, Routes } from 'react-router-dom'

const Placeholder = ({ name }: { name: string }) => <main><h1>{name}</h1></main>

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Placeholder name="商户列表" />} />
        <Route path="/merchants/:id" element={<Placeholder name="商户详情" />} />
        <Route path="/tasks/:id" element={<Placeholder name="任务详情" />} />
      </Routes>
    </BrowserRouter>
  )
}
