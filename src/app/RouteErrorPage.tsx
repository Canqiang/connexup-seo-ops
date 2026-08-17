import { Link } from "react-router-dom";

export function RouteErrorPage() {
  return <section className="empty-state"><span className="eyebrow">ROUTE NOT FOUND</span><h1>这个工作区不存在</h1><p>链接可能已过期，或你没有对应商户的访问权限。</p><Link className="primary-button" to="/">返回全部商户</Link></section>;
}
