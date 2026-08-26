export interface PlanItem {
  id: string;
  title: string;
  detail: string;
  priority: "P0" | "P1" | "P2" | "P3" | null;
  taskType?: string;
  executionMode?: "AUTO_WRITE" | "ARTIFACT" | "READ_ONLY" | "MANUAL";
  dependsOn?: string[];
  acceptanceCriteria?: string;
  dueOffsetDays?: number;
}

export interface PlanProposalItem {
  title: string;
  task_type: string;
  execution_mode: "AUTO_WRITE" | "ARTIFACT" | "READ_ONLY" | "MANUAL";
  depends_on: number[];
  due_at?: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  impact: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  acceptance_criteria: string;
  execution_spec: string;
  required_evidence_types: string[];
}

const ITEM_LINE = /^\s*(?:\d+[.、)]|[-*])\s+(.*)$/;
const HEADING = /^#{1,6}\s+/;
const SECTION_HINT = /(建议|行动|action|优先级)/i;
const PRIORITY_TAG = /(?:^|[\s（(])P([0-3])(?=[\s，,）)）]|$)/;

/** 从 SOP 报告（markdown）中解析「建议清单」为可勾选转任务的条目。
 *
 * 目标格式（真实产物形态）：
 *   ## 四、建议清单（按优先级）
 *   1. **接入真实 GBP（P0，解除主阻塞）**：将 gid-demo 替换为真实授权连接…
 *
 * 解析不到清单时返回空数组——调用方回退为「按整份报告建单个任务」。
 */
