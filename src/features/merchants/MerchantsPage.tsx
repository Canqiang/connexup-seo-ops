import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { MerchantSummary } from "../../api/types";
import { hasPermission } from "../../auth/permissions";
import { useAuth } from "../../auth/AuthContext";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import {
  EXCEPTION_GROUPS,
  STAGE_LABELS,
  exceptionWhy,
  sortMerchantsInGroup,
} from "../merchant/lifecycleCopy";
import { NewMerchantModal } from "./NewMerchantModal";

/** 商户首页 = 异常清单：按“需要动的原因”分组，卡得最久的置顶。
 * 首屏一秒回答“三十家今天该动哪家”。 */
export function MerchantsPage() {
  usePageTitle("商户");
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [resendError, setResendError] = useState("");

  if (workspace.loading) return <div className="page-state" role="status">正在汇总商户…</div>;
  if (workspace.error) return <div className="page-state is-error" role="alert">商户数据读取失败。<button onClick={workspace.reload}>重试</button></div>;
  const portfolio = workspace.portfolio;
  if (!portfolio) return null;
  const merchants = portfolio.merchants ?? [];
  const canManage = hasPermission(user?.permissions, "seoops.manage");

  const byGroup = new Map<string, MerchantSummary[]>();
  for (const merchant of merchants) {
    const key = merchant.exception?.type ?? "NONE";
    const list = byGroup.get(key) ?? [];
    list.push(merchant);
    byGroup.set(key, list);
  }
  const attentionCount = merchants.filter((m) => (m.exception?.type ?? "NONE") !== "NONE").length;

  const resend = async (merchant: MerchantSummary) => {
    const questionnaireId = merchant.exception?.questionnaire_id;
    if (!questionnaireId) return;
    setResending(merchant.id);
    setResendError("");
    try {
      await seoOpsApi.sendQuestionnaire(questionnaireId);
      workspace.reload();
    } catch {
      setResendError("重发登记失败，稍后重试。");
    } finally {
      setResending(null);
    }
  };

  return <>
    <header className="page-heading">
      <div>
        <span className="eyebrow">PORTFOLIO / {merchants.length} MERCHANTS</span>
        <h1>商户</h1>
        <p>{attentionCount > 0 ? <>{attentionCount} 家需要处理 · 按卡住的时间排序</> : "全部正常滚动"} · 今天 {new Date().toLocaleDateString("zh-CN")}</p>
      </div>
      <div className="heading-actions">
        {canManage ? <button className="primary-button" onClick={() => setCreating(true)} type="button"><Plus size={15} /> ＋ 新店</button> : null}
      </div>
    </header>
    {resendError ? <p className="form-message" role="alert">{resendError}</p> : null}
    {merchants.length === 0 ? <div className="empty-state"><h2>还没有商户</h2><p>点右上「＋ 新店」提交店名/官网，由 Planner 生成接入任务计划。</p>{canManage ? <button className="primary-button" onClick={() => setCreating(true)} type="button"><Plus size={15} /> ＋ 新店</button> : null}</div> : null}
    {EXCEPTION_GROUPS.map((group) => {
      const members = byGroup.get(group.key);
      if (!members?.length) return null;
      const sorted = sortMerchantsInGroup(members, group.key);
      return <section aria-label={group.label} className={`exception-group${group.key === "NONE" ? " is-calm" : ""}`} key={group.key}>
        <div className="grp-head">
          <strong>{group.label}</strong>
          <span className="cnt">{sorted.length}</span>
          <small>{group.hint}</small>
        </div>
        {sorted.map((merchant) => <div className="merchant-row" key={merchant.id}>
          <span className={`status-pill ${group.key === "NONE" ? "" : merchant.stage ? "is-attention" : ""}`}>{merchant.stage ? STAGE_LABELS[merchant.stage] : "—"}</span>
          <div className="who">
            <strong>{merchant.display_name}</strong>
            <small>{merchant.locations.map((l) => l.display_name).join("、") || "未建地点"}</small>
          </div>
          <div className="why">{exceptionWhy(merchant)}</div>
          <div className="act">
            {group.key === "WAITING_MERCHANT" && canManage && merchant.exception?.questionnaire_id
              ? <button className="secondary-button" disabled={resending === merchant.id} onClick={() => { void resend(merchant); }} type="button"><RefreshCw size={12} /> {resending === merchant.id ? "登记中…" : "重发问卷"}</button>
              : null}
            {group.key === "PLAN_PENDING"
              ? <button className="primary-button" onClick={() => workspace.selectMerchant(merchant.id)} type="button">确认 Plan ›</button>
              : null}
            {group.key === "APPROVAL"
              ? <button className="secondary-button" onClick={() => navigate(`/inbox?merchant_id=${merchant.id}&status=READY_FOR_APPROVAL`)} type="button">去审批</button>
              : null}
            {group.key === "RANKING_DUE"
              ? <button className="primary-button" onClick={() => workspace.selectMerchant(merchant.id)} type="button">复查排名 ›</button>
              : null}
            <button aria-label={`打开 ${merchant.display_name}`} className="row-arrow" onClick={() => workspace.selectMerchant(merchant.id)} type="button">›</button>
          </div>
        </div>)}
      </section>;
    })}
    {creating ? <NewMerchantModal onClose={() => setCreating(false)} onDone={() => workspace.reload()} /> : null}
  </>;
}
