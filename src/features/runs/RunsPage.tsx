import { ArrowRight, RefreshCw, SearchCheck, ShieldAlert, Timer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useOutletContext } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoTaskStatus, TaskSummary } from "../../api/types";
import type { ViewMode } from "../../app/viewMode";
import { executionModeLabel } from "../../app/statusCopy";
import { hasPermission } from "../../auth/permissions";
import { useAuth } from "../../auth/AuthContext";
import { usePageTitle } from "../../hooks/usePageTitle";
import { OutcomeDialog } from "./OutcomeDialog";

const QUEUE_PAGE_SIZE = 50;

/** 运行：执行链的实时面。四条队列 = 门 2 待确认 → 在途 → 结果待查（冻结源）→ 待核验。
 * Ⓐ级自动任务成功即归档不在此逗留；出现在「结果待查」的都要人裁决。 */
export function RunsPage() {
  const { mode } = useOutletContext<{ mode: ViewMode }>();
  if (mode !== "audit") return <Navigate replace to="/settings#system-status" />;
  return <AuditRunsLedger />;
}

function AuditRunsLedger() {
  const navigate = useNavigate();
  const { user } = useAuth();
  usePageTitle("运行");
  const [resolving, setResolving] = useState<TaskSummary>();
  const canResolveOutcome = hasPermission(user?.permissions, "seoops.execute");
  const awaiting = usePagedInbox("APPROVED");
  const dispatching = usePagedInbox("DISPATCHING");
  const unknown = usePagedInbox("OUTCOME_UNKNOWN");
  const verify = usePagedInbox("PENDING_VERIFY");
  const reloadAll = () => { awaiting.reload(); dispatching.reload(); unknown.reload(); verify.reload(); };

  // 门 2 只针对写入/成品：Ⓐ级 APPROVED 由 scheduler 派发，不需要人。
  const gate2 = awaiting.items.filter((t) => t.execution_mode === "AUTO_WRITE" || t.execution_mode === "ARTIFACT");

  return <>
    <header className="page-heading"><div><span className="eyebrow">EXECUTION RUNTIME / 双门之后</span><h1>运行</h1><p>门 2 确认 → 派发在途 → 查证（冻结裁决）→ 核验归档。所有派发一次一个 attempt，禁止自动重试写入。</p></div>
      <div className="heading-actions"><button className="icon-button" aria-label="刷新全部队列" onClick={reloadAll} type="button"><RefreshCw size={16} /></button></div>
    </header>

    <QueuePanel eyebrow="GATE 2" icon={<ShieldAlert size={15} />} title="待执行确认（门 2）"
      hint="已过门 1 的写入/成品任务。进任务页做六项校验后确认派发。"
      items={gate2} loading={awaiting.loading}
      error={awaiting.error} hasMore={awaiting.hasMore} loaded={awaiting.loaded} total={awaiting.total}
      empty="没有等待执行确认的任务。"
      loadMore={awaiting.loadMore} loadMoreLabel="加载更多待执行确认" retry={awaiting.retry}
      onInspect={(t) => navigate(`/tasks/${t.id}`)} actionLabel="去确认" />

    <QueuePanel eyebrow="IN FLIGHT" icon={<Timer size={15} />} title="派发在途"
      hint="worker 已派发 core-ai 运行，等待终态。结果由 attempt 结算，不由人守着。"
      items={dispatching.items} loading={dispatching.loading}
      error={dispatching.error} hasMore={dispatching.hasMore} loaded={dispatching.loaded} total={dispatching.total}
      empty="当前没有在途派发。"
      loadMore={dispatching.loadMore} loadMoreLabel="加载更多派发在途" retry={dispatching.retry}
      onInspect={(t) => navigate(`/tasks/${t.id}`)} actionLabel="查看" />

    <QueuePanel eyebrow="OUTCOME UNKNOWN / 冻结源" icon={<ShieldAlert size={15} />} title="结果待查"
      hint="动作发生没有无法确认（超时/网络裂缝/取消）。查证是二选一裁决，完成前该商户执行链冻结。"
      items={unknown.items} loading={unknown.loading}
      error={unknown.error} hasMore={unknown.hasMore} loaded={unknown.loaded} total={unknown.total}
      empty="没有待查证的执行。" danger
      loadMore={unknown.loadMore} loadMoreLabel="加载更多结果待查" retry={unknown.retry}
      canAct={canResolveOutcome}
      readOnlyMessage={!canResolveOutcome ? "当前账号可查看结果待查，但没有查证权限。" : undefined}
      onInspect={(t) => navigate(`/tasks/${t.id}`)} onAction={(t) => setResolving(t)} actionLabel="查证" />

    <QueuePanel eyebrow="PENDING VERIFY" icon={<SearchCheck size={15} />} title="待核验"
      hint="已发布 ≠ 已生效。到 GBP / 官网前台确认变更公开可见后核验归档。"
      items={verify.items} loading={verify.loading}
      error={verify.error} hasMore={verify.hasMore} loaded={verify.loaded} total={verify.total}
      empty="没有待核验的发布。"
      loadMore={verify.loadMore} loadMoreLabel="加载更多待核验" retry={verify.retry}
      onInspect={(t) => navigate(`/tasks/${t.id}`)} actionLabel="去核验" />

    {resolving ? <OutcomeDialog task={resolving} onClose={() => setResolving(undefined)} onDone={() => { setResolving(undefined); reloadAll(); }} /> : null}
  </>;
}

