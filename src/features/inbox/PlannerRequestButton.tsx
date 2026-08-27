import { useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { MerchantSummary } from "../../api/types";

/** 手动请求 Planner：只创建一个只读 PLANNER 任务；建议出来后仍要人判定。 */
export function PlannerRequestButton({ merchantId, merchants, onDone }: { merchantId?: string; merchants?: MerchantSummary[]; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(merchantId ?? merchants?.[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const submit = async () => {
    const id = merchantId ?? target;
    if (!id || !reason.trim()) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await seoOpsApi.requestPlanner(id, { reason: reason.trim(), idempotency_key: crypto.randomUUID() });
      setMessage(result.replayed ? "同一请求已存在，未重复创建。" : `已生成 Planner 任务（${result.task_id.slice(0, 8)}…）；建议出来后在此判定。`);
      setReason(""); onDone?.();
    } catch (cause) {
      setMessage(cause instanceof ApiError && cause.code === "PLANNER_NOT_BOUND" ? "Planner 未绑定：先在「设置 · Agent 绑定」绑定 PLANNER。" : cause instanceof Error ? cause.message : "请求失败");
    } finally { setBusy(false); }
  };
  return <div className="planner-request">
    <button className="secondary-button" onClick={() => setOpen((v) => !v)} type="button">手动请求 Planner</button>
    {open ? <div className="planner-request-form">
      {!merchantId && merchants ? <label>商户<select onChange={(e) => setTarget(e.target.value)} value={target}>{merchants.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></label> : null}
      <label>请求原因<input onChange={(e) => setReason(e.target.value)} placeholder="例：复盘后刷新任务图" value={reason} /></label>
      <button className="primary-button" disabled={busy || !reason.trim() || !(merchantId ?? target)} onClick={() => void submit()} type="button">{busy ? "发送中…" : "发送请求"}</button>
    </div> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </div>;
}
