import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { portfolioFixture } from "../../test/fixtures";
import { DemoTaskDrawer } from "./DemoTaskDrawer";
import { buildDemoTasks, filterDemoTasks } from "./demoTasks";
import { formatTaskOwner } from "./taskOwner";

function makeKekeMerchant() {
  return {
    ...portfolioFixture.merchants[0],
    id: "keke-food",
    slug: "keke-food",
    display_name: "Keke Food",
    locations: [{ id: "keke-location", display_name: "待确认地点", readiness_status: "INCOMPLETE" as const }],
  };
}

test("demo task owner filter uses the operator id exposed by the real filter", () => {
  const tasks = buildDemoTasks(portfolioFixture.merchants, new Date("2026-08-20T08:00:00Z"));

  expect(filterDemoTasks(tasks, { owner_id: "user-1" })).toHaveLength(7);
});

test("demo tasks without an operator remain visibly unassigned", () => {
  const merchant = {
    ...portfolioFixture.merchants[0],
    operators: [],
    operator_user_ids: [],
  };

  const tasks = buildDemoTasks([merchant], new Date("2026-08-20T08:00:00Z"));

  expect(tasks.every((task) => task.owner_id === "unassigned")).toBe(true);
});

test("unassigned demo owners render as 未分配 while named owners stay unchanged", () => {
  const unassigned = {
    ...buildDemoTasks([makeKekeMerchant()], new Date("2026-08-20T08:00:00Z"))[0]!,
    owner_id: "unassigned",
  };
  const named = { ...unassigned, owner_id: "operator-7" };

  const { rerender } = render(DemoTaskDrawer({ task: unassigned, onClose: () => undefined }));
  expect(screen.getByText("未分配")).toBeInTheDocument();

  rerender(DemoTaskDrawer({ task: named, onClose: () => undefined }));
  expect(screen.getByText("operator-7")).toBeInTheDocument();
});

test("owner formatter localizes nullish and demo sentinel owners", () => {
  expect(formatTaskOwner(null)).toBe("未分配");
  expect(formatTaskOwner(undefined)).toBe("未分配");
  expect(formatTaskOwner("unassigned")).toBe("未分配");
  expect(formatTaskOwner("operator-7")).toBe("operator-7");
});

test("weekly GBP schedule materializes as four independent dated tasks", () => {
  const tasks = buildDemoTasks(portfolioFixture.merchants, new Date("2026-08-20T08:00:00Z"));
  const posts = tasks.filter((task) => task.task_type === "GBP_POST");

  expect(posts).toHaveLength(4);
  expect(posts.map((task) => task.title)).toEqual([
    "08月20日发布 GBP Post｜午餐选择",
    "08月27日发布 GBP Post｜奶茶搭配",
    "09月03日发布 GBP Post｜周末聚餐",
    "09月10日发布 GBP Post｜外带场景",
  ]);
  expect(new Set(posts.map((task) => task.due_at)).size).toBe(4);
  expect(posts.every((task) => task.post_occurrence)).toBe(true);
});

test("new Keke merchant receives the onboarding chain instead of mature recurring work", () => {
  const tasks = buildDemoTasks([makeKekeMerchant()], new Date("2026-08-20T08:00:00Z"));

  expect(tasks.map((task) => task.title)).toEqual([
    "生成并发放商户问卷",
    "问卷回收后生成关键词库",
    "执行 GBP + 官网双审计",
    "建立 Local + Organic 排名基线",
    "生成首轮 SEO Plan",
    "确认 Plan｜拆分首轮执行任务",
  ]);
  expect(tasks.map((task) => task.status)).toEqual([
    "APPROVED", "APPROVED", "APPROVED", "NEEDS_INPUT", "BLOCKED", "BLOCKED",
  ]);
  expect(tasks.map((task) => task.due_at?.slice(0, 10))).toEqual([
    "2026-08-12", "2026-08-14", "2026-08-17", "2026-08-20", "2026-08-21", "2026-08-24",
  ]);
  expect(tasks.map((task) => Reflect.get(task, "progress_status"))).toEqual([
    "COMPLETED", "COMPLETED", "COMPLETED", "IN_PROGRESS", "WAITING", "WAITING",
  ]);
  expect(tasks.map((task) => task.evidence_state)).toEqual([
    "VERIFIED", "VERIFIED", "VERIFIED", "PARTIAL", "NONE", "NONE",
  ]);
  expect(tasks[0]?.dependencies).toEqual([]);
  expect(tasks[1]?.dependencies).toEqual(["商户问卷已回收"]);
  expect(tasks[5]?.dependencies).toEqual(["首轮 SEO Plan 已生成"]);
  expect(tasks.some((task) => task.task_type === "GBP_POST" || task.task_type === "RE_AUDIT")).toBe(false);
});

test("completed Keke demo work uses the operator-facing progress label", () => {
  const task = buildDemoTasks([makeKekeMerchant()], new Date("2026-08-20T08:00:00Z"))[0]!;

  render(DemoTaskDrawer({ task, onClose: () => undefined }));

  expect(screen.getByText("已完成")).toBeInTheDocument();
});

test("questionnaire-stage merchant receives onboarding work instead of mature recurring work", () => {
  const merchant = {
    ...portfolioFixture.merchants[0],
    id: "test-merchant",
    slug: "test",
    display_name: "test",
    locations: [],
    location_count: 0,
    task_count: 0,
    stage: "QUESTIONNAIRE" as const,
  };

  const tasks = buildDemoTasks([merchant], new Date("2026-08-20T08:00:00Z"));

  expect(tasks.map((task) => task.title)).toEqual([
    "生成并发放商户问卷",
    "问卷回收后生成关键词库",
    "执行 GBP + 官网双审计",
    "建立 Local + Organic 排名基线",
    "生成首轮 SEO Plan",
    "确认 Plan｜拆分首轮执行任务",
  ]);
  expect(tasks.map((task) => task.progress_status)).toEqual([
    "IN_PROGRESS", "WAITING", "WAITING", "WAITING", "WAITING", "WAITING",
  ]);
});

test("onboarding progress advances with the merchant lifecycle stage", () => {
  const merchant = {
    ...portfolioFixture.merchants[0],
    id: "audit-merchant",
    slug: "audit-merchant",
    display_name: "Audit Merchant",
    task_count: 0,
    stage: "AUDIT" as const,
  };

  const tasks = buildDemoTasks([merchant], new Date("2026-08-20T08:00:00Z"));

  expect(tasks.map((task) => task.progress_status)).toEqual([
    "COMPLETED", "COMPLETED", "IN_PROGRESS", "WAITING", "WAITING", "WAITING",
  ]);
  expect(tasks.map((task) => task.evidence_state)).toEqual([
    "VERIFIED", "VERIFIED", "PARTIAL", "NONE", "NONE", "NONE",
  ]);
});
