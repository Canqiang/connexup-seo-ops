import type { HumanActionType, HumanActionWire } from "../../api/types";

export type ExceptionGroupKey = "UNKNOWN" | "MERCHANT" | "PROPOSAL" | "APPROVAL" | "VERIFY";

export const EXCEPTION_GROUPS: Array<{ key: ExceptionGroupKey; label: string; badge: string; hint: string }> = [
  { key: "UNKNOWN", label: "结果不确定", badge: "待查", hint: "可人工查证的执行链冻结 · GBP 专用回读不在此列" },
  { key: "MERCHANT", label: "等待商家", badge: "商家", hint: "外部依赖 · 到点提醒跟进" },
  { key: "PROPOSAL", label: "建议待判定", badge: "建议", hint: "Agent 只能建议 · SEO Ops 判定落库" },
  { key: "APPROVAL", label: "待审批与确认", badge: "审批", hint: "门 1 仅授权 · 门 2 才派发" },
  { key: "VERIFY", label: "核验与复查", badge: "核验", hint: "发布 ≠ 已验证" },
];

/** 穷举映射：每个 HumanActionType 都必须落在某一组，编译期强制补齐新增类型。 */
export const GROUP_BY_TYPE: Record<HumanActionType, ExceptionGroupKey> = {
  OUTCOME_RECONCILIATION: "UNKNOWN",
  CONFIRMED_FAILURE: "UNKNOWN",
  QUESTIONNAIRE_FOLLOWUP: "MERCHANT",
  AUTHORIZATION_FOLLOWUP: "MERCHANT",
  CONTENT_CONFIRMATION: "MERCHANT",
  REPORT_DELIVERY: "MERCHANT",
  PROPOSAL_DECISION: "PROPOSAL",
  GATE_1_APPROVAL: "APPROVAL",
  GATE_2_CONFIRM: "APPROVAL",
  ARTIFACT_ACCEPTANCE: "APPROVAL",
  VERIFICATION_OVERDUE: "VERIFY",
};

/** 按设计稿五组归类；组内按等待时长（waiting_since 升序 = 卡得最久在前）。 */
export function groupExceptions(items: HumanActionWire[]): Array<{ group: (typeof EXCEPTION_GROUPS)[number]; items: HumanActionWire[] }> {
  return EXCEPTION_GROUPS.map((group) => ({
    group,
    items: items.filter((item) => GROUP_BY_TYPE[item.type] === group.key).sort((a, b) => a.waiting_since.localeCompare(b.waiting_since)),
  })).filter((entry) => entry.items.length > 0);
}

export function waitingLabel(waitingSince: string, now = Date.now()): string {
  const hours = Math.max(0, Math.floor((now - Date.parse(waitingSince)) / 3_600_000));
  if (hours < 1) return "刚刚";
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
