import { ArrowRight, RefreshCw, SearchCheck, ShieldAlert, Timer } from "lucide-react";
import { useState } from "react";
import { Navigate, useNavigate, useOutletContext } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { TaskSummary } from "../../api/types";
import type { ViewMode } from "../../app/viewMode";
import { executionModeLabel } from "../../app/statusCopy";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { OutcomeDialog } from "./OutcomeDialog";

/** 运行：执行链的实时面。四条队列 = 门 2 待确认 → 在途 → 结果待查（冻结源）→ 待核验。
 * Ⓐ级自动任务成功即归档不在此逗留；出现在「结果待查」的都要人裁决。 */
export function RunsPage() {
  const { mode } = useOutletContext<{ mode: ViewMode }>();
  if (mode !== "audit") return <Navigate replace to="/settings#system-status" />;
  return <AuditRunsLedger />;
}

function AuditRunsLedger() {
  const navigate = useNavigate();
  usePageTitle("运行");
  const [resolving, setResolving] = useState<TaskSummary>();
  const awaiting = useResource((signal) => seoOpsApi.inbox({ status: "APPROVED", limit: 50 }, signal), []);
  const dispatching = useResource((signal) => seoOpsApi.inbox({ status: "DISPATCHING", limit: 50 }, signal), []);
  const unknown = useResource((signal) => seoOpsApi.inbox({ status: "OUTCOME_UNKNOWN", limit: 50 }, signal), []);
  const verify = useResource((signal) => seoOpsApi.inbox({ status: "PENDING_VERIFY", limit: 50 }, signal), []);
  const reloadAll = () => { awaiting.reload(); dispatching.reload(); unknown.reload(); verify.reload(); };

  // 门 2 只针对写入/成品：Ⓐ级 APPROVED 由 scheduler 派发，不需要人。
  const gate2 = (awaiting.data?.items ?? []).filter((t) => t.execution_mode === "AUTO_WRITE" || t.execution_mode === "ARTIFACT");

  return <>
    <header className="page-heading"><div><span className="eyebrow">EXECUTION RUNTIME / 双门之后</span><h1>运行</h1><p>门 2 确认 → 派发在途 → 查证（冻结裁决）→ 核验归档。所有派发一次一个 attempt，禁止自动重试写入。</p></div>
      <div className="heading-actions"><button className="icon-button" aria-label="刷新全部队列" onClick={reloadAll} type="button"><RefreshCw size={16} /></button></div>
    </header>

    <QueuePanel eyebrow="GATE 2" icon={<ShieldAlert size={15} />} title="待执行确认（门 2）"
      hint="已过门 1 的写入/成品任务。进任务页做六项校验后确认派发。"
      items={gate2} loading={awaiting.loading}
      empty="没有等待执行确认的任务。"
      onOpen={(t) => navigate(`/tasks/${t.id}`)} actionLabel="去确认" />

    <QueuePanel eyebrow="IN FLIGHT" icon={<Timer size={15} />} title="派发在途"
      hint="worker 已派发 core-ai 运行，等待终态。结果由 attempt 结算，不由人守着。"
      items={dispatching.data?.items ?? []} loading={dispatching.loading}
      empty="当前没有在途派发。"
      onOpen={(t) => navigate(`/tasks/${t.id}`)} actionLabel="查看" />

    <QueuePanel eyebrow="OUTCOME UNKNOWN / 冻结源" icon={<ShieldAlert size={15} />} title="结果待查"
      hint="动作发生没有无法确认（超时/网络裂缝/取消）。查证是二选一裁决，完成前该商户执行链冻结。"
      items={unknown.data?.items ?? []} loading={unknown.loading}
      empty="没有待查证的执行。" danger
      onOpen={(t) => setResolving(t)} actionLabel="查证" />

    <QueuePanel eyebrow="PENDING VERIFY" icon={<SearchCheck size={15} />} title="待核验"
      hint="已发布 ≠ 已生效。到 GBP / 官网前台确认变更公开可见后核验归档。"
      items={verify.data?.items ?? []} loading={verify.loading}
      empty="没有待核验的发布。"
      onOpen={(t) => navigate(`/tasks/${t.id}`)} actionLabel="去核验" />

    {resolving ? <OutcomeDialog task={resolving} onClose={() => setResolving(undefined)} onDone={() => { setResolving(undefined); reloadAll(); }} /> : null}
  </>;
}

function QueuePanel(props: {
  eyebrow: string; icon: React.ReactNode; title: string; hint: string;
  items: TaskSummary[]; loading: boolean; empty: string; danger?: boolean;
  onOpen: (task: TaskSummary) => void; actionLabel: string;
}) {
  const { eyebrow, icon, title, hint, items, loading, empty, danger, onOpen, actionLabel } = props;
  return <section className={`data-panel run-queue${danger && items.length ? " is-frozen" : ""}`}>
    <div className="panel-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{icon} {title}</h2><p className="quiet-copy">{hint}</p></div><span className="result-count">{loading ? "—" : items.length} 项</span></div>
    {loading ? <div className="page-state" role="status">读取中…</div> : items.length ? <div className="table-wrap"><table><thead><tr><th>任务 / 商户</th><th>类型</th><th>模式</th><th>attempt</th><th>更新</th><th /></tr></thead><tbody>
      {items.map((t) => <tr key={t.id}>
        <td><button className="table-link" onClick={() => onOpen(t)} type="button"><strong>{t.title}</strong><small>{t.merchant_name}{t.location_name ? ` · ${t.location_name}` : ""}</small></button></td>
        <td>{t.task_type}</td>
        <td><ModeTag mode={t.execution_mode} /></td>
        <td>#{t.attempt_count ?? 0}</td>
        <td>{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(t.updated_at))}</td>
        <td><button className="secondary-button" onClick={() => onOpen(t)} type="button">{actionLabel} <ArrowRight size={12} /></button></td>
      </tr>)}
    </tbody></table></div> : <div className="empty-state slim"><p>{empty}</p></div>}
  </section>;
}

export function ModeTag({ mode }: { mode?: string }) {
  const cls = mode === "READ_ONLY" ? "is-stable" : mode === "AUTO_WRITE" ? "is-blocked" : mode === "ARTIFACT" ? "is-attention" : "";
  return <span className={`status-pill ${cls}`}>{executionModeLabel(mode)}</span>;
}
