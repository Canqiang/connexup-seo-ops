import type { ReviewClassification } from "../../api/types";

export function reviewExplanation(classification: ReviewClassification): string {
  switch (classification) {
    case "CAUSAL_READY": return "已具备基线、干预、后测和因果设计，可进入严格归因复核。";
    case "CORRELATIONAL": return "变化与动作在时间相关，但仍不能把结果归因于本次动作。";
    case "FACTUAL": return "已记录可核实事实，但缺少对齐的前后测量。";
    default: return "证据不足，无法判断因果。先补齐基线、动作记录与后测。";
  }
}

export function classificationLabel(classification: ReviewClassification): string {
  switch (classification) {
    case "CAUSAL_READY": return "因果设计就绪（需单独批准）";
    case "CORRELATIONAL": return "关联（上限 ASSOCIATIONAL）";
    case "FACTUAL": return "事实记录";
    default: return "证据不足";
  }
}

export type ConclusionTier = "INSUFFICIENT_EVIDENCE" | "DESCRIPTIVE" | "ASSOCIATIONAL";
export function tierLabel(tier: string): string {
  if (tier === "ASSOCIATIONAL") return "正向/负向关联 · ASSOCIATIONAL";
  if (tier === "DESCRIPTIVE") return "仅描述 · DESCRIPTIVE";
  return "无法定论 · INSUFFICIENT";
}
