import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QuestionnaireFormPage } from "./QuestionnaireFormPage";

const formPayload = {
  status: "SENT",
  merchant_name: "Only Bear Chicken & Boba",
  base_info: { name: "Only Bear" },
  questions: [
    { id: "q1", question: "主营业务是什么？", hint: "例如：炸鸡、奶茶", required: true },
    { id: "q2", question: "营业时间？", required: false },
  ],
};

let submittedBody: unknown;

beforeEach(() => {
  submittedBody = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/public/questionnaire-forms/ab12cd34") return json(formPayload);
    if (path === "/api/public/questionnaire-forms/ab12cd34/submissions") {
      submittedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return json({ status: "FILLED" });
    }
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

test("merchant fills the public questionnaire and gets a thank-you", async () => {
  const user = userEvent.setup();
  renderPage("/q/ab12cd34");
  expect(await screen.findByRole("heading", { name: "帮我们更懂你的生意" })).toBeInTheDocument();
  expect(screen.getByText("Only Bear Chicken & Boba · 接入问卷")).toBeInTheDocument();

  await user.type(screen.getByLabelText(/主营业务是什么？/), "炸鸡和奶茶");
  await user.click(screen.getByRole("button", { name: "提交问卷" }));

  expect(await screen.findByRole("heading", { name: "已收到，感谢配合！" })).toBeInTheDocument();
  expect(submittedBody).toEqual({ answers: { q1: "炸鸡和奶茶" } });
});

test("already-filled form closes with the same thank-you", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ...formPayload, status: "FILLED", questions: undefined })));
  renderPage("/q/ab12cd34");
  expect(await screen.findByRole("heading", { name: "已收到，感谢配合！" })).toBeInTheDocument();
});

test("unknown slug shows a closed-link message, not a crash", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "not found" }), { status: 404 })));
  renderPage("/q/deadbeef");
  expect(await screen.findByRole("heading", { name: "链接无效或已关闭" })).toBeInTheDocument();
});

function renderPage(route: string) {
  return render(<MemoryRouter initialEntries={[route]}>
    <Routes><Route element={<QuestionnaireFormPage />} path="q/:slug" /></Routes>
  </MemoryRouter>);
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
