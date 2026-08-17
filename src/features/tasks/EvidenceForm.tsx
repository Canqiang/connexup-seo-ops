import { useState, type FormEvent } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoTask } from "../../api/types";

export function EvidenceForm({ task, onReadback }: { task: SeoTask; onReadback: (task: SeoTask) => void }) {
  const [sourceKind, setSourceKind] = useState<"artifact_id" | "file_id" | "source_ref">("source_ref");
  const [source, setSource] = useState("");
  const [type, setType] = useState(task.required_evidence_types[0] ?? "ACTION_EVENT");
  const [sha256, setSha256] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setStatus("");
    if (!source.trim()) return setStatus("必须填写且只能填写一个证据来源。");
    if (sourceKind !== "source_ref" && !/^[0-9a-f]{64}$/i.test(sha256)) return setStatus("文件或 Artifact 必须提供 64 位 SHA-256。 ");
    if (!capturedAt) return setStatus("必须填写证据采集时间。");
    setBusy(true);
    try {
      await seoOpsApi.appendEvidence(task.id, {
        type, requirement_key: type, [sourceKind]: source.trim(), sha256: sourceKind === "source_ref" ? undefined : sha256,
        captured_at: new Date(capturedAt).toISOString(), verification_status: "VERIFIED",
        expected_state_version: task.state_version, idempotency_key: crypto.randomUUID()
      });
      const readback = await seoOpsApi.task(task.id);
      onReadback(readback); setStatus(`证据已回读，state ${readback.state_version}`);
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 409 ? "任务已变化：已要求刷新后复核，表单内容仍保留。" : "证据保存失败，请检查来源与权限。");
    } finally { setBusy(false); }
  };
  return <form className="command-form" onSubmit={submit}><div className="form-grid">
    <label>证据要求<select value={type} onChange={(event) => setType(event.target.value)}>{task.required_evidence_types.map((item) => <option key={item}>{item}</option>)}<option>ACTION_EVENT</option><option>BASELINE_MEASUREMENT</option><option>POST_MEASUREMENT</option><option>CAUSAL_DESIGN</option></select></label>
    <label>来源类型<select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)}><option value="source_ref">来源链接</option><option value="artifact_id">Artifact ID</option><option value="file_id">File ID</option></select></label>
    <label className="span-two">来源<input required value={source} onChange={(event) => setSource(event.target.value)} /></label>
    {sourceKind !== "source_ref" ? <label className="span-two">SHA-256<input required value={sha256} onChange={(event) => setSha256(event.target.value)} /></label> : null}
    <label>采集时间<input required type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} /></label>
  </div><div className="form-actions"><span role="status">{status}</span><button className="primary-button" disabled={busy} type="submit">{busy ? "保存并回读…" : "附加证据"}</button></div></form>;
}