function QueuePanel(props: {
  eyebrow: string; icon: React.ReactNode; title: string; hint: string;
  items: TaskSummary[]; loading: boolean; error?: unknown; empty: string; danger?: boolean;
  loaded: number; total?: number; hasMore: boolean; loadMore: () => void; loadMoreLabel: string; retry: () => void;
  onInspect: (task: TaskSummary) => void; onAction?: (task: TaskSummary) => void; actionLabel: string;
  canAct?: boolean; readOnlyMessage?: string;
}) {
  const {
    eyebrow, icon, title, hint, items, loading, error, empty, danger, loaded, total, hasMore,
    loadMore, loadMoreLabel, retry, onInspect, onAction, actionLabel, canAct = true, readOnlyMessage,
  } = props;
  const errorDetail = error instanceof Error ? error.message : "请求失败";
  return <section aria-label={title} className={`data-panel run-queue${danger && items.length ? " is-frozen" : ""}`}>
    <div className="panel-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{icon} {title}</h2><p className="quiet-copy">{hint}</p></div><div className="run-queue-count" aria-live="polite"><span>{loading && loaded === 0 ? "—" : items.length} 项</span><span>{total === undefined ? "原始记录总数待读取" : `已读取 ${loaded} / ${total} 条原始记录`}</span></div></div>
    {readOnlyMessage ? <p className="run-queue-readonly">{readOnlyMessage}</p> : null}
    {error ? <div className="page-state compact is-error run-queue-error" role="alert"><span>{title}读取失败：{errorDetail}</span><button aria-label={`重试${title}`} className="secondary-button" onClick={retry} type="button">重试</button></div> : null}
    {loading && loaded === 0 && !error ? <div className="page-state" role="status">读取中…</div> : null}
    {items.length ? <div className="table-wrap"><table><thead><tr><th>任务 / 商户</th><th>类型</th><th>模式</th><th>attempt</th><th>更新</th><th /></tr></thead><tbody>
      {items.map((t) => <tr key={t.id}>
        <td><button className="table-link" onClick={() => onInspect(t)} type="button"><strong>{t.title}</strong><small>{t.merchant_name}{t.location_name ? ` · ${t.location_name}` : ""}</small></button></td>
        <td>{t.task_type}</td>
        <td><ModeTag mode={t.execution_mode} /></td>
        <td>#{t.attempt_count ?? 0}</td>
        <td>{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(t.updated_at))}</td>
        <td><button className="secondary-button" disabled={!canAct} onClick={() => (onAction ?? onInspect)(t)} type="button">{actionLabel} <ArrowRight size={12} /></button></td>
      </tr>)}
    </tbody></table></div> : null}
    {!items.length && !loading && !error && !hasMore ? <div className="empty-state slim"><p>{empty}</p></div> : null}
    {!items.length && !loading && !error && hasMore ? <div className="empty-state slim"><p>当前已读记录没有符合此队列的任务；继续加载以读取完整后端队列。</p></div> : null}
    {hasMore ? <div className="run-queue-pagination"><button className="secondary-button" disabled={loading} onClick={loadMore} type="button">{loading ? "继续读取…" : loadMoreLabel}</button></div> : null}
  </section>;
}

function usePagedInbox(status: SeoTaskStatus) {
  const [items, setItems] = useState<TaskSummary[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [version, setVersion] = useState(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const failedRequestRef = useRef<{ offset: number; replace: boolean } | undefined>(undefined);

  const load = useCallback(async (offset: number, replace: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const page = await seoOpsApi.inbox({ status, offset, limit: QUEUE_PAGE_SIZE }, controller.signal);
      if (controller.signal.aborted) return;
      setItems((current) => replace ? page.items : [...current, ...page.items]);
      setLoaded(page.offset + page.items.length);
      setTotal(page.total);
      failedRequestRef.current = undefined;
    } catch (reason) {
      if (controller.signal.aborted) return;
      failedRequestRef.current = { offset, replace };
      setError(reason);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load(0, true);
    return () => controllerRef.current?.abort();
  }, [load, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const loadMore = useCallback(() => {
    if (!loading && total !== undefined && loaded < total) void load(loaded, false);
  }, [load, loaded, loading, total]);
  const retry = useCallback(() => {
    const failed = failedRequestRef.current;
    if (failed && !loading) void load(failed.offset, failed.replace);
  }, [load, loading]);

  return { items, loaded, total, loading, error, hasMore: total !== undefined && loaded < total, loadMore, retry, reload };
}

export function ModeTag({ mode }: { mode?: string }) {
  const cls = mode === "READ_ONLY" ? "is-stable" : mode === "AUTO_WRITE" ? "is-blocked" : mode === "ARTIFACT" ? "is-attention" : "";
  return <span className={`status-pill ${cls}`}>{executionModeLabel(mode)}</span>;
}
