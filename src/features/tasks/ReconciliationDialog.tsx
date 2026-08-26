import { ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { AttemptWire } from "../../api/types";
import { useResource } from "../../hooks/useResource";

/** 结果不明只能由人给出等权重的发生/未发生结论；这里从不发起自动重试。 */
export function ReconciliationDialog({ attempt, onClose, onResolved }: {
  attempt: AttemptWire; onClose: () => void; onResolved: () => void;
}) {
  const task = useResource((signal) => seoOpsApi.task(attempt.task_id, signal), [attempt.task_id]);
  const [resolution, setResolution] = useState<"HAPPENED" | "NOT_HAPPENED">();
  const [note, setNote] = useState("");
  const [publishedRef, setPublishedRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canSubmit = Boolean(resolution && note.trim() && !busy);

  const submit = async () => {
    if (!resolution || !note.trim()) return;
    if (!task.data) { setError("正在读取任务当前版本，请稍候再提交。"); return; }
    setBusy(true); setError(undefined);
    try {
      await seoOpsApi.resolveOutcome(attempt.id, {
        resolution,
        note: note.trim(),
        ...(resolution === "HAPPENED" && publishedRef.trim() ? { published_ref: publishedRef.trim() } : {}),
        expected_state_version: task.data.state_version,
        idempotency_key: `resolve-${attempt.id}`,
      });
      onResolved();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        task.reload();
        setError("任务在查证期间发生变化，已刷新。请重新复核后提交。");
      } else setError(reason instanceof Error ? reason.message : "查证提交失败");
    } finally { setBusy(false); }
  };

  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="查证执行结果">
    <div className="modal-card reconciliation-dialog">
      <header className="modal-head"><div><span className="eyebrow">OUTCOME RECONCILIATION</span><h2><ShieldQuestion size={16} /> 确认这次动作是否发生</h2><p>attempt #{attempt.attempt_no} · 线索号 <code>{attempt.probe_ref}</code></p></div><button aria-label="关闭" className="icon-button" onClick={onClose} type="button"><X size={15} /></button></header>
      <div className="modal-body"><p className="verify-guide">在外部资产、回读记录或 Run 线索中确认事实；两个结论同等有效，不会自动重试。</p>
        <div className="outcome-choice">
          <button aria-label="确认未发生，可重新排队" className={`choice-card${resolution === "NOT_HAPPENED" ? " is-active is-negative" : ""}`} onClick={() => setResolution("NOT_HAPPENED")} type="button"><strong>确认未发生，可重新排队</strong><p>保留本次失败记录，任务回到已批准，之后仍需人工确认发布。</p></button>
          <button aria-label="确认已发生，进入核验" className={`choice-card${resolution === "HAPPENED" ? " is-active" : ""}`} onClick={() => setResolution("HAPPENED")} type="button"><strong>确认已发生，进入核验</strong><p>动作已经落地，进入外部核验；可补充发布引用。</p></button>
        </div>
        {resolution === "HAPPENED" ? <label>发布引用（可选）<input onChange={(event) => setPublishedRef(event.target.value)} placeholder="https://…" value={publishedRef} /></label> : null}
        <label>查证依据（必填）<textarea onChange={(event) => setNote(event.target.value)} placeholder="例：GBP 后台未见对应帖子" rows={3} value={note} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="modal-foot"><span className="quiet-copy">提交后由服务端按当前版本确认结论。</span><div><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" disabled={!canSubmit} onClick={() => void submit()} type="button">{busy ? "提交中…" : "提交查证结论"}</button></div></footer>
    </div>
  </div>;
}
