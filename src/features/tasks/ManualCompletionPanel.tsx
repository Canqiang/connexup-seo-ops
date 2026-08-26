import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoTask } from "../../api/types";

export function ManualCompletionPanel({ task, onReadback }: { task: SeoTask; onReadback: (task: SeoTask) => void }) {
  const [sourceRef, setSourceRef] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!sourceRef.trim()) return;
    setBusy(true); setError(undefined);
    try { onReadback(await seoOpsApi.completeManualTask(task.id, { source_ref: sourceRef.trim(), ...(note.trim() ? { note: note.trim() } : {}), expected_state_version: task.state_version, idempotency_key: crypto.randomUUID() })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "人工完成记录失败"); }
    finally { setBusy(false); }
  };
  return <div className="execution-panel is-compact"><label>完成证据链接<input aria-label="完成证据链接" onChange={(event) => setSourceRef(event.target.value)} placeholder="https://… 或可审计引用" value={sourceRef} /></label><label>完成说明（可选）<input onChange={(event) => setNote(event.target.value)} value={note} /></label><button className="primary-button" disabled={busy || !sourceRef.trim()} onClick={() => void submit()} type="button">{busy ? "保存中…" : "记录人工完成"}</button>{error ? <p className="form-error" role="alert">{error}</p> : null}</div>;
}
