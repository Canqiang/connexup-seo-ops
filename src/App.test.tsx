import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import App from "./App";

test("switching merchants updates both merchant and location context", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /当前商户：可可小卤/ }));
  await user.click(screen.getByRole("option", { name: /Only Bear Chicken & Boba/ }));

  expect(screen.getByRole("heading", { name: "Only Bear Chicken & Boba" })).toBeInTheDocument();
  expect(screen.getByText("Mineola · Website SEO")).toBeInTheDocument();
});

test("merchant switcher filters a large portfolio by merchant or location", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: /当前商户：可可小卤/ }));
  await user.type(screen.getByRole("searchbox", { name: "搜索商户或门店" }), "Upper West");

  expect(screen.getByRole("option", { name: /Choice Brooklyn UWS/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Only Bear Chicken & Boba/ })).not.toBeInTheDocument();
});

test("opening an execution task exposes its target, next action, and evidence state", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(
    screen.getByRole("button", { name: "查看任务：Only Bear 菜单页发布审批" })
  );

  const drawer = screen.getByRole("dialog", { name: "任务详情" });
  expect(drawer).toBeInTheDocument();
  expect(within(drawer).getByText("Only Bear Chicken & Boba → Mineola → Menu page")).toBeInTheDocument();
  expect(within(drawer).getByText("批准已核实菜单真值的发布预览")).toBeInTheDocument();
  expect(within(drawer).getByText("待授权")).toBeInTheDocument();
  expect(within(drawer).getByText("READY")).toBeInTheDocument();
  expect(within(drawer).getByText("部分证据")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "关闭任务详情" }));
  expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
});

test("copilot keeps merchant context explicit and gates external writes behind approval", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "打开 SEO Ops Copilot" }));

  expect(screen.getByRole("dialog", { name: "SEO Ops Copilot" })).toBeInTheDocument();
  expect(screen.getByText("商户 · 可可小卤")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "生成发布预览" }));

  expect(screen.getByRole("status")).toHaveTextContent(
    "已生成预览：需要人工批准后才能执行外部写入。"
  );
  expect(screen.getByRole("button", { name: "执行外部写入" })).toBeDisabled();
});
