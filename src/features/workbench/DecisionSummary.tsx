import type { HumanActionGroup, WorkbenchView } from "../../api/types";
import { actionGroups } from "./actionCopy";

type DecisionSummaryProps = {
  summary: WorkbenchView["summary"];
  selectedGroup?: HumanActionGroup;
  onSelect: (group?: HumanActionGroup) => void;
};

export function DecisionSummary({ summary, selectedGroup, onSelect }: DecisionSummaryProps) {
  const counts: Record<HumanActionGroup, number> = {
    GATEKEEPING: summary.gatekeeping,
    EXCEPTION: summary.exception,
    MERCHANT_CONTACT: summary.merchant_contact,
  };

  return <section aria-label="人工决策摘要" className="decision-summary">
    <button aria-pressed={!selectedGroup} className={!selectedGroup ? "is-selected" : undefined} onClick={() => onSelect()} type="button">
      <span>全部待办</span><strong>{summary.total}</strong>
    </button>
    {actionGroups.map(({ key, label, description }) => <button aria-pressed={selectedGroup === key} className={selectedGroup === key ? "is-selected" : undefined} key={key} onClick={() => onSelect(key)} type="button">
      <span>{label}</span><strong>{counts[key]}</strong><small>{description}</small>
    </button>)}
  </section>;
}
