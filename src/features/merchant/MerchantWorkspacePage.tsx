import { useMemo, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { LifecycleView } from "../../api/types";
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
import { ReportsDataPanel } from "./ReportsDataPanel";

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
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  usePageTitle(merchant?.display_name ?? "商户");

  const canManage = hasPermission(user?.permissions, "seoops.manage");
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
  const nextAction = useMemo(() => lifecycle.data && deriveNextAction({ lifecycle: lifecycle.data, merchantId, canManage, busy, onQuestionnaire: runQuestionnaireAction }), [lifecycle.data, merchantId, canManage, busy]);

  if (workspace.loading) return <div className="page-state" role="status">正在读取商户…</div>;
  if (!merchant) return <div className="page-state is-error" role="alert">商户不存在或当前用户不可见。</div>;
  return <>
    <header className="page-heading"><div><BackButton fallback="/merchants" label="返回商户列表" /><span className="eyebrow">MERCHANT CONTROL ROOM · {merchant.slug}</span><h1>{merchant.display_name}</h1><p>{merchant.locations.map((location) => location.display_name).join("、") || "未建地点"} · 活跃周期账本</p></div><span className={`status-pill is-${merchant.health.toLowerCase()}`}>{merchant.health}</span></header>
    {lifecycle.error ? <div className="page-state is-error" role="alert">生命周期读取失败。<button onClick={lifecycle.reload}>重试</button></div> : null}
    {lifecycle.loading && !lifecycle.data ? <div className="page-state" role="status">读取活跃周期…</div> : null}
    {lifecycle.data ? <LifecycleRail data={lifecycle.data} /> : null}
    {nextAction ? <CurrentActionCard action={nextAction} error={actionError} /> : null}
    {mode === "audit" && lifecycle.data ? <MerchantAuditTools canManage={canManage} lifecycle={lifecycle.data} merchantId={merchantId} locations={merchant.locations} onChanged={lifecycle.reload} /> : null}
    <CycleLedger data={ledger.data ?? null} loading={ledger.loading} merchantId={merchantId} />
    <div className="merchant-control-grid"><ReportsDataPanel artifacts={artifacts.data?.items ?? []} loading={reports.loading || artifacts.loading} reports={reports.data?.items ?? []} /><PostProgramPanel data={postProgram.data ?? null} loading={postProgram.loading} merchantId={merchantId} /></div>
  </>;
}

function LifecycleRail({ data }: { data: LifecycleView }) {
  return <section aria-label="生命周期阶段（说明）" className="lifecycle-rail lifecycle-rail-explainer">{data.stages.map((stage) => <div className={`r-step is-${stage.status === "CURRENT" ? "now" : stage.status === "DONE" ? "done" : "off"}`} key={stage.key}><strong>{STAGE_LABELS[stage.key]}</strong><small>{stage.note}</small></div>)}</section>;
}

function deriveNextAction({ lifecycle, merchantId, canManage, busy, onQuestionnaire }: { lifecycle: LifecycleView; merchantId: string; canManage: boolean; busy: boolean; onQuestionnaire: (questionnaire: CurrentQuestionnaire | null) => Promise<void> }): MerchantNextAction {
  const copy = lifecycleActionCopy(lifecycle);
  if (lifecycle.stage === "QUESTIONNAIRE") {
    const questionnaire = lifecycle.questionnaire;
    return { ...copy, action: { label: questionnaire ? questionnaire.status === "SENT" ? "重发问卷" : "登记发放" : "生成接入问卷", disabled: !canManage || busy, onClick: () => { void onQuestionnaire(questionnaire); } } };
  }
  return { ...copy, action: { label: copy.actionLabel, href: copy.actionPath === "inbox" ? `/inbox?merchant_id=${encodeURIComponent(merchantId)}${copy.proposal ? "&tab=proposals" : ""}` : `/merchants/${encodeURIComponent(merchantId)}?view=audit` } };
}
