import { ArrowRight, FlaskConical } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { EffectReviewItem } from "../../api/types";
import { formatDateOnly } from "../../app/format";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { classificationLabel, reviewExplanation, tierLabel } from "./reviewCopy";

function kv(value: Record<string, unknown>): string {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ") : "数据不可用";
}

export function ReviewsPage() {
  usePageTitle("复盘");
  const workspace = useWorkspace();
  const [params] = useSearchParams();
  const merchantId = params.get("merchant_id") ?? workspace.merchantId;
  const effect = useResource((signal) => seoOpsApi.effectReviews(merchantId, signal), [merchantId]);
  const tasks = useResource((signal) => seoOpsApi.reviews({ merchant_id: merchantId, limit: 50 }, signal), [merchantId]);
  const s = effect.data?.summary;
  const tiers = s ? Object.entries(s.by_tier).map(([tier, n]) => `${tier} ×${n}`).join(" · ") : "—";
  return <>
    <header className="page-heading"><div><span className="eyebrow">OUTCOME REVIEW · 跨商户</span><h1>复盘</h1><p>动作之后发生了什么。单店结论上限 ASSOCIATIONAL（关联），不宣称因果；跨店聚合仅作模式探索，不进客户报告。</p></div><span className="scope-chip"><FlaskConical size={14} /> {workspace.merchants.find((m) => m.id === merchantId)?.display_name ?? "全部商户"}</span></header>

    <section aria-label="复盘汇总" className="runs-summary">
      <div className="runs-summary-cell"><span>已完成复盘</span><strong>{s?.total ?? "—"}</strong><small>快照冻结 · 可同快照重放</small></div>
      <div className={`runs-summary-cell${s?.due_count ? " is-danger" : ""}`}><span>到窗口待复盘</span><strong>{s?.due_count ?? "—"}</strong><small>Gate D · 窗口未到不复盘</small></div>
      <div className="runs-summary-cell"><span>结论分布</span><strong>{s ? Object.values(s.by_tier).reduce((a, b) => a + b, 0) : "—"}</strong><small>{tiers}</small></div>
      <div className="runs-summary-cell"><span>证据上限</span><strong>ASSOC.</strong><small>无对照组 · causalIdentified = false</small></div>
    </section>

    {effect.loading ? <div className="page-state" role="status">读取复盘…</div> : null}
    {effect.error ? <div className="page-state is-error" role="alert">复盘读取失败。<button onClick={effect.reload} type="button">重试</button></div> : null}
    <div className="review-list">{effect.data?.items.map((item) => <ReviewCard item={item} key={item.artifact_id} />)}</div>
    {effect.data && !effect.data.items.length ? <div className="empty-state slim"><p>还没有复盘产物。到达复盘窗口后由 REVIEW 任务自动出稿，结论上限 ASSOCIATIONAL。</p></div> : null}

    <section aria-label="到窗口队列" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">GATE D</span><h2>到窗口队列</h2><p className="quiet-copy">窗口未到不复盘 · 窗口 = 上次复盘 + 复盘窗口天数</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>商户</th><th>上次复盘</th><th>下次窗口</th><th>状态</th></tr></thead><tbody>
        {(effect.data?.windows ?? []).map((w) => <tr key={w.merchant_id}><td>{w.merchant_name}</td><td>{formatDateOnly(w.last_review_at)}</td><td>{w.next_window_at ? formatDateOnly(w.next_window_at) : w.review_window_days ? "待首轮复盘" : "未配置窗口"}</td><td><span className={`status-pill ${w.status === "DUE" ? "is-attention" : "is-stable"}`}>{w.status === "DUE" ? "已到期" : w.status === "UPCOMING" ? "将到期" : "未排期"}</span></td></tr>)}
      </tbody></table></div></section>

    <section aria-label="任务级证据分级" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">TASK EVIDENCE · 审计</span><h2>任务级证据分级</h2><p className="quiet-copy">按任务当前版本的已核实证据类型分级，不构成因果证明。</p></div></div>
      {tasks.loading ? <div className="page-state compact" role="status">读取任务证据…</div> : null}
      {tasks.error ? <div className="page-state compact is-error" role="alert">任务级证据读取失败。<button onClick={tasks.reload} type="button">重试</button></div> : null}
      <div className="review-list">{tasks.data?.items.map((item) => <article aria-labelledby={`review-${item.task_id}`} className={`review-card review-${item.classification.toLocaleLowerCase()}`} key={item.task_id}>
        <header><div><span className="eyebrow">TASK {item.task_id}</span><h3 id={`review-${item.task_id}`}>{item.goal ?? "目标未记录"}</h3></div><span className={`classification is-${item.classification.toLocaleLowerCase()}`} title={classificationLabel(item.classification)}>{item.classification}</span></header>
        <p className={`review-explanation${item.classification === "CORRELATIONAL" ? " is-association" : ""}`}>{item.classification === "CORRELATIONAL" ? <strong>关联观察，不代表因果</strong> : null}<span>{reviewExplanation(item.classification)}</span></p>
        <footer><span>{item.evidence_ids.length} 条技术证据引用</span><Link className="text-button" to={`/tasks/${encodeURIComponent(item.task_id)}`}>查看任务 <ArrowRight size={14} /></Link></footer>
      </article>)}</div>
      {tasks.data && !tasks.data.items.length ? <div className="empty-state slim"><p>当前筛选没有可分级的任务证据。</p></div> : null}
    </section>
  </>;
}

function ReviewCard({ item }: { item: EffectReviewItem }) {
  const rows: Array<[string, string]> = [
    ["目标", item.summary],
    ["基线", kv(item.baseline)],
    ["动作束", item.action_bundle.length ? item.action_bundle.map((a) => String(a.description ?? a.action_id ?? "")).filter(Boolean).join(" · ") + "（bundle 不拆单归因）" : "数据不可用"],
    ["观察变化", kv(item.observed_change)],
    ["竞争与混杂", item.confounders.length ? item.confounders.join(" · ") : "未记录"],
    ["负向证据 / 局限", item.limitations.length ? item.limitations.join(" · ") : "未披露"],
    ["结论与建议", item.conclusion],
    ["下一轮输入", item.planning_signals.length ? item.planning_signals.map((p) => JSON.stringify(p)).join(" · ") : "—"],
  ];
  return <article aria-label={item.title} className={`review-card review-tier-${item.conclusion_tier.toLowerCase()}`}>
    <header><div><span className="eyebrow">{item.merchant_name} · {formatDateOnly(item.created_at)} · run {item.core_run_id.slice(0, 8)}</span><h2>{item.title}</h2></div><span className="classification">{tierLabel(item.conclusion_tier)}</span></header>
    <dl className="causal-chain is-review">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <footer><span>验收 {item.acceptance_status} · <code>causalIdentified = false</code></span><Link className="text-button" to={`/tasks/${encodeURIComponent(item.task_id)}`}>打开报告任务 <ArrowRight size={14} /></Link></footer>
  </article>;
}
