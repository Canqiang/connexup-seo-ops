import type { SeoTask } from "../../api/types";

type StepState = "done" | "current" | "pending";

export function GbpWorkflowRail({ task, hasDraft, directPublish = false }: { task: SeoTask; hasDraft: boolean; directPublish?: boolean }) {
  const finalized = task.evidence_refs.some((item) =>
    item.requirement_key === "CONTENT_DRAFT"
    && item.task_revision === task.task_revision
    && item.verification_status === "VERIFIED",
  );
  const approved = ["APPROVED", "EXECUTION_CONFIRMED", "DISPATCHING", "OUTCOME_UNKNOWN", "PENDING_VERIFY", "VERIFIED", "DONE"].includes(task.status);
  const published = ["PENDING_VERIFY", "VERIFIED", "DONE"].includes(task.status);
  const verified = ["VERIFIED", "DONE"].includes(task.status);
  const publishing = ["APPROVED", "EXECUTION_CONFIRMED", "DISPATCHING", "OUTCOME_UNKNOWN"].includes(task.status);
  const steps: Array<{ label: string; note: string; state: StepState }> = [
    { label: "生成图文", note: hasDraft ? "Core AI 草稿已保存" : "等待生成英文文案与图片", state: hasDraft ? "done" : "current" },
    { label: "修改与定稿", note: finalized ? "文案与最终图片已锁定" : "可改文案或上传商户菜品实拍", state: finalized ? "done" : hasDraft ? "current" : "pending" },
    { label: "人工批准", note: approved ? "当前版本已批准（仅授权）" : "批准后才进入发布确认", state: approved ? "done" : finalized ? "current" : "pending" },
    { label: "发布", note: published ? "已发布（provider 回执）" : task.status === "OUTCOME_UNKNOWN" ? "结果不确定 · 等人工查证" : publishing ? "门 2 确认后派发，等待回执" : "等待人工批准与发布时间", state: published ? "done" : publishing ? "current" : "pending" },
    { label: "生效核对", note: verified ? "公开可见已核验" : "发布 ≠ 已验证：到前台确认可见后归档", state: verified ? "done" : published ? "current" : "pending" },
  ];
  return <section className="gbp-workflow-rail"><div><span className="eyebrow">GBP PUBLISHING / 发布闭环</span><strong>GBP Post 发布流程</strong>{directPublish ? <span className="status-pill is-stable">GBP 已授权 · 可直接发布</span> : null}</div><ol aria-label="GBP Post 发布流程">
    {steps.map((step, index) => <li data-state={step.state} key={step.label}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{step.note}</small></div></li>)}
  </ol></section>;
}
