import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { RunLedgerRow } from "../../api/types";
import { formatDateTime } from "../../app/format";
import { formatTokens } from "./RunsSummaryStrip";

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}′${String(seconds).padStart(2, "0")}″` : `${seconds}″`;
}

export function triggerLabel(triggeredBy: string): string {
  if (triggeredBy === "system:scheduler") return "scheduler";
  if (triggeredBy === "system:planner-router") return "planner-router";
  if (triggeredBy.startsWith("system:")) return triggeredBy.slice("system:".length);
  return "人工";
}

export function RunLedgerTable({ items, loading, error, onRetry }: { items: RunLedgerRow[]; loading: boolean; error?: unknown; onRetry: () => void }) {
  const navigate = useNavigate();
  return <div className="table-wrap run-ledger">
    {error ? <div className="page-state compact is-error" role="alert">运行记录读取失败。<button onClick={onRetry} type="button">重试</button></div> : null}
    {loading && !items.length ? <div className="page-state" role="status">读取运行记录…</div> : null}
    {items.length ? <table><thead><tr><th>RUN</th><th>商户 · 阶段</th><th>状态</th><th>Tokens</th><th>耗时</th><th>触发</th><th>交付物</th><th>时间</th><th /></tr></thead><tbody>
      {items.map((run) => <tr aria-label={`${run.merchant_name} ${run.stage} ${run.status}`} key={run.id}>
        <td><code>{run.core_run_id ? `${run.core_run_id.slice(0, 8)}…` : "——（无 run_id）"}</code></td>
        <td><strong>{run.merchant_name}</strong><small>{run.stage} · {run.run_type}</small></td>
        <td><span className={`status-pill is-${run.status.toLocaleLowerCase()}`}>{run.status}</span>{run.error_code ? <small>{run.error_code}</small> : null}</td>
        <td>{run.token_total ? formatTokens(run.token_total) : "—"}</td>
        <td>{formatDuration(run.duration_ms)}</td>
        <td>{triggerLabel(run.triggered_by)}</td>
        <td>{run.deliverable_count ? `${run.deliverable_count} 附件` : "—"}</td>
        <td>{formatDateTime(run.completed_at ?? run.triggered_at)}</td>
        <td>{run.task_id ? <button aria-label={`打开任务 ${run.task_id}`} className="row-arrow" onClick={() => navigate(`/tasks/${run.task_id}`)} type="button"><ArrowRight size={14} /></button> : null}</td>
      </tr>)}
    </tbody></table> : null}
    {!loading && !error && !items.length ? <div className="empty-state slim"><p>当前筛选没有 Run 记录。</p></div> : null}
  </div>;
}
