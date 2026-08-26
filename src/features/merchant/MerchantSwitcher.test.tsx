import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { MerchantSwitcher } from "./MerchantSwitcher";
import type { MerchantSummary } from "../../api/types";
import { portfolioWithMerchants } from "../../test/fixtures";

afterEach(() => localStorage.clear());

test("keeps one hundred merchants behind one searchable switcher", async () => {
  const merchants = portfolioWithMerchants(100).merchants;
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(<MerchantSwitcher merchants={merchants} onPortfolio={vi.fn()} onSelect={onSelect} />);

  expect(screen.getAllByRole("combobox")).toHaveLength(1);
  await user.click(screen.getByRole("combobox"));
  await user.type(screen.getByRole("searchbox"), "Merchant 087");

  expect(screen.getByRole("option", { name: /Merchant 087/ })).toBeInTheDocument();
  expect(screen.getByText("1 个结果")).toBeInTheDocument();
});

test("keeps merchant favorites only for the current component lifetime", async () => {
  const merchants: MerchantSummary[] = [{
    id: "only-bear", slug: "only-bear", display_name: "Only Bear", operator_user_ids: [], operators: [], owner_ids: [], locations: [], location_count: 0,
    task_count: 0, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0, health: "STABLE",
  }];
  const user = userEvent.setup();
  render(<MerchantSwitcher merchants={merchants} onPortfolio={vi.fn()} onSelect={vi.fn()} />);

  await user.click(screen.getByRole("combobox"));
  await user.click(screen.getByRole("button", { name: "收藏 Only Bear" }));

  expect(screen.getByRole("button", { name: "取消收藏 Only Bear" })).toBeInTheDocument();
  expect(localStorage.length).toBe(0);
});
