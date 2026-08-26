import { useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoTask } from "../../api/types";

export function TaskRevisionForm({ task, onReadback, onClose }: { task: SeoTask; onReadback: (task: SeoTask) => void; onClose: () => void }) {
  const [title, setTitle] = useState(task.title);
  const [spec, setSpec] = useState(task.execution_spec);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      await seoOpsApi.createRevision(task.id, { expected_state_version: task.state_version, idempotency_key: crypto.randomUUID(), definition: {
        title, task_type: task.task_type, source: task.source, priority: task.priority, impact: task.impact,
        owner_id: task.owner_id, due_at: task.due_at, execution_spec: spec, required_evidence_types: task.required_evidence_types,
        // 修订必须带上原执行模式：漏掉会被服务端默认成 MANUAL，写入类任务悄悄降级
        execution_mode: task.execution_mode,
      }});
      onReadback(await seoOpsApi.task(task.id)); onClose();
    } catch (error) { setMessage(error instanceof ApiError && error.status === 409 ? "任务已变化。请刷新并重新比较版本。" : "修订保存失败。"); }
    finally { setBusy(false); }
  };
  return <form className="command-form revision-form" onSubmit={submit}><p className="hash-line">基于 rev {task.task_revision} · <code>{task.execution_spec_hash}</code></p><label>标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>执行规范<textarea rows={8} value={spec} onChange={(event) => setSpec(event.target.value)} /></label><div className="form-actions"><span role="alert">{message}</span><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" disabled={busy} type="submit">{busy ? "保存中…" : "保存新版本"}</button></div></form>;
}
