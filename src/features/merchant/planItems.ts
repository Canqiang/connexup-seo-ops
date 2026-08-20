export interface PlanItem {
  id: string;
  title: string;
  detail: string;
  priority: "P0" | "P1" | "P2" | null;
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

/** 转任务用的执行定义：记录来源 plan run，人工工单语义（无外部写入参数）。 */
export function planItemExecutionSpec(
  item: PlanItem,
  planRunId: string,
): string {
  return JSON.stringify({
    operation: "manual_work_order",
    plan_run_id: planRunId,
    item_title: item.title,
  });
}
