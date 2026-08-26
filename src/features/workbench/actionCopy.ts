import type { HumanActionGroup } from "../../api/types";

export const actionGroups: Array<{ key: HumanActionGroup; label: string; description: string }> = [
  { key: "EXCEPTION", label: "例外", description: "需要先查清异常，避免在不确定状态下继续推进。" },
  { key: "GATEKEEPING", label: "把关", description: "需要你的判断或授权，自动流程会在这里等待。" },
  { key: "MERCHANT_CONTACT", label: "商户联络", description: "需要向商户确认、补充或交付的信息。" },
];

export function formatWaiting(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "等待时间未知";
  return `自 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp))} 等待`;
}
