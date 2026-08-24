import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LoginPage } from "./LoginPage";

const navigateTo = vi.hoisted(() => vi.fn());
const redirectToLogin = vi.hoisted(() => vi.fn());

vi.mock("../../auth/redirect", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../auth/redirect")>();
  return { ...original, navigateTo, redirectToLogin };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  navigateTo.mockReset();
  redirectToLogin.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

test("submits credentials without persisting the password and returns to a safe route", async () => {
  const user = userEvent.setup();
  const fetchMock = loginFetch();
  vi.stubGlobal("fetch", fetchMock);

  render(<MemoryRouter initialEntries={["/login?return_to=/seo-ops/tasks/task-1?tab=evidence"]}><LoginPage /></MemoryRouter>);
  await user.type(await screen.findByLabelText("工作邮箱"), "operator@example.com");
  await user.type(screen.getByLabelText("密码"), "a-temporary-password");
  await user.click(screen.getByRole("button", { name: "登录 SEO Ops" }));

  expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({
    method: "POST", credentials: "same-origin", body: JSON.stringify({ email: "operator@example.com", password: "a-temporary-password" }),
  }));
  expect(localStorage.getItem("password")).toBeNull();
  expect(sessionStorage.getItem("password")).toBeNull();
  expect(navigateTo).toHaveBeenCalledWith("/seo-ops/tasks/task-1?tab=evidence");
});

test("uses the SEO Ops home for an unsafe return target", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", loginFetch());

  render(<MemoryRouter initialEntries={["/login?return_to=https://evil.example/x"]}><LoginPage /></MemoryRouter>);
  await user.type(await screen.findByLabelText("工作邮箱"), "operator@example.com");
  await user.type(screen.getByLabelText("密码"), "a-temporary-password");
  await user.click(screen.getByRole("button", { name: "登录 SEO Ops" }));

  expect(navigateTo).toHaveBeenCalledWith("/seo-ops/");
});

test("shows a generic credential error", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/auth/me") return unauthorized();
    return new Response(JSON.stringify({ message: "wrong password" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }));

  render(<MemoryRouter><LoginPage /></MemoryRouter>);
  await user.type(await screen.findByLabelText("工作邮箱"), "operator@example.com");
  await user.type(screen.getByLabelText("密码"), "wrong-password");
  await user.click(screen.getByRole("button", { name: "登录 SEO Ops" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("邮箱或密码不正确，请重试。");
  expect(screen.queryByText("wrong password")).not.toBeInTheDocument();
});

test("shows the credential form without redirecting when the session probe is unauthorized", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unauthorized()));

  render(<MemoryRouter><LoginPage /></MemoryRouter>);

  expect(await screen.findByLabelText("工作邮箱")).toBeInTheDocument();
  expect(redirectToLogin).not.toHaveBeenCalled();
});

test("skips the credential form when the server reports authentication is disabled", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
    user_id: "local-dev",
    name: "Local Operator",
    role: "seo_lead",
    permissions: ["seoops.view"],
    auth_disabled: true,
  })));

  render(<MemoryRouter initialEntries={["/login?return_to=/seo-ops/inbox"]}><LoginPage /></MemoryRouter>);

  await vi.waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/seo-ops/inbox"));
  expect(screen.queryByLabelText("工作邮箱")).not.toBeInTheDocument();
});

function loginFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/auth/me") return unauthorized();
    return json({
      user_id: "operator-1", name: "Seo Operator", role: "OPERATOR", permissions: ["seoops.view"],
    });
  });
}

function unauthorized() {
  return new Response(JSON.stringify({ message: "authentication required", error_code: "AUTH_REQUIRED" }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
