import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { AgentRunStage, LifecycleView, LocationSummary } from "../../api/types";

const labels: Record<AgentRunStage, string> = { KEYWORDS: "运行关键词 Agent", AUDIT: "触发 Audit", RANKING_BASELINE: "运行排名基线 Agent", PLAN: "运行 Plan Agent", REVIEW: "运行复盘 Agent" };

/** 审计视图限定的诊断入口；操作员视图绝不渲染它。 */
export function MerchantAuditTools({ merchantId, lifecycle, locations, canManage, onChanged }: { merchantId: string; lifecycle: LifecycleView; locations: LocationSummary[]; canManage: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const stage = diagnosticStage(lifecycle);
  if (!stage) return null;
  const run = async () => { setBusy(true); setMessage(""); try { await seoOpsApi.triggerStageRun(merchantId, { stage, location_id: locations[0]?.id, idempotency_key: `audit-diagnostic-${stage}-${crypto.randomUUID()}` }); setMessage("已登记诊断运行；请在运行台查看状态与产物。"); onChanged(); } catch (error) { setMessage(error instanceof Error ? `诊断触发失败：${error.message}` : "诊断触发失败。"); } finally { setBusy(false); } };
  return <section aria-label="管理审计工具" className="merchant-audit-tools"><span className="eyebrow">AUDIT MODE · DIAGNOSTICS</span><h2>管理审计工具</h2><p>仅用于诊断与专用 Stage Run；不代表本周期已创建可执行任务。</p>{canManage ? <button className="secondary-button" disabled={busy} onClick={() => { void run(); }} type="button">{busy ? "登记中…" : labels[stage]}</button> : <p className="quiet-copy">当前权限不可运行诊断。</p>}{message ? <p className="form-message" role="status">{message}</p> : null}</section>;
}

function diagnosticStage(lifecycle: LifecycleView): AgentRunStage | null {
  if (lifecycle.stage === "KEYWORDS" || lifecycle.stage === "AUDIT" || lifecycle.stage === "RANKING_BASELINE") return lifecycle.stage;
  if (lifecycle.stage === "PLAN" && !lifecycle.latest_runs.PLAN) return "PLAN";
  return null;
}
