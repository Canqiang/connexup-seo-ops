import { Check, CircleDashed, ShieldCheck } from "lucide-react";
import type { SeoTask } from "../../api/types";

export function EvidenceRail({ task }: { task: SeoTask }) {
  const verified = new Set(task.evidence_refs.filter((item) => item.task_revision === task.task_revision && item.verification_status === "VERIFIED").map((item) => item.requirement_key));
  return <div className="evidence-spine" aria-label="当前版本证据链">
    {task.required_evidence_types.map((requirement) => {
      const evidence = task.evidence_refs.find((item) => item.task_revision === task.task_revision && item.requirement_key === requirement);
      const done = verified.has(requirement);
      return <div className={done ? "is-verified" : ""} key={requirement}>
        <span className="spine-node">{done ? <Check size={12} /> : <CircleDashed size={12} />}</span>
        <span><strong>{requirement}</strong><small>{evidence ? `${evidence.verification_status} · ${new Date(evidence.captured_at).toLocaleString("zh-CN")}` : "等待证据"}</small></span>
        {evidence?.sha256 ? <code>{evidence.sha256.slice(0, 10)}</code> : null}
      </div>;
    })}
    <div className={task.status === "APPROVED" ? "is-verified" : ""}><span className="spine-node"><ShieldCheck size={12} /></span><span><strong>人工审批</strong><small>{task.status === "APPROVED" ? "已授权；不等于已执行" : "等待满足审批条件"}</small></span></div>
  </div>;
}
