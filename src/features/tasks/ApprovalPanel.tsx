import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoTask } from "../../api/types";

export function ApprovalPanel({
  task,
  canApprove,
  onReadback,
  compact = false,
  primaryLabel = "批准并进入发布",
  approvalBlockedReason,
}: {
  task: SeoTask;
  canApprove: boolean;
  onReadback: (task: SeoTask) => void;
  compact?: boolean;
  primaryLabel?: string;
  approvalBlockedReason?: string;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    if (approvalBlockedReason) return setMessage(approvalBlockedReason);
    setBusy(true);
    setMessage("");
    try {
      const preview = await seoOpsApi.approvalPreview(task.id, {
        task_revision: task.task_revision,
        expected_state_version: task.state_version,
      });
      if (!preview.reviewable || preview.blockers.length > 0) {
        setMessage(preview.blockers[0] ?? "当前版本还不能发布，请返回修改。");
        return;
      }
      await seoOpsApi.approvalDecision(task.id, {
        decision: "APPROVE",
        task_revision: preview.task_revision,
        execution_spec_hash: preview.execution_spec_hash,
        expected_state_version: preview.state_version,
        idempotency_key: crypto.randomUUID(),
      });
      const readback = await seoOpsApi.task(task.id);
      onReadback(readback);
      setMessage("已批准，正在进入发布队列。");
    } catch (error) {
      setMessage(error instanceof ApiError && error.status === 409
        ? "任务刚刚有更新，请刷新后再批准。"
        : "批准未保存，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const controls = <>
    {task.status === "READY_FOR_APPROVAL" && canApprove && !approvalBlockedReason
      ? <button className="primary-button" disabled={busy} onClick={() => void approve()} type="button">{busy ? "正在批准…" : primaryLabel}</button>
      : null}
    {task.status === "READY_FOR_APPROVAL" && !canApprove
      ? <p className="boundary-note">当前账号只能查看，不能批准。</p>
      : null}
    {approvalBlockedReason ? <p className="boundary-note">{approvalBlockedReason}</p> : null}
    {task.status === "APPROVED" ? <p className="boundary-note is-approved">已批准，等待发布。</p> : null}
    <p className="form-message" role="status">{message}</p>
  </>;

  if (compact) return <div className="approval-panel is-compact">{controls}</div>;
  return <section className="approval-panel approval-panel-simple">
    <header><span><ShieldCheck size={16} /> 发布确认</span></header>
    <div className="approval-simple-body">{controls}</div>
  </section>;
}
