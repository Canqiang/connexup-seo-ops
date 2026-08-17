import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { MerchantSwitcher } from "./MerchantSwitcher";
import type { MerchantSummary } from "../../api/types";

test("keeps sixty merchants behind one searchable switcher", async () => {
  const merchants = Array.from({ length: 60 }, (_, index): MerchantSummary => ({
    id: `merchant-${index}`, slug: `merchant-${index}`,
    display_name: index === 42 ? "Only Bear Mineola" : `Merchant ${index}`,
    operator_user_ids: ["user-1"], operators: [], owner_ids: [], locations: [], location_count: 0,
    task_count: 0, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0, health: "STABLE"
  }));
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(<MerchantSwitcher merchants={merchants} userId="user-1" onPortfolio={vi.fn()} onSelect={onSelect} />);

  expect(screen.getAllByRole("combobox")).toHaveLength(1);
  await user.click(screen.getByRole("combobox"));
  await user.type(screen.getByRole("searchbox"), "Mineola");

  expect(screen.getByRole("option", { name: /Only Bear Mineola/ })).toBeInTheDocument();
  expect(screen.getByText("1 个结果")).toBeInTheDocument();
});
