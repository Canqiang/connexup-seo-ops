import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { ProposalWire, TaskPriority } from "../../api/types";

/** 编辑后采纳：AM 只能改优先级/时限（服务端 override_*），不能改任务定义本身。 */
export function AdoptDialog({ proposal, onClose, onDone }: { proposal: ProposalWire; onClose: () => void; onDone: (taskId: string | null) => void }) {
  const [priority, setPriority] = useState<TaskPriority>(proposal.priority);
  const [dueAt, setDueAt] = useState(proposal.due_at ? proposal.due_at.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await seoOpsApi.decideProposal(proposal.id, {
        action: "ADOPT",
        ...(priority !== proposal.priority ? { override_priority: priority } : {}),
        ...(dueAt && dueAt !== (proposal.due_at ?? "").slice(0, 10) ? { override_due_at: new Date(`${dueAt}T00:00:00Z`).toISOString() } : {}),
      });
      onDone(result.task_id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "采纳失败"); }
    finally { setBusy(false); }
  };
  return <div aria-label="编辑后采纳" aria-modal="true" className="modal-backdrop" role="dialog"><div className="modal-card slim">
    <header className="modal-head"><div><span className="eyebrow">ADOPT WITH EDITS</span><h2>#{proposal.seq} {proposal.title}</h2></div></header>
    <div className="modal-body">
      <label>优先级<select aria-label="优先级" onChange={(e) => setPriority(e.target.value as TaskPriority)} value={priority}><option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option><option value="URGENT">URGENT</option></select></label>
      <label>到期日<input aria-label="到期日" onChange={(e) => setDueAt(e.target.value)} type="date" value={dueAt} /></label>
      <p className="quiet-copy">采纳 = 写入 seo_tasks（rev 1）并进入门 1 审批链；判定记录写入不可变审计时间线。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
    <footer className="modal-foot"><span /><div><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" disabled={busy} onClick={() => void submit()} type="button">{busy ? "提交中…" : "采纳并创建 Task"}</button></div></footer>
  </div></div>;
}
