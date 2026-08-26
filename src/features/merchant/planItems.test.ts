import { describe, expect, it } from "vitest";
import {
  buildPlanProposalItems,
  parsePlanItems,
  planItemExecutionSpec,
  planItemsFromArtifact,
} from "./planItems";

const REAL_SHAPED_OUTPUT = `我将执行本次【只读】规划。先说明计划。

## 一、结论（先行）

优先补齐经营类别与服务区域。

## 四、建议清单（按优先级）

1. **接入真实 GBP（P0，解除主阻塞）**：将 \`gid-demo\` 替换为真实授权连接，确认门店的规范 location ID。
2. **修正执行定义参数（P0）**：把 \`primary\` 改为合法 GBP 类别，建议主类别 \`Korean restaurant\`。
   缩进续行也应并入本条。
3. 补齐品牌档案：解析真实 merchant_id。
- 无优先级标签的条目也能解析

---

## 五、信息不足

- 不该被收录的段落项`;

describe("parsePlanItems", () => {
  it("parses the recommendation section with priorities, titles and details", () => {
    const items = parsePlanItems(REAL_SHAPED_OUTPUT);
    expect(items).toHaveLength(4);

    expect(items[0]).toMatchObject({
      title: "接入真实 GBP",
      priority: "P0",
    });
    expect(items[0]!.detail).toContain("gid-demo");

    expect(items[1]).toMatchObject({ title: "修正执行定义参数", priority: "P0" });
    // 缩进续行并入上一条
    expect(items[1]!.detail).toContain("缩进续行也应并入本条");

    expect(items[2]).toMatchObject({ title: "补齐品牌档案", priority: null });
    expect(items[2]!.detail).toBe("解析真实 merchant_id。");

    expect(items[3]!.priority).toBeNull();
    // 标题或详情里的 ** 已清理
    expect(JSON.stringify(items)).not.toContain("**");
  });

  it("returns empty when there is no recommendation section", () => {
    expect(parsePlanItems("# 报告\n\n只有结论，没有清单。")).toEqual([]);
    expect(parsePlanItems("")).toEqual([]);
  });

  it("stops at the next heading or divider", () => {
    const items = parsePlanItems(REAL_SHAPED_OUTPUT);
    expect(items.some((item) => item.title.includes("不该被收录"))).toBe(false);
  });

  it("execution spec records plan provenance and manual work order semantics", () => {
    const spec = JSON.parse(
      planItemExecutionSpec(
        { id: "item-0", title: "接入真实 GBP", detail: "", priority: "P0" },
        "run-9",
      ),
    );
    expect(spec).toEqual({
      operation: "manual_work_order",
      plan_run_id: "run-9",
      work_item_id: "item-0",
      item_title: "接入真实 GBP",
    });
  });
});

describe("structured execution plan", () => {
  const payload = {
    schema_version: "seo_ops.execution_plan.v1",
    work_items: [
      {
        id: "audit-refresh",
        title: "重新 Audit",
        task_type: "AUDIT",
        execution_mode: "READ_ONLY",
        priority: "HIGH",
        depends_on: [],
        rationale: "确认本轮技术状态",
        acceptance_criteria: "结构化 Audit 已落库",
        due_offset_days: 2,
      },
      {
        id: "gbp-post",
        title: "发布本周 GBP Post",
        task_type: "GBP_POST",
        execution_mode: "AUTO_WRITE",
        priority: "MEDIUM",
        depends_on: ["audit-refresh"],
        rationale: "承接本周关键词主题",
        acceptance_criteria: "发布链接完成独立回读",
        due_offset_days: 4,
      },
    ],
  };

  it("reads accepted structured work items instead of parsing markdown", () => {
    expect(planItemsFromArtifact(payload)).toEqual([
      expect.objectContaining({
        id: "audit-refresh",
        title: "重新 Audit",
        priority: "P1",
        taskType: "AUDIT",
        executionMode: "READ_ONLY",
        dependsOn: [],
      }),
      expect.objectContaining({
        id: "gbp-post",
        priority: "P2",
        taskType: "GBP_POST",
        executionMode: "AUTO_WRITE",
        dependsOn: ["audit-refresh"],
      }),
    ]);
  });

  it("turns a selected dependency-safe plan into proposal items", () => {
    const items = planItemsFromArtifact(payload);
    const proposals = buildPlanProposalItems(items, new Set(items.map((item) => item.id)), {
      artifactId: "artifact-1",
      coreRunId: "run-1",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    expect(proposals[0]).toMatchObject({
      task_type: "AUDIT",
      execution_mode: "READ_ONLY",
      depends_on: [],
      due_at: "2026-08-22T00:00:00.000Z",
    });
    expect(proposals[1]).toMatchObject({
      task_type: "GBP_POST",
      execution_mode: "AUTO_WRITE",
      depends_on: [1],
      required_evidence_types: ["CONTENT_DRAFT"],
      due_at: "2026-08-24T00:00:00.000Z",
    });
    expect(JSON.parse(proposals[1]!.execution_spec)).toMatchObject({
      operation: "plan_work_item",
      plan_artifact_id: "artifact-1",
      plan_run_id: "run-1",
      work_item_id: "gbp-post",
    });
  });

  it("rejects a selection that omits an upstream dependency", () => {
    const items = planItemsFromArtifact(payload);
    expect(() => buildPlanProposalItems(items, new Set(["gbp-post"]), {
      artifactId: "artifact-1",
      coreRunId: "run-1",
      createdAt: "2026-08-20T00:00:00.000Z",
    })).toThrow("依赖项");
  });
});
