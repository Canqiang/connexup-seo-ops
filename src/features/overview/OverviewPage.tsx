import { AlertTriangle, ArrowRight, CheckCheck, GitPullRequestArrow, Inbox, SearchCheck, ShieldQuestion } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { STAGE_LABELS } from "../merchant/lifecycleCopy";

/** 总览：一屏看清今天要人出手的四类事——判定建议、门 1 审批、门 2 执行确认、
 * 查证/核验。Ⓐ级自动运行不在这里刷存在感，只有出事（结果待查）才浮上来。 */
export function OverviewPage() {
  const navigate = useNavigate();
  usePageTitle("总览");
  const workspace = useWorkspace();
  const summary = useResource((signal) => seoOpsApi.inboxSummary(signal), []);
  const merchants = workspace.merchants;
  const s = summary.data;
  const frozenNames = (s?.frozen_merchant_ids ?? [])
    .map((id) => merchants.find((m) => m.id === id)?.display_name ?? id);

  const queues = [
    {
      key: "proposals", icon: GitPullRequestArrow, label: "待判定建议", count: s?.pending_proposals ?? 0,
      hint: "Planner / Plan 拆解产出的建议，采纳成任务或退回", to: "/inbox?tab=proposals",
    },
    {
      key: "approval", icon: Inbox, label: "待审批（门 1）", count: s?.ready_for_approval ?? 0,
      hint: "批的是任务修订版的执行定义（rev + hash）", to: "/inbox?status=READY_FOR_APPROVAL",
    },
    {
      key: "execute", icon: CheckCheck, label: "待执行确认（门 2）", count: s?.awaiting_execution ?? 0,
      hint: "已批准的写入/成品任务，六项服务端校验后派发", to: "/runs",
    },
    {
      key: "verify", icon: SearchCheck, label: "待核验", count: s?.pending_verify ?? 0,
      hint: "已发布 ≠ 已生效：7 天内确认变更公开可见", to: "/runs",
    },
  ];

  return <>
    <header className="page-heading"><div><span className="eyebrow">OPERATIONS LEDGER / 账本视角</span><h1>总览</h1><p>{merchants.length} 个商户在管 · Ⓐ级只读任务由周期自动运行，人只处理判定、双门与查证。</p></div>
      <div className="heading-actions">{summary.data ? null : <span className="quiet-copy">正在读取队列徽标…</span>}</div>
    </header>

    {(s?.outcome_unknown ?? 0) > 0 ? <section className="frozen-banner" role="alert">
      <AlertTriangle size={16} />
      <div><strong>{s?.outcome_unknown} 个执行结果待查</strong><p>涉及商户：{frozenNames.join("、")} —— 查证完成前，这些商户的执行链全部冻结（红线③：结果不确定不重试）。</p></div>
      <button className="danger-button" onClick={() => navigate("/runs")} type="button">去查证 <ArrowRight size={13} /></button>
    </section> : null}

    <div className="queue-grid">
      {queues.map(({ key, icon: Icon, label, count, hint, to }) => (
        <button className={`queue-card${count > 0 ? " has-items" : ""}`} key={key} onClick={() => navigate(to)} type="button">
          <span className="queue-icon"><Icon size={17} /></span>
          <strong className="queue-count">{summary.loading ? "—" : count}</strong>
          <span className="queue-label">{label}</span>
          <p>{hint}</p>
        </button>
      ))}
    </div>

    <section className="data-panel">
      <div className="panel-heading"><div><span className="eyebrow">MERCHANT PORTFOLIO</span><h2>商户面</h2></div>
        <button className="text-button" onClick={() => navigate("/merchants")} type="button">全部商户 <ArrowRight size={12} /></button></div>
      <div className="table-wrap"><table><thead><tr><th>商户</th><th>阶段</th><th>健康</th><th>任务</th><th>待审批</th><th>阻塞</th><th /></tr></thead><tbody>
        {merchants.slice(0, 8).map((m) => <tr key={m.id}>
          <td><button className="table-link" onClick={() => navigate(`/merchants/${m.id}`)} type="button"><strong>{m.display_name}</strong><small>{m.location_count} 地点</small></button></td>
          <td>{m.stage ? STAGE_LABELS[m.stage] ?? m.stage : "—"}</td>
          <td><span className={`status-pill is-${m.health.toLocaleLowerCase()}`}>{m.health}</span></td>
          <td>{m.task_count}</td><td>{m.ready_for_approval_count}</td><td>{m.blocked_count}</td>
          <td><button aria-label={`打开 ${m.display_name}`} className="row-arrow" onClick={() => navigate(`/merchants/${m.id}`)} type="button"><ArrowRight size={15} /></button></td>
        </tr>)}
      </tbody></table>
        {!merchants.length ? <div className="empty-state"><ShieldQuestion size={18} /><h2>还没有商户</h2><p>在「商户」页新建第一个商户开始接入。</p></div> : null}
      </div>
    </section>
  </>;
}