export function parsePlanItems(output: string): PlanItem[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex(
    (line, index) => HEADING.test(line) && SECTION_HINT.test(line) && index > 0,
  );
  if (start === -1) return [];
  const collected: string[] = [];
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line) || line.trim() === "---") break;
    const match = line.match(ITEM_LINE);
    if (match) {
      if (current !== null) collected.push(current);
      current = match[1]!.trim();
    } else if (current !== null && line.trim() !== "") {
      // 缩进续行并入上一条
      current += ` ${line.trim()}`;
    }
  }
  if (current !== null) collected.push(current);

  return collected.slice(0, 12).map((text, index) => {
    const colonAt = text.indexOf("：");
    const bold = text.match(/\*\*(.+?)\*\*/);
    let title = (bold ? bold[1]! : text.split("：")[0]!).trim();
    const priorityMatch = title.match(PRIORITY_TAG);
    const priority = priorityMatch
      ? (`P${priorityMatch[1]}` as PlanItem["priority"])
      : null;
    if (priorityMatch) {
      // 去掉标题里的优先级括注，优先级以标签呈现
      title = title
        .replace(/[（(]\s*P[0-3][^）)]*[）)]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    return {
      id: `item-${index}`,
      title: title.slice(0, 120) || `建议 ${index + 1}`,
      detail: colonAt >= 0 ? text.slice(colonAt + 1).replace(/\*\*/g, "").trim().slice(0, 400) : "",
      priority,
    };
  });
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

const STRUCTURED_PRIORITY = {
  URGENT: "P0",
  HIGH: "P1",
  MEDIUM: "P2",
  LOW: "P3",
} as const;

const EXECUTION_MODES = new Set(["AUTO_WRITE", "ARTIFACT", "READ_ONLY", "MANUAL"]);

/** 从已通过后端 schema 校验并落库的 Plan 产物读取工作项。
 * 前端仍做防御式检查，避免异常历史数据令确认面板崩溃。 */
export function planItemsFromArtifact(payload: Record<string, unknown>): PlanItem[] {
  return recordArray(payload.work_items).flatMap((raw) => {
    if (typeof raw.id !== "string" || typeof raw.title !== "string") return [];
    const priority = typeof raw.priority === "string" && raw.priority in STRUCTURED_PRIORITY
      ? STRUCTURED_PRIORITY[raw.priority as keyof typeof STRUCTURED_PRIORITY]
      : null;
    const executionMode = typeof raw.execution_mode === "string" && EXECUTION_MODES.has(raw.execution_mode)
      ? raw.execution_mode as NonNullable<PlanItem["executionMode"]>
      : undefined;
    const dependsOn = Array.isArray(raw.depends_on)
      ? raw.depends_on.filter((item): item is string => typeof item === "string")
      : [];
    return [{
      id: raw.id,
      title: raw.title,
      detail: typeof raw.rationale === "string" ? raw.rationale : "",
      priority,
      ...(typeof raw.task_type === "string" ? { taskType: raw.task_type } : {}),
      ...(executionMode ? { executionMode } : {}),
      dependsOn,
      ...(typeof raw.acceptance_criteria === "string" ? { acceptanceCriteria: raw.acceptance_criteria } : {}),
      ...(typeof raw.due_offset_days === "number" && Number.isInteger(raw.due_offset_days)
        ? { dueOffsetDays: raw.due_offset_days }
        : {}),
    }];
  });
}

function taskPriority(item: PlanItem): PlanProposalItem["priority"] {
  if (item.priority === "P0") return "URGENT";
  if (item.priority === "P1") return "HIGH";
  if (item.priority === "P3") return "LOW";
  return "MEDIUM";
}

function requiredEvidence(item: PlanItem): string[] {
  return item.executionMode === "AUTO_WRITE" || item.executionMode === "ARTIFACT"
    ? ["CONTENT_DRAFT"]
    : [];
}

/** 将人工勾选后的结构化 Plan 转为建议层输入；依赖缺失时 fail-closed。 */
export function buildPlanProposalItems(
  items: PlanItem[],
  selectedIds: Set<string>,
  provenance: { artifactId: string; coreRunId: string; createdAt: string },
): PlanProposalItem[] {
  const selected = items.filter((item) => selectedIds.has(item.id));
  const sequence = new Map(selected.map((item, index) => [item.id, index + 1]));
  for (const item of selected) {
    const missing = (item.dependsOn ?? []).filter((dependency) => !sequence.has(dependency));
    if (missing.length > 0) {
      throw new Error(`${item.title} 缺少依赖项：${missing.join("、")}`);
    }
  }
  const base = new Date(provenance.createdAt);
  return selected.map((item) => {
    const due = Number.isFinite(base.getTime()) && item.dueOffsetDays !== undefined
      ? new Date(base.getTime() + item.dueOffsetDays * 86_400_000).toISOString()
      : undefined;
    const priority = taskPriority(item);
    const executionMode = item.executionMode ?? "MANUAL";
    return {
      title: item.title,
      task_type: item.taskType ?? "MANUAL_FOLLOWUP",
      execution_mode: executionMode,
      depends_on: (item.dependsOn ?? []).map((dependency) => sequence.get(dependency)!),
      ...(due ? { due_at: due } : {}),
      priority,
      impact: priority === "URGENT" ? "CRITICAL" : priority === "HIGH" ? "HIGH" : priority === "LOW" ? "LOW" : "MEDIUM",
      acceptance_criteria: item.acceptanceCriteria ?? "由负责人完成并回填可独立核验的证据。",
      execution_spec: JSON.stringify({
        operation: "plan_work_item",
        plan_artifact_id: provenance.artifactId,
        plan_run_id: provenance.coreRunId,
        work_item_id: item.id,
        item_title: item.title,
        rationale: item.detail,
        acceptance_criteria: item.acceptanceCriteria ?? null,
      }),
      required_evidence_types: requiredEvidence(item),
    };
  });
}

/** 转任务用的执行定义：记录来源 plan run，人工工单语义（无外部写入参数）。 */
export function planItemExecutionSpec(
  item: PlanItem,
  planRunId: string,
): string {
  return JSON.stringify({
    operation: "manual_work_order",
    plan_run_id: planRunId,
    work_item_id: item.id,
    item_title: item.title,
  });
}
