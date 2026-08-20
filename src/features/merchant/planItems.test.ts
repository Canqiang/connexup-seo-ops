import { describe, expect, it } from "vitest";
import { parsePlanItems, planItemExecutionSpec } from "./planItems";

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
      item_title: "接入真实 GBP",
    });
  });
});
