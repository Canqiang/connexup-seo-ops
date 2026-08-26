import type { ReactNode } from "react";
import type { SeoTask } from "../../api/types";

/** 审计信息保持完整，但默认收起，避免把内部账本挤占人的下一步。 */
export function TechnicalDetails({ task, children, open, onToggle }: { task: SeoTask; children: ReactNode; open: boolean; onToggle: (open: boolean) => void }) {
  return <details className="technical-details" onToggle={(event) => onToggle(event.currentTarget.open)} open={open}>
    <summary>技术详情（审计）</summary>
    <div className="technical-details-meta"><span>rev {task.task_revision}</span><span>state {task.state_version}</span><code>{task.execution_spec_hash}</code><span>attempt {task.attempt_count}</span></div>
    <div className="technical-details-body">{children}</div>
  </details>;
}
