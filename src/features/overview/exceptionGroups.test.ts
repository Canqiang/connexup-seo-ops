import { expect, test } from "vitest";
import type { HumanActionWire } from "../../api/types";
import { groupExceptions, waitingLabel } from "./exceptionGroups";

const base = (over: Partial<HumanActionWire>): HumanActionWire => ({
  id: "x", group: "EXCEPTION", type: "OUTCOME_RECONCILIATION", merchant_id: "m", merchant_name: "M", location_name: null,
  title: "t", reason: "r", primary_action: { label: "go", href: "/" }, secondary_href: null, priority: "HIGH", due_at: null,
  waiting_since: "2026-08-27T10:00:00Z", ...over,
});

test("groups by design categories and orders longest-waiting first", () => {
  const grouped = groupExceptions([
    base({ id: "a", type: "GATE_1_APPROVAL", waiting_since: "2026-08-27T12:00:00Z" }),
    base({ id: "b", type: "GATE_2_CONFIRM", waiting_since: "2026-08-25T12:00:00Z" }),
    base({ id: "c", type: "OUTCOME_RECONCILIATION" }),
  ]);
  expect(grouped.map((g) => g.group.key)).toEqual(["UNKNOWN", "APPROVAL"]);
  expect(grouped[1]!.items.map((i) => i.id)).toEqual(["b", "a"]);
});

test("waitingLabel renders hours under two days and days beyond", () => {
  const now = Date.parse("2026-08-27T15:00:00Z");
  expect(waitingLabel("2026-08-27T13:00:00Z", now)).toBe("2 小时");
  expect(waitingLabel("2026-08-22T13:00:00Z", now)).toBe("5 天");
});
