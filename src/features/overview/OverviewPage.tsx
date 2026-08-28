import { AlertTriangle, ArrowRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateTime, localTzOffsetMinutes } from "../../app/format";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { formatTokens } from "../runs/RunsSummaryStrip";
import { groupExceptions, waitingLabel } from "./exceptionGroups";

/** 总览（管理审计）：先处理挡在路上的事——结果查证、商家等待、建议判定、审批与核验。
 * 异常清单直接复用 workbench 投影（同一批人工决策点），只是按设计稿五组重新归类。 */
export function OverviewPage() {
  const navigate = useNavigate();
  usePageTitle("总览");
  const workspace = useWorkspace();
  const summary = useResource((signal) => seoOpsApi.inboxSummary(signal), []);
  const actions = useResource((signal) => seoOpsApi.workbench({ limit: 100 }, signal), []);
  const activity = useResource((signal) => seoOpsApi.activity({ hours: 24, limit: 20 }, signal), []);
  const runs = useResource((signal) => seoOpsApi.runsLedger({ limit: 1, tz_offset_minutes: localTzOffsetMinutes() }, signal), []);
  const s = summary.data;
  const grouped = groupExceptions(actions.data?.items ?? []);
  const frozenNames = (s?.frozen_merchant_ids ?? []).map((id) => workspace.merchants.find((m) => m.id === id)?.display_name ?? id);
  const cells = [
    { label: "待判定建议", value: s?.pending_proposals, to: "/inbox?tab=proposals&view=audit" },
    { label: "待审批 · 门 1", value: s?.ready_for_approval, to: "/inbox?status=READY_FOR_APPROVAL&view=audit" },
    { label: "待执行确认 · 门 2", value: s?.awaiting_execution, to: "/runs?view=audit" },
    { label: "结果待查", value: s?.outcome_unknown, to: "/runs?view=audit", danger: true, title: "全部未决 attempt，含 GBP 专用回读；异常清单只列可人工查证的部分。" },
    { label: "核验逾期", value: s?.verification_overdue, to: "/inbox?status=PENDING_VERIFY&view=audit" },
    { label: "今日 Agent Run", value: runs.data ? runs.data.summary.completed_today + runs.data.summary.failed_today : undefined, to: "/runs?view=audit" },
  ];
  const total = actions.data?.total ?? 0;
  const merchantsInvolved = new Set((actions.data?.items ?? []).map((i) => i.merchant_id)).size;
  const truncated = actions.data && actions.data.total > actions.data.items.length;

  return <>
    <header className="page-heading"><div><span className="eyebrow">PORTFOLIO · {new Date().toLocaleDateString("zh-CN")} · {workspace.merchants.length} 家商户</span><h1>总览</h1><p>先处理挡在路上的事：结果查证、商家等待、建议判定、审批与核验。其余商户在轨运行。</p></div>
      <div className="heading-actions"><button className="secondary-button" onClick={() => { summary.reload(); actions.reload(); activity.reload(); runs.reload(); }} type="button">刷新</button><button className="primary-button" onClick={() => navigate("/merchants?view=audit")} type="button">＋ 新商户</button></div>
    </header>

    <section aria-label="待处理汇总" className="overview-summary">
      <div className="overview-summary-lead"><span>待处理事项</span><strong>{actions.loading ? "—" : total}</strong><small>涉及 {merchantsInvolved} 家 / 共 {workspace.merchants.length} 家</small></div>
      {cells.map((cell) => <button className={`overview-summary-cell${cell.danger && (cell.value ?? 0) > 0 ? " is-danger" : ""}`} key={cell.label} onClick={() => navigate(cell.to)} title={cell.title} type="button"><span>{cell.label}</span><strong>{cell.value ?? "—"}</strong></button>)}
    </section>

    {(s?.outcome_unknown ?? 0) > 0 ? <section className="frozen-banner" role="alert"><AlertTriangle size={16} /><div><strong>{s?.outcome_unknown} 个执行结果待查</strong><p>涉及商户：{frozenNames.join("、")} —— 查证完成前，这些商户的执行链全部冻结（结果不确定不重试）。</p></div><button className="danger-button" onClick={() => navigate("/runs?view=audit")} type="button">去查证 <ArrowRight size={13} /></button></section> : null}

    <div className="overview-grid">
      <section aria-label="异常清单" className="data-panel overview-exceptions">
        <div className="panel-heading"><div><span className="eyebrow">EXCEPTION LEDGER</span><h2>异常清单</h2><p className="quiet-copy">{total} 项待处理 · 组内按卡住时长排序</p>
          {truncated ? <p className="quiet-copy">仅显示前 {actions.data!.items.length} 项 · 共 {actions.data!.total} 项，其余在「<Link to="/inbox?view=audit">任务</Link>」页处理</p> : null}
        </div></div>
        {actions.loading ? <div className="page-state" role="status">读取待处理事项…</div> : null}
        {actions.error ? <div className="page-state is-error" role="alert">异常清单读取失败。<button onClick={actions.reload} type="button">重试</button></div> : null}
        {!actions.loading && !actions.error && !total ? <div className="empty-state slim"><p>今天没有需要人工处理的事项。</p></div> : null}
        {grouped.map(({ group, items }) => <section className={`exception-group is-${group.key.toLowerCase()}`} key={group.key}>
          <header><span className="exception-badge">{group.badge}</span><h3>{group.label}</h3><small>{group.hint}</small><em>{items.length}</em></header>
          {items.map((item) => <article aria-label={`${item.merchant_name} ${group.label} ${item.title}`} className="exception-row" key={item.id}>
            <div className="exception-copy"><strong>{item.merchant_name}{item.location_name ? <small> · {item.location_name}</small> : null}</strong><p>{item.title} — {item.reason}</p></div>
            <time dateTime={item.waiting_since}>{waitingLabel(item.waiting_since)}</time>
            <button className="action-primary" onClick={() => navigate(item.primary_action.href)} type="button">{item.primary_action.label}</button>
          </article>)}
        </section>)}
      </section>

      <div className="overview-side">
        <section aria-label="今日信号" className="data-panel overview-signals">
          <div className="panel-heading"><div><span className="eyebrow">SCHEDULER · EVENT ROUTER</span><h2>今日信号</h2></div></div>
          {activity.loading ? <div className="page-state compact" role="status">读取信号…</div> : null}
          {activity.error ? <div className="page-state compact is-error" role="alert">信号读取失败。</div> : null}
          <ol className="signal-list">{(activity.data?.items ?? []).map((item) => <li className={`is-${item.severity.toLowerCase()}`} key={item.id}>
            <time dateTime={item.occurred_at}>{formatDateTime(item.occurred_at)}</time>
            <div><strong>{item.title}</strong><span>{item.merchant_name}{item.detail ? <> · <Link to={item.href}>{item.detail}</Link></> : <> · <Link to={item.href}>查看</Link></>}</span></div>
          </li>)}</ol>
          {activity.data && !activity.data.items.length ? <p className="quiet-copy">过去 24 小时没有信号。</p> : null}
        </section>

        <section aria-label="Run 容量" className="data-panel overview-capacity">
          <div className="panel-heading"><div><span className="eyebrow">CORE AI SERVER</span><h2>Run 容量</h2></div></div>
          <dl className="identity-ledger">
            <div><dt>在途 / 排队</dt><dd>{runs.data ? `${runs.data.summary.in_flight} / ${runs.data.summary.queued}` : "—"}</dd></div>
            <div><dt>今日完成 / 失败</dt><dd>{runs.data ? `${runs.data.summary.completed_today} / ${runs.data.summary.failed_today}` : "—"}</dd></div>
            <div><dt>今日 Token</dt><dd>{runs.data ? formatTokens(runs.data.summary.token_total_today) : "—"}</dd></div>
            <div><dt>并发 / 配额</dt><dd>配额未接入 · 当前 API 未提供</dd></div>
          </dl>
          <Link className="text-button" to="/runs?view=audit">查看完整运行账本 <ArrowRight size={12} /></Link>
        </section>
      </div>
    </div>
  </>;
}
