import type { AgentRunType } from "../domain/enums.js";
import type { Location, Merchant } from "../repos/types.js";
import type { Task } from "../repos/taskTypes.js";

/** Per-run-type directives rendered into the SOP message. Read-only framing
 * is global (below); EXECUTE-style work is deliberately not representable. */
const RUN_TYPE_DIRECTIVES: Record<AgentRunType, string> = {
  AUDIT: "运行类型：AUDIT（现状审计）——对目标商户/地点做本地 SEO 现状诊断，输出问题清单（按影响排序）与证据缺口。",
  KEYWORD_RESEARCH:
    "运行类型：KEYWORD_RESEARCH（关键词研究）——研究本地搜索关键词机会，输出关键词清单（含意图分组与优先级）与可执行建议。",
  PLAN: "运行类型：PLAN（方案规划）——基于现状与任务目标产出可执行的优化方案（分步骤、可验收），不含任何执行动作。",
  REPORT: "运行类型：REPORT（数据报告）——汇总当前可得数据，输出结构化的表现报告，标注数据来源与采集口径。",
  REVIEW: "运行类型：REVIEW（效果复盘）——对照任务目标复盘已做工作的效果，输出结论、归因分析与下一步建议。",
};

/** Builds the Chinese SOP message sent to the unified local SEO agent.
 * Pure function — deterministic field order so tests can assert content. */
export function buildAgentRunMessage(args: {
  runType: AgentRunType;
  task: Task;
  merchant: Merchant | null;
  location: Location | null;
  goal?: string | null;
}): string {
  const { runType, task, merchant, location, goal } = args;

  const lines: string[] = [];
  lines.push("你是本地 SEO 统一代理。本次为【只读分析任务】：不得执行任何写入或变更操作（不修改商家资料、不发布内容、不提交任何外部更改），只进行分析并输出报告。");
  lines.push(RUN_TYPE_DIRECTIVES[runType]);
  lines.push("输出要求：使用中文；结构化呈现（结论先行 → 依据 → 建议清单）；信息不足之处明确标注为“未知”，不要编造数据或指标。");

  lines.push("");
  lines.push("=== 任务上下文 ===");
  lines.push(
    merchant
      ? `商户：${merchant.displayName}（slug: ${merchant.slug}）`
      : "商户：（未提供）",
  );
  if (location) {
    const identities =
      Object.keys(location.externalIdentities).length > 0
        ? JSON.stringify(location.externalIdentities)
        : "无";
    lines.push(
      `地点：${location.displayName}（slug: ${location.slug}${location.timezone ? `，时区 ${location.timezone}` : ""}；外部身份：${identities}）`,
    );
  } else {
    lines.push("地点：（任务未绑定地点）");
  }
  lines.push(
    `任务：${task.title}（task_type: ${task.taskType}，source: ${task.source}，priority: ${task.priority}，impact: ${task.impact}${task.ownerId ? `，owner: ${task.ownerId}` : ""}${task.dueAt ? `，due: ${task.dueAt}` : ""}）`,
  );
  lines.push(
    `当前状态：${task.status}（evidence_state: ${task.evidenceState}，task_revision: ${task.taskRevision}，state_version: ${task.stateVersion}）`,
  );
  lines.push("");
  lines.push("执行定义（execution_spec，原文）：");
  lines.push("```json");
  lines.push(task.executionSpec);
  lines.push("```");
  lines.push(`证据要求：${task.requiredEvidenceTypes.join(", ") || "（无）"}`);
  const currentEvidence = task.evidenceRefs
    .filter((e) => e.taskRevision === task.taskRevision)
    .map((e) => `${e.type}:${e.verificationStatus}`);
  lines.push(
    `当前版本已有证据：${currentEvidence.length > 0 ? currentEvidence.join("、") : "无"}`,
  );

  if (goal !== undefined && goal !== null && goal.trim() !== "") {
    lines.push("");
    lines.push(`操作员补充目标：${goal.trim()}`);
  }

  return lines.join("\n");
}
