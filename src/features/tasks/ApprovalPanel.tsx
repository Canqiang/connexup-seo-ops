import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../app/format";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { ApprovalAction, ApprovalPreview, SeoTask } from "../../api/types";

export function ApprovalPanel({ task, canApprove, onReadback, compact = false, primaryLabel = "生成审批预览" }: { task: SeoTask; canApprove: boolean; onReadback: (task: SeoTask) => void; compact?: boolean; primaryLabel?: string }) {
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
  // 门 1 的动作只在两个状态下有意义：待审批（批准/退回）、已批准（撤销）。
  // 其余状态（执行链上/已归档）只展示审批记录，不再摆一个没用的「生成预览」按钮。
  const actionable = task.status === "READY_FOR_APPROVAL" || task.status === "APPROVED";
  const lastDecision = task.approval_decisions[task.approval_decisions.length - 1];

  const controls = <>
    {lastDecision ? <p className="decision-summary">
      最近决定：<strong>{{ APPROVE: "批准", REJECT: "退回修订", REVOKE: "撤销批准" }[lastDecision.decision] ?? lastDecision.decision}</strong>
      {" "}· {lastDecision.actor_id} · rev {lastDecision.task_revision} · {formatDateTime(lastDecision.decided_at)}
      {lastDecision.reason ? <><br /><span className="quiet-copy">理由：{lastDecision.reason}</span></> : null}
    </p> : null}
    {!actionable ? <p className="boundary-note">{task.status === "DONE" ? "任务已归档，审批链只读。" : "任务已进入执行链，审批链只读；需要改动请先撤销批准或等执行终态。"}</p> : <>
      {!canApprove ? <p className="boundary-note">当前账号只能查看审批历史。</p> : null}
      {canApprove && !preview ? <button className={compact ? "primary-button" : "secondary-button"} disabled={busy} onClick={generate} type="button">{primaryLabel}</button> : null}
      {preview ? <div className="approval-preview"><dl><div><dt>版本</dt><dd>rev {preview.task_revision} / state {preview.state_version}</dd></div><div><dt>证据</dt><dd>{preview.evidence_state}</dd></div><div><dt>执行哈希</dt><dd><code>{preview.execution_spec_hash}</code></dd></div><div><dt>影响范围</dt><dd>{task.impact}</dd></div></dl>
        {preview.blockers.length ? <ul className="blocker-list">{preview.blockers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        <label>拒绝 / 撤销原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <div className="button-row">{task.status === "READY_FOR_APPROVAL" ? <><button className="primary-button" disabled={busy || !preview.reviewable} onClick={() => decide("APPROVE")} type="button">{primaryLabel}</button><button className="secondary-button" disabled={busy} onClick={() => decide("REJECT")} type="button">退回修订</button></> : null}{task.status === "APPROVED" ? <button className="danger-button" disabled={busy} onClick={() => decide("REVOKE")} type="button">撤销批准</button> : null}</div>
      </div> : null}
    </>}<p className="form-message" role="status">{message}</p>
    {task.status === "APPROVED" ? <p className="boundary-note is-approved">{task.execution_mode === "READ_ONLY" ? "已批准 — Ⓐ级只读任务由调度器自动派发。" : task.execution_mode === "MANUAL" ? "已批准 — 人工完成后记录完成证据，不进入门 2。" : "已批准 — 等待门 2 执行确认（见执行面板）。"}</p> : null}
  </>;
  if (compact) return <div className="approval-panel is-compact">{controls}</div>;
  return <section className="approval-panel"><header><span><ShieldCheck size={16} /> 审批控制（门 1）</span><small>批准只记录授权，不触发执行</small></header>{controls}</section>;
}
