import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { ApprovalAction, ApprovalPreview, SeoTask } from "../../api/types";

export function ApprovalPanel({ task, canApprove, onReadback }: { task: SeoTask; canApprove: boolean; onReadback: (task: SeoTask) => void }) {
  const [preview, setPreview] = useState<ApprovalPreview>();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true); setMessage("");
    try { setPreview(await seoOpsApi.approvalPreview(task.id, { task_revision: task.task_revision, expected_state_version: task.state_version })); }
    catch { setMessage("审批预览生成失败，请刷新任务。"); }
    finally { setBusy(false); }
  };
  const decide = async (action: ApprovalAction) => {
    if (!preview) return;
    if ((action === "REJECT" || action === "REVOKE") && !reason.trim()) return setMessage("拒绝或撤销必须填写原因。");
    setBusy(true); setMessage("");
    try {
      await seoOpsApi.approvalDecision(task.id, {
        decision: action, reason: reason.trim() || undefined, task_revision: preview.task_revision,
        execution_spec_hash: preview.execution_spec_hash, expected_state_version: preview.state_version,
        idempotency_key: crypto.randomUUID()
      });
      const readback = await seoOpsApi.task(task.id);
      onReadback(readback); setPreview(undefined); setMessage(`决定已回读：${readback.status} · state ${readback.state_version}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { setPreview(undefined); setMessage("任务在审批期间发生变化。请重新生成预览并复核。"); }
      else setMessage("审批决定未保存。");
    } finally { setBusy(false); }
  };
  return <section className="approval-panel"><header><span><ShieldCheck size={16} /> 审批控制</span><small>批准只记录授权，不触发执行</small></header>
    {!canApprove ? <p className="boundary-note">当前账号只能查看审批历史。</p> : null}
    {canApprove && !preview ? <button className="secondary-button" disabled={busy} onClick={generate} type="button">生成审批预览</button> : null}
    {preview ? <div className="approval-preview"><dl><div><dt>版本</dt><dd>rev {preview.task_revision} / state {preview.state_version}</dd></div><div><dt>证据</dt><dd>{preview.evidence_state}</dd></div><div><dt>执行哈希</dt><dd><code>{preview.execution_spec_hash}</code></dd></div><div><dt>影响范围</dt><dd>{task.impact}</dd></div></dl>
      {preview.blockers.length ? <ul className="blocker-list">{preview.blockers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      <label>拒绝 / 撤销原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="button-row"><button className="primary-button" disabled={busy || !preview.reviewable} onClick={() => decide("APPROVE")} type="button">批准</button><button className="secondary-button" disabled={busy} onClick={() => decide("REJECT")} type="button">退回修订</button>{task.status === "APPROVED" ? <button className="danger-button" disabled={busy} onClick={() => decide("REVOKE")} type="button">撤销批准</button> : null}</div>
    </div> : null}<p className="form-message" role="status">{message}</p>{task.status === "APPROVED" ? <p className="boundary-note is-approved">已批准 — 执行调度不在 MVP 内。</p> : null}
  </section>;
}
