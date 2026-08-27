import { useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { CycleLedgerView, LifecycleView } from "../../api/types";
import { BackButton } from "../../app/BackButton";
import type { ViewMode } from "../../app/viewMode";
import { useAuth } from "../../auth/AuthContext";
import { hasPermission } from "../../auth/permissions";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { CurrentActionCard, type MerchantNextAction } from "./CurrentActionCard";
import { CycleLedger } from "./CycleLedger";
import { MerchantAuditTools } from "./MerchantAuditTools";
import { lifecycleActionCopy, STAGE_LABELS } from "./lifecycleCopy";
import { PostProgramPanel } from "./PostProgramPanel";
import { RankingSnapshotPanel } from "./RankingSnapshotPanel";
import { ReportsDataPanel } from "./ReportsDataPanel";
import { ReviewSignalPanel } from "./ReviewSignalPanel";

type CurrentQuestionnaire = NonNullable<LifecycleView["questionnaire"]>;

/** 商户页是一个活跃周期的运营账本。生命周期只解释进度；动作、任务和建议均来自持久化投影。 */
export function MerchantWorkspacePage() {
  const workspace = useWorkspace();
  const { user } = useAuth();
  const { mode } = useOutletContext<{ mode: ViewMode }>();
  const merchantId = workspace.merchantId ?? useParams<{ merchantId: string }>().merchantId ?? "";
  const merchant = workspace.merchant;
  const lifecycle = useResource((signal) => seoOpsApi.lifecycle(merchantId, signal), [merchantId]);
  const ledger = useResource((signal) => seoOpsApi.cycleLedger(merchantId, signal), [merchantId]);
  const reports = useResource((signal) => seoOpsApi.reports({ merchant_id: merchantId, limit: 8 }, signal), [merchantId]);
  const artifacts = useResource((signal) => seoOpsApi.merchantArtifacts(merchantId, undefined, signal), [merchantId]);
  const postProgram = useResource((signal) => seoOpsApi.postProgram(merchantId, signal), [merchantId]);
  const ranking = useResource((signal) => seoOpsApi.ranking(merchantId, signal), [merchantId]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [plannerBusy, setPlannerBusy] = useState(false);
  const [plannerMessage, setPlannerMessage] = useState("");
  usePageTitle(merchant?.display_name ?? "商户");

  const canManage = hasPermission(user?.permissions, "seoops.manage");
  const requestPlanner = async () => {
    setPlannerBusy(true); setPlannerMessage("");
    try {
      const result = await seoOpsApi.requestPlanner(merchantId, { reason: "商户页人工请求刷新任务图", idempotency_key: crypto.randomUUID() });
      setPlannerMessage(result.replayed ? "同一请求已存在。" : "已生成 Planner 任务；建议出来后到「任务 · 待判定」判定。");
      ledger.reload();
    } catch (cause) { setPlannerMessage(cause instanceof ApiError && cause.code === "PLANNER_NOT_BOUND" ? "Planner 未绑定：请先在设置页绑定 PLANNER。" : "请求失败，请稍后重试。"); }
    finally { setPlannerBusy(false); }
  };
  const runQuestionnaireAction = async (questionnaire: CurrentQuestionnaire | null) => {
    setBusy(true);
    setActionError("");
    try {
      if (questionnaire) await seoOpsApi.sendQuestionnaire(questionnaire.id);
      else await seoOpsApi.createQuestionnaire(merchantId, { idempotency_key: `merchant-questionnaire-${crypto.randomUUID()}` });
      lifecycle.reload();
    } catch (error) {
      setActionError(error instanceof Error ? `问卷登记失败：${error.message}` : "问卷登记失败，稍后重试。");
    } finally { setBusy(false); }
  };
  const nextAction = lifecycle.data && deriveNextAction({ lifecycle: lifecycle.data, ledger: ledger.data, ledgerError: ledger.error, ledgerLoading: ledger.loading, merchantId, canManage, busy, onQuestionnaire: runQuestionnaireAction, onLedgerRetry: ledger.reload });

  if (workspace.loading) return <div className="page-state" role="status">正在读取商户…</div>;
  if (!merchant) return <div className="page-state is-error" role="alert">商户不存在或当前用户不可见。</div>;
  return <>
    <header className="page-heading"><div><BackButton fallback="/merchants" label="返回商户列表" /><span className="eyebrow">MERCHANT CONTROL ROOM · {merchant.slug}</span><h1>{merchant.display_name}</h1><span className="status-pill">{lifecycle.data ? lifecycle.data.ranking_round_count > 0 ? `第 ${lifecycle.data.ranking_round_count} 轮` : "首轮接入" : "—"}</span><p>{merchant.locations.map((location) => location.display_name).join("、") || "未建地点"} · 活跃周期账本</p></div><div className="heading-actions">{canManage ? <button className="secondary-button" disabled={plannerBusy} onClick={() => void requestPlanner()} type="button">{plannerBusy ? "请求中…" : "请求 Planner 刷新任务图"}</button> : null}<span className={`status-pill is-${merchant.health.toLowerCase()}`}>{merchant.health}</span></div></header>
    {plannerMessage ? <p className="form-message" role="status">{plannerMessage}</p> : null}
    {lifecycle.error ? <div className="page-state is-error" role="alert">生命周期读取失败。<button onClick={lifecycle.reload}>重试</button></div> : null}
    {lifecycle.loading && !lifecycle.data ? <div className="page-state" role="status">读取活跃周期…</div> : null}
    {lifecycle.data ? <LifecycleRail data={lifecycle.data} /> : null}
    {nextAction ? <CurrentActionCard action={nextAction} error={actionError} /> : null}
    {mode === "audit" && lifecycle.data ? <MerchantAuditTools canManage={canManage} lifecycle={lifecycle.data} merchantId={merchantId} locations={merchant.locations} onChanged={lifecycle.reload} /> : null}
    <CycleLedger data={ledger.data ?? null} error={ledger.error} loading={ledger.loading} merchantId={merchantId} onRetry={ledger.reload} />
    <div className="merchant-control-grid"><ReportsDataPanel artifacts={artifacts.data?.items ?? []} error={reports.error ?? artifacts.error} loading={reports.loading || artifacts.loading} onRetry={() => { reports.reload(); artifacts.reload(); }} questionnaire={lifecycle.data ? lifecycle.data.questionnaire : undefined} reports={reports.data?.items ?? []} /><PostProgramPanel data={postProgram.data ?? null} error={postProgram.error} loading={postProgram.loading} merchantId={merchantId} onRetry={postProgram.reload} /><RankingSnapshotPanel data={ranking.data} error={ranking.error} loading={ranking.loading} onRetry={ranking.reload} /><ReviewSignalPanel artifacts={artifacts.data?.items ?? []} error={artifacts.error} loading={artifacts.loading} merchantId={merchantId} /></div>
  </>;
}

function LifecycleRail({ data }: { data: LifecycleView }) {
  return <section aria-label="生命周期阶段（说明）" className="lifecycle-rail lifecycle-rail-explainer">{data.stages.map((stage) => <div className={`r-step is-${stage.status === "CURRENT" ? "now" : stage.status === "DONE" ? "done" : "off"}`} key={stage.key}><strong>{STAGE_LABELS[stage.key]}</strong><small>{stage.note}</small></div>)}</section>;
}

function deriveNextAction({ lifecycle, ledger, ledgerError, ledgerLoading, merchantId, canManage, busy, onQuestionnaire, onLedgerRetry }: { lifecycle: LifecycleView; ledger?: CycleLedgerView; ledgerError?: unknown; ledgerLoading: boolean; merchantId: string; canManage: boolean; busy: boolean; onQuestionnaire: (questionnaire: CurrentQuestionnaire | null) => Promise<void>; onLedgerRetry: () => void }): MerchantNextAction {
  if (ledgerError) return { title: "本周期动作待确认", consequence: "周期账本读取失败，不能依据生命周期推断任务动作。", actionLabel: "重试账本", action: { label: "重试账本", onClick: onLedgerRetry } };
  if (ledgerLoading || !ledger) return { title: "正在确认本周期账本", consequence: "账本尚未返回；不依据生命周期推断任务、建议或执行状态。", actionLabel: "等待账本", action: { label: "等待账本", disabled: true } };
  const items = ledger?.items ?? [];
  const hrefForTasks = "/inbox?merchant_id=" + encodeURIComponent(merchantId);
  if (items.some((item) => item.record_kind === "PROPOSAL" && item.status === "PENDING")) return { title: "判定本周期建议", consequence: "建议待判定，未判定前不能作为已授权任务执行。", actionLabel: "去判定", action: { label: "去判定", href: `${hrefForTasks}&tab=proposals` } };
  if (items.some((item) => item.record_kind === "TASK" && item.status === "READY_FOR_APPROVAL")) return { title: "审批本周期任务", consequence: "任务已具备审批条件；批准仅记录授权，不会直接执行。", actionLabel: "去审批", action: { label: "去审批", href: `${hrefForTasks}&status=READY_FOR_APPROVAL` } };
  if (items.some((item) => item.record_kind === "TASK" && item.status === "APPROVED")) return { title: "确认已批准任务", consequence: "任务已批准，仍需确认门 2 后才可进入执行。", actionLabel: "打开门 2", action: { label: "打开门 2", href: hrefForTasks } };
  if (items.some((item) => item.record_kind === "TASK" && item.status === "OUTCOME_UNKNOWN")) return { title: "查证执行结果", consequence: "执行结果尚未回读，不能作为完成或下一步依据。", actionLabel: "查看任务", action: { label: "查看任务", href: hrefForTasks } };
  if (items.some((item) => item.record_kind === "TASK" && item.status === "PENDING_VERIFY")) return { title: "核验执行证据", consequence: "已有待核验证据，核验结论会影响本周期后续判断。", actionLabel: "查看任务", action: { label: "查看任务", href: hrefForTasks } };
  if (items.length === 0 && ["PLAN", "EXECUTE", "VERIFY"].includes(lifecycle.stage)) return { title: "本周期暂无工作", consequence: "活跃周期没有持久化任务或建议。若需继续，请请求 Planner 生成建议后再判定。", actionLabel: "查看建议队列", action: { label: "查看建议队列", href: `${hrefForTasks}&tab=proposals` } };
  const copy = lifecycleActionCopy(lifecycle);
  if (lifecycle.stage === "QUESTIONNAIRE") {
    const questionnaire = lifecycle.questionnaire;
    return { ...copy, action: { label: questionnaire ? questionnaire.status === "SENT" ? "重发问卷" : "登记发放" : "生成接入问卷", disabled: !canManage || busy, onClick: () => { void onQuestionnaire(questionnaire); } } };
  }
  return { ...copy, action: { label: copy.actionLabel, href: copy.actionPath === "inbox" ? `/inbox?merchant_id=${encodeURIComponent(merchantId)}${copy.proposal ? "&tab=proposals" : ""}` : `/merchants/${encodeURIComponent(merchantId)}?view=audit` } };
}
