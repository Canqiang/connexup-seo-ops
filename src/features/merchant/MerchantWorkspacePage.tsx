import { ArrowRight, CheckCircle2, CircleAlert, FileBarChart, ListTodo } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { reviewExplanation } from "../reviews/reviewCopy";

export function MerchantWorkspacePage() {
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const merchant = workspace.merchant;
  const tasks = useResource((signal) => seoOpsApi.inbox({ merchant_id: workspace.merchantId, limit: 8 }, signal), [workspace.merchantId]);
  const reviews = useResource((signal) => seoOpsApi.reviews({ merchant_id: workspace.merchantId, limit: 3 }, signal), [workspace.merchantId]);
  const reports = useResource((signal) => seoOpsApi.reports({ merchant_id: workspace.merchantId, limit: 3 }, signal), [workspace.merchantId]);
  if (workspace.loading) return <div className="page-state" role="status">正在读取商户工作区…</div>;
  if (!merchant) return <div className="page-state is-error" role="alert">商户不存在或当前用户不可见。</div>;
  return <>
    <header className="page-heading"><div><span className="eyebrow">MERCHANT WORKSPACE / {merchant.slug}</span><h1>{merchant.display_name}</h1><p>{merchant.location_count} 个地点 · {merchant.operators.map((item) => item.name).join("、") || "未分配负责人"}</p></div><span className={`status-pill is-${merchant.health.toLocaleLowerCase()}`}>{merchant.health}</span></header>
    <section className="metric-ribbon merchant-metrics"><Metric icon={<ListTodo size={15} />} label="任务" value={merchant.task_count} /><Metric icon={<CircleAlert size={15} />} label="阻塞" value={merchant.blocked_count} tone="danger" /><Metric icon={<CheckCircle2 size={15} />} label="待审批" value={merchant.ready_for_approval_count} tone="attention" /><Metric icon={<FileBarChart size={15} />} label="最新报告" value={reports.data?.items[0] ? freshnessLabel(reports.data.items[0].freshness) : "不可用"} /></section>
    <div className="workspace-grid">
      <section className="data-panel span-two"><div className="panel-heading"><div><span className="eyebrow">ACTION QUEUE</span><h2>当前执行</h2></div><Link className="text-button" to={`/inbox?merchant_id=${merchant.id}`}>全部任务 <ArrowRight size={14} /></Link></div>
        {tasks.loading ? <div className="page-state" role="status">读取任务…</div> : <div className="compact-list">{tasks.data?.items.map((task) => <button onClick={() => navigate(`/tasks/${task.id}`)} type="button" key={task.id}><span className={`priority-tag is-${task.priority.toLocaleLowerCase()}`}>{task.priority}</span><span><strong>{task.title}</strong><small>{task.location_name ?? "商户级"} · {task.evidence_state}</small></span><span className={`status-pill is-${task.status.toLocaleLowerCase()}`}>{task.status}</span></button>)}</div>}
      </section>
      <section className="data-panel"><div className="panel-heading"><div><span className="eyebrow">CAUSAL REVIEW</span><h2>复盘信号</h2></div><Link className="text-button" to={`/reviews?merchant_id=${merchant.id}`}>查看全部</Link></div><div className="mini-cards">{reviews.data?.items.map((item) => <article key={item.task_id}><span className={`classification is-${item.classification.toLocaleLowerCase()}`}>{item.classification}</span><strong>{item.goal ?? "目标未记录"}</strong><p>{reviewExplanation(item.classification)}</p></article>)}{reviews.data && !reviews.data.items.length ? <p className="unavailable">暂无可复盘数据</p> : null}</div></section>
      <section className="data-panel"><div className="panel-heading"><div><span className="eyebrow">REPORT FRESHNESS</span><h2>报告与数据</h2></div><Link className="text-button" to={`/reports?merchant_id=${merchant.id}`}>查看全部</Link></div><div className="mini-cards">{reports.data?.items.map((item) => <article key={item.evidence_id}><span className={`freshness is-${item.freshness.toLocaleLowerCase()}`}>{item.freshness}</span><strong>{item.report_type}</strong><p>{new Date(item.captured_at).toLocaleString("zh-CN")} · {item.sha256?.slice(0, 10) ?? "无哈希"}</p></article>)}{reports.data && !reports.data.items.length ? <p className="unavailable">暂无报告证据</p> : null}</div></section>
    </div>
  </>;
}

function Metric({ icon, label, value, tone = "" }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: string }) { return <article className={tone}><span>{icon}{label}</span><strong>{value}</strong></article>; }
function freshnessLabel(value: string) { return value === "FRESH" ? "新鲜" : value === "AGING" ? "老化" : "过期"; }
