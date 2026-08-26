import { ShieldQuestion, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { AttemptWire, TaskSummary } from "../../api/types";
import { useResource } from "../../hooks/useResource";

/** 查证弹层：二选一等权重裁决 —— 「动作发生了」进入核验，「没发生」回到已批准。
 * 强制查证据（probe_ref / core run），不允许「大概没发生」直接重试。 */
export function OutcomeDialog({ task, onClose, onDone }: {
  task: TaskSummary; onClose: () => void; onDone: () => void;
}) {
  const attempts = useResource((signal) => seoOpsApi.attempts(task.id, signal), [task.id]);
  const detail = useResource((signal) => seoOpsApi.task(task.id, signal), [task.id]);
  const open = useMemo<AttemptWire | undefined>(
    () => attempts.data?.items.find((a) => a.status === "OUTCOME_UNKNOWN"),
    [attempts.data],
  );
  const [resolution, setResolution] = useState<"HAPPENED" | "NOT_HAPPENED">();
  const [note, setNote] = useState("");
  const [publishedRef, setPublishedRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!open || !resolution || !detail.data) return;
    if (!note.trim()) { setError("请填写查证依据（看了什么、看到了什么）。"); return; }
    setBusy(true); setError(undefined);
    try {
      await seoOpsApi.resolveOutcome(open.id, {
        resolution,
        note,
        ...(resolution === "HAPPENED" && publishedRef.trim() ? { published_ref: publishedRef.trim() } : {}),
        expected_state_version: detail.data.state_version,
        idempotency_key: `resolve-${open.id}`,
      });
      onDone();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        // 版本已过期（他人/worker 先动了任务）：刷新最新状态再让人复核重提。
        detail.reload();
        attempts.reload();
        setError("任务在查证期间发生了变化，已刷新最新状态 —— 请复核后重新提交。");
      } else {
        setError(reason instanceof Error ? reason.message : "查证提交失败");
      }
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="查证执行结果">
    <div className="modal-card">
      <header className="modal-head"><div><span className="eyebrow">OUTCOME RESOLUTION / 查证</span><h2><ShieldQuestion size={16} /> {task.title}</h2><p>{task.merchant_name} · attempt #{open?.attempt_no ?? "—"} · 线索号 <code>{open?.probe_ref ?? "…"}</code></p></div>
        <button aria-label="关闭" className="icon-button" onClick={onClose} type="button"><X size={15} /></button></header>
      <div className="modal-body">
        <p className="verify-guide">去外部资产核对这一条动作是否落地（GBP 后台 / 官网前台 / core run 日志），二选一：</p>
        {open?.error ? <p className="quiet-copy">失败上下文：{open.error}</p> : null}
        <div className="outcome-choice">
          <button className={`choice-card${resolution === "HAPPENED" ? " is-active" : ""}`} onClick={() => setResolution("HAPPENED")} type="button">
            <strong>动作发生了</strong><p>外部已能看到这条变更 → 任务进入待核验，补录发布引用。</p>
          </button>
          <button className={`choice-card${resolution === "NOT_HAPPENED" ? " is-active is-negative" : ""}`} onClick={() => setResolution("NOT_HAPPENED")} type="button">
            <strong>没发生</strong><p>外部确认无此变更 → attempt 记确认失败，任务回「已批准」，可再次确认执行。</p>
          </button>
        </div>
        {resolution === "HAPPENED" ? <label>发布引用（帖子 URL / 变更 ID，可选）
          <input onChange={(e) => setPublishedRef(e.target.value)} placeholder="https://…" value={publishedRef} /></label> : null}
        <label>查证依据（必填）
          <textarea onChange={(e) => setNote(e.target.value)} placeholder="例：GBP 后台 Posts 列表核对，无 8/26 帖" rows={3} value={note} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="modal-foot">
        <span className="quiet-copy">查证完成即解除该商户执行链冻结。</span>
        <div><button className="secondary-button" onClick={onClose} type="button">取消</button>
          <button className="primary-button" disabled={!open || !resolution || busy || attempts.loading || detail.loading} onClick={() => void submit()} type="button">{busy ? "提交中…" : "提交裁决"}</button></div>
      </footer>
    </div>
  </div>;
}
