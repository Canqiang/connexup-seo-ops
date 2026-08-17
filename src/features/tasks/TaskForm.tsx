import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { MerchantSummary, TaskImpact, TaskPriority } from "../../api/types";

export function TaskForm({ merchant, merchants, onClose }: { merchant?: MerchantSummary; merchants: MerchantSummary[]; onClose: () => void }) {
  const navigate = useNavigate();
  const [merchantId, setMerchantId] = useState(merchant?.id ?? merchants[0]?.id ?? "");
  const [locationId, setLocationId] = useState("");
  const [title, setTitle] = useState("");
  const [taskType, setTaskType] = useState("TECHNICAL_SEO");
  const [source, setSource] = useState("OPERATOR");
  const [priority, setPriority] = useState<TaskPriority>("MEDIUM");
  const [impact, setImpact] = useState<TaskImpact>("MEDIUM");
  const [ownerId, setOwnerId] = useState("");
  const [executionSpec, setExecutionSpec] = useState("{\n  \"operation\": \"\"\n}");
  const [requirements, setRequirements] = useState("BEFORE_SCREENSHOT, AFTER_SCREENSHOT");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = merchants.find((item) => item.id === merchantId);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setStatus("");
    try {
      const created = await seoOpsApi.createTask({
        merchant_id: merchantId, location_id: locationId || undefined, idempotency_key: crypto.randomUUID(),
        definition: { title, task_type: taskType, source, priority, impact, owner_id: ownerId || undefined,
          execution_spec: executionSpec, required_evidence_types: requirements.split(",").map((item) => item.trim()).filter(Boolean) }
      });
      const readback = await seoOpsApi.task(created.id);
      navigate(`/tasks/${readback.id}`); onClose();
    } catch { setStatus("任务创建失败。请检查执行规范 JSON、权限和必填项。"); }
    finally { setBusy(false); }
  };
  return <div className="drawer-layer"><button aria-label="关闭新建任务" className="drawer-backdrop" onClick={onClose} type="button" /><aside className="task-drawer" role="dialog" aria-modal="true" aria-label="新建执行任务"><header className="drawer-header"><div><span className="eyebrow">NEW EXECUTION TASK</span><h2>创建可审计任务</h2></div><button aria-label="关闭" className="icon-button" onClick={onClose} type="button"><X size={18} /></button></header>
    <form className="command-form drawer-form" onSubmit={submit}><div className="form-grid">
      <label>商户<select required value={merchantId} onChange={(event) => { setMerchantId(event.target.value); setLocationId(""); setOwnerId(""); }}>{merchants.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
      <label>地点（可选）<select value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">商户级任务</option>{selected?.locations.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
      <label className="span-two">任务标题<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>任务类型<input required value={taskType} onChange={(event) => setTaskType(event.target.value)} /></label><label>来源<input required value={source} onChange={(event) => setSource(event.target.value)} /></label>
      <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>URGENT</option></select></label>
      <label>影响<select value={impact} onChange={(event) => setImpact(event.target.value as TaskImpact)}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></label>
      <label>负责人（可选）<select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">未分配</option>{selected?.operators.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="span-two">执行规范 JSON<textarea required rows={7} value={executionSpec} onChange={(event) => setExecutionSpec(event.target.value)} /></label>
      <label className="span-two">证据要求（逗号分隔）<input required value={requirements} onChange={(event) => setRequirements(event.target.value)} /></label>
    </div><div className="form-actions"><span role="alert">{status}</span><button className="primary-button" disabled={busy} type="submit">{busy ? "创建并回读…" : "创建任务"}</button></div></form>
  </aside></div>;
}
