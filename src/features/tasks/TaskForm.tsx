import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { ExecutionMode, MerchantSummary, TaskImpact, TaskPriority } from "../../api/types";

const DEFAULT_EXECUTION_SPEC = "{\n  \"operation\": \"\"\n}";
const DEFAULT_EVIDENCE_REQUIREMENTS = "BEFORE_SCREENSHOT, AFTER_SCREENSHOT";

function gbpPostExecutionSpec(): string {
  return JSON.stringify({
    occurrence_at: new Date().toISOString(),
    post_type: "STANDARD",
    primary_keyword_cluster: {
      cluster_id: "operator-local-discovery",
      search_intent: "local restaurant discovery",
      keywords: ["restaurant near me"],
    },
    evidence_references: ["operator:manual-task-form"],
  }, null, 2);
}

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
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("MANUAL");
  const [executionSpec, setExecutionSpec] = useState(DEFAULT_EXECUTION_SPEC);
  const [requirements, setRequirements] = useState(DEFAULT_EVIDENCE_REQUIREMENTS);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = merchants.find((item) => item.id === merchantId);
  const isGbpPost = taskType === "GBP_POST";
  const applyGbpPostDefaults = () => {
    setExecutionMode("AUTO_WRITE");
    setExecutionSpec(gbpPostExecutionSpec());
    setRequirements("CONTENT_DRAFT");
  };
  const changeTaskType = (value: string) => {
    setTaskType(value);
    if (value === "GBP_POST") {
      applyGbpPostDefaults();
    } else if (taskType === "GBP_POST") {
      setExecutionMode("MANUAL");
      setExecutionSpec(DEFAULT_EXECUTION_SPEC);
      setRequirements(DEFAULT_EVIDENCE_REQUIREMENTS);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isGbpPost && !locationId) {
      setStatus("GBP Post 必须选择一个具体地点，才能生成对应门店的草稿。");
      return;
    }
    setBusy(true); setStatus("");
    try {
      const created = await seoOpsApi.createTask({
        merchant_id: merchantId, location_id: locationId || undefined, idempotency_key: crypto.randomUUID(),
        definition: { title, task_type: taskType, source, priority, impact, owner_id: ownerId || undefined,
          execution_mode: executionMode, execution_spec: executionSpec,
          required_evidence_types: requirements.split(",").map((item) => item.trim()).filter(Boolean) }
      });
      const readback = await seoOpsApi.task(created.id);
      navigate(`/tasks/${readback.id}`); onClose();
    } catch { setStatus("任务创建失败。请检查执行规范 JSON、权限和必填项。"); }
    finally { setBusy(false); }
  };
  return <div className="drawer-layer"><button aria-label="关闭新建任务" className="drawer-backdrop" onClick={onClose} type="button" /><aside className="task-drawer" role="dialog" aria-modal="true" aria-label="新建执行任务"><header className="drawer-header"><div><span className="eyebrow">NEW EXECUTION TASK</span><h2>创建可审计任务</h2></div><button aria-label="关闭" className="icon-button" onClick={onClose} type="button"><X size={18} /></button></header>
    <form className="command-form drawer-form" onSubmit={submit}><div className="form-grid">
      <label>商户<select required value={merchantId} onChange={(event) => { setMerchantId(event.target.value); setLocationId(""); setOwnerId(""); }}>{merchants.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
      <label>{isGbpPost ? "地点（GBP Post 必选）" : "地点（可选）"}<select required={isGbpPost} value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">{isGbpPost ? "请选择具体地点" : "商户级任务"}</option>{selected?.locations.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
      <label className="span-two">任务标题<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>任务类型<input required value={taskType} onChange={(event) => changeTaskType(event.target.value)} /></label><label>来源<input required value={source} onChange={(event) => setSource(event.target.value)} /></label>
      <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>URGENT</option></select></label>
      <label>影响<select value={impact} onChange={(event) => setImpact(event.target.value as TaskImpact)}><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></label>
      <label>执行模式<select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as ExecutionMode)}><option value="MANUAL">MANUAL · 人工执行</option><option value="AUTO_WRITE">AUTO_WRITE · 双门写入</option><option value="ARTIFACT">ARTIFACT · 成品交付</option><option value="READ_ONLY">READ_ONLY · 只读采集</option></select></label>
      <label>负责人（可选）<select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">未分配</option>{selected?.operators.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {isGbpPost ? <div className="span-two boundary-note"><span>先生成图文草稿；草稿确认后再进入审批与发布流程，不会在创建时立即发布。</span><button className="text-button" onClick={applyGbpPostDefaults} type="button">重新套用 GBP 草稿模板</button></div> : null}
      <label className="span-two">执行规范 JSON<textarea required rows={7} value={executionSpec} onChange={(event) => setExecutionSpec(event.target.value)} /></label>
      <label className="span-two">证据要求（逗号分隔）<input required value={requirements} onChange={(event) => setRequirements(event.target.value)} /></label>
    </div><div className="form-actions"><span role="alert">{status}</span><button className="primary-button" disabled={busy} type="submit">{busy ? "创建并回读…" : "创建任务"}</button></div></form>
  </aside></div>;
}
