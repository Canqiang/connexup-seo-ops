import { AlertTriangle, ArrowUpRight, CheckCircle2, Clock3, Layers3 } from "lucide-react";
import { useWorkspace } from "../../workspace/WorkspaceContext";

export function PortfolioPage() {
  const workspace = useWorkspace();
  if (workspace.loading) return <div className="page-state" role="status">正在汇总商户组合…</div>;
  if (workspace.error) return <div className="page-state is-error" role="alert">组合数据读取失败。<button onClick={workspace.reload}>重试</button></div>;
  const portfolio = workspace.portfolio;
  if (!portfolio) return null;
  const merchants = [...portfolio.merchants].sort((a, b) =>
    (b.blocked_count * 100 + b.overdue_count * 10 + b.ready_for_approval_count)
    - (a.blocked_count * 100 + a.overdue_count * 10 + a.ready_for_approval_count));
  return <>
    <header className="page-heading"><div><span className="eyebrow">PORTFOLIO CONTROL / LIVE READBACK</span><h1>代运营组合</h1><p>先看风险与判断缺口，再进入具体商户。</p></div><span className="scope-chip">{merchants.length} 家商户</span></header>
    <section className="metric-ribbon" aria-label="组合总览">
      <Metric icon={<Layers3 size={15} />} label="执行任务" value={portfolio.totals.tasks} note="当前版本" />
      <Metric icon={<AlertTriangle size={15} />} label="阻塞" value={portfolio.totals.blocked} note="需要先解除依赖" tone="danger" />
      <Metric icon={<CheckCircle2 size={15} />} label="待审批" value={portfolio.totals.ready_for_approval} note="等待人工判断" tone="attention" />
      <Metric icon={<Clock3 size={15} />} label="已逾期" value={portfolio.totals.overdue} note="按到期时间回读" />
    </section>
    <section className="data-panel">
      <div className="panel-heading"><div><span className="eyebrow">RISK ORDER</span><h2>商户优先级</h2></div><span className="quiet-copy">阻塞 → 逾期 → 待审批</span></div>
      {merchants.length ? <div className="table-wrap"><table>
        <thead><tr><th>商户</th><th>健康</th><th>地点</th><th>任务</th><th>阻塞</th><th>待审批</th><th>逾期</th><th>负责人</th><th /></tr></thead>
        <tbody>{merchants.map((merchant) => <tr key={merchant.id}>
          <td><button className="table-link" onClick={() => workspace.selectMerchant(merchant.id)} type="button"><strong>{merchant.display_name}</strong><small>{merchant.slug}</small></button></td>
          <td><Status value={merchant.health} /></td><td>{merchant.location_count}</td><td>{merchant.task_count}</td>
          <td className={merchant.blocked_count ? "danger-text" : ""}>{merchant.blocked_count}</td><td>{merchant.ready_for_approval_count}</td><td>{merchant.overdue_count}</td>
          <td>{merchant.operators.map((item) => item.name).join("、") || "未分配"}</td>
          <td><button aria-label={`打开 ${merchant.display_name}`} className="row-arrow" onClick={() => workspace.selectMerchant(merchant.id)} type="button"><ArrowUpRight size={15} /></button></td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state"><h2>还没有商户</h2><p>完成商户与操作员接入后，风险队列会出现在这里。</p></div>}
    </section>
  </>;
}

function Metric({ icon, label, value, note, tone = "" }: { icon: React.ReactNode; label: string; value: number; note: string; tone?: string }) {
  return <article className={tone}><span>{icon}{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function Status({ value }: { value: string }) {
  return <span className={`status-pill is-${value.toLocaleLowerCase()}`}>{value}</span>;
}
