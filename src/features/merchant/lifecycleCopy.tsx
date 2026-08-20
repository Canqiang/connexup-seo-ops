import type { ReactNode } from "react";
import type {
  LifecycleStageKey,
  MerchantExceptionType,
  MerchantSummary,
} from "../../api/types";

export const STAGE_LABELS: Record<LifecycleStageKey, string> = {
  QUESTIONNAIRE: "问卷",
  KEYWORDS: "关键词",
  AUDIT: "双审计",
  RANKING_BASELINE: "排名基线",
  PLAN: "Plan",
  EXECUTE: "执行",
  VERIFY: "核验",
};

export interface ExceptionGroupDef {
  key: MerchantExceptionType;
  label: string;
  hint: string;
}

/** 首页分组顺序：卡得最久、最需要人动的在最上面。 */
export const EXCEPTION_GROUPS: ExceptionGroupDef[] = [
  { key: "WAITING_MERCHANT", label: "等待商家回复", hint: "问卷外发后按发出天数排序，可重发" },
  { key: "PLAN_PENDING", label: "Plan 待确认", hint: "Agent 已产出建议清单，等操作员确认转任务" },
  { key: "APPROVAL", label: "待审批", hint: "批准只记录授权，不触发执行" },
  { key: "VERIFY", label: "证据待核验", hint: "执行后回填的证据等核验" },
  { key: "RANKING_DUE", label: "Ranking 复查到期", hint: "每周一查，逾期标出" },
  { key: "NONE", label: "周期内无待办", hint: "正常滚动" },
];

/** 分组内排序：等待/逾期的按时间最久在前，其余按名称。 */
export function sortMerchantsInGroup(
  merchants: MerchantSummary[],
  group: MerchantExceptionType,
): MerchantSummary[] {
  return [...merchants].sort((a, b) => {
    const waitA = group === "WAITING_MERCHANT" ? a.exception?.waiting_days ?? 0 : 0;
    const waitB = group === "WAITING_MERCHANT" ? b.exception?.waiting_days ?? 0 : 0;
    if (waitA !== waitB) return waitB - waitA;
    const ageA = group === "RANKING_DUE" ? a.exception?.age_days ?? 0 : 0;
    const ageB = group === "RANKING_DUE" ? b.exception?.age_days ?? 0 : 0;
    if (ageA !== ageB) return ageB - ageA;
    return a.display_name.localeCompare(b.display_name);
  });
}

/** 行内“为什么该动它”的一句话。 */
export function exceptionWhy(merchant: MerchantSummary): ReactNode {
  const exception = merchant.exception;
  if (!exception || exception.type === "NONE") return "周期内无待办";
  switch (exception.type) {
    case "WAITING_MERCHANT":
      return <>接入问卷发出 <b>{(exception.waiting_days ?? 0) + 1} 天</b>未回{exception.send_count && exception.send_count > 1 ? ` · 已重发 ${exception.send_count - 1} 次` : ""}——整个流程卡在这里</>;
    case "PLAN_PENDING":
      return <>优化 Plan 已生成 · 建议清单待确认转任务</>;
    case "APPROVAL":
      return <><b>{exception.count ?? 0}</b> 个任务已具备条件，等待批准</>;
    case "VERIFY":
      return <><b>{exception.count ?? 0}</b> 项执行证据待核验</>;
    case "RANKING_DUE":
      return <>上次复查 <b>{exception.age_days ?? 0} 天</b>前 · 已过 7 天周期</>;
    default:
      return "—";
  }
}
