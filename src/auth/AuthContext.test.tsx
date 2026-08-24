import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";

const authApi = vi.hoisted(() => ({ me: vi.fn(), logout: vi.fn() }));
const navigateTo = vi.hoisted(() => vi.fn());
let lastLogout: Promise<void> | undefined;

vi.mock("../api/authApi", () => ({ authApi }));
vi.mock("./redirect", async (importOriginal) => {
  const original = await importOriginal<typeof import("./redirect")>();
  return { ...original, navigateTo };
});

afterEach(() => {
  vi.clearAllMocks();
  navigateTo.mockReset();
  lastLogout = undefined;
  localStorage.clear();
});

test("removes legacy identity and per-actor favorite state before exposing a new session", async () => {
  ["apiKey", "userId", "userName", "userRole", "userPermissions", "seoops.favorite_merchants.operator-1"].forEach((key) => {
    localStorage.setItem(key, "legacy");
  });
  authApi.me.mockResolvedValue({ user_id: "operator-2", name: "New Operator", role: "OPERATOR", permissions: ["seoops.view"] });

  render(<AuthProvider><Probe /></AuthProvider>);

  expect(await screen.findByText("New Operator")).toBeInTheDocument();
  expect(localStorage.length).toBe(0);
});

test("clears legacy browser auth state before navigating after logout", async () => {
  authApi.me.mockResolvedValue({ user_id: "operator-2", name: "New Operator", role: "OPERATOR", permissions: ["seoops.view"] });
  authApi.logout.mockResolvedValue(undefined);
  localStorage.setItem("apiKey", "legacy");
  localStorage.setItem("seoops.favorite_merchants.operator-2", "legacy");

  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText("New Operator");
  await screen.getByRole("button", { name: "logout" }).click();

  await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/seo-ops/login"));
  expect(localStorage.length).toBe(0);
});

test("absorbs a logout transport error after clearing state and navigating", async () => {
  authApi.me.mockResolvedValue({ user_id: "operator-2", name: "New Operator", role: "OPERATOR", permissions: ["seoops.view"] });
  authApi.logout.mockRejectedValue(new Error("network unavailable"));
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText("New Operator");
  localStorage.setItem("apiKey", "legacy");

  await screen.getByRole("button", { name: "logout" }).click();

  await expect(lastLogout).resolves.toBeUndefined();
  expect(localStorage.length).toBe(0);
  expect(navigateTo).toHaveBeenCalledWith("/seo-ops/login");
});

test("aborts the stale StrictMode identity request and ignores its late result", async () => {
  const first = deferred<{ user_id: string; name: string; role: string; permissions: string[] }>();
  const second = deferred<{ user_id: string; name: string; role: string; permissions: string[] }>();
  const signals: Array<AbortSignal | undefined> = [];
  authApi.me.mockImplementation((signal?: AbortSignal) => {
    signals.push(signal);
    return signals.length === 1 ? first.promise : second.promise;
  });

  render(<StrictMode><AuthProvider><Probe /></AuthProvider></StrictMode>);
  await vi.waitFor(() => expect(authApi.me).toHaveBeenCalledTimes(2));
  expect(signals[0]?.aborted).toBe(true);

  second.resolve({ user_id: "operator-current", name: "Current Operator", role: "OPERATOR", permissions: ["seoops.view"] });
  expect(await screen.findByText("Current Operator")).toBeInTheDocument();
  first.resolve({ user_id: "operator-stale", name: "Stale Operator", role: "OPERATOR", permissions: ["seoops.view"] });

  await vi.waitFor(() => expect(screen.getByText("Current Operator")).toBeInTheDocument());
  expect(screen.queryByText("Stale Operator")).not.toBeInTheDocument();
});

function Probe() {
  const { logout, user } = useAuth();
  return <><span>{user?.name}</span><button onClick={() => { lastLogout = logout(); }} type="button">logout</button></>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
