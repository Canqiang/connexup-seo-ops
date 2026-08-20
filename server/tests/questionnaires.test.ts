import { describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { loadConfig } from "../src/config.js";

function makeApp() {
  return buildApp({
    ...loadConfig(),
    dbPath: ":memory:",
    coreAiBaseUrl: null,
    coreAiToken: null,
    agentRunAgentId: null,
  });
}

async function seedMerchant(app: ReturnType<typeof makeApp>["app"]) {
  return (
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "only-bear",
        display_name: "Only Bear Chicken & Boba",
        idempotency_key: "mk-1",
      },
    })
  ).json();
}

describe("questionnaire routes", () => {
  it("generates a DRAFT questionnaire from merchant + website, idempotent by key", async () => {
    const { app } = makeApp();
    const merchant = await seedMerchant(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
      payload: { website: "https://onlybear.example", idempotency_key: "qk-1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("DRAFT");
    expect(body.share_slug).toMatch(/^[0-9a-f]{8}$/);
    expect(body.questions).toHaveLength(12);
    expect(body.questions[0].question).toContain("Only Bear");
    expect(body.base_info.website).toBe("https://onlybear.example");

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
      payload: { website: "https://onlybear.example", idempotency_key: "qk-1" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(body.id);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
      payload: { idempotency_key: "qk-1" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("send marks SENT and resend bumps the counter; portfolio reports WAITING_MERCHANT", async () => {
    const { app } = makeApp();
    const merchant = await seedMerchant(app);
    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "qk-1" },
      })
    ).json();

    const sent = await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: "SENT", send_count: 1 });
    expect(sent.json().sent_at).toBeTruthy();

    const resent = await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });
    expect(resent.json()).toMatchObject({ status: "SENT", send_count: 2 });

    const portfolio = (
      await app.inject({ method: "GET", url: "/api/seo-ops/portfolio" })
    ).json();
    expect(portfolio.merchants[0].stage).toBe("QUESTIONNAIRE");
    expect(portfolio.merchants[0].exception.type).toBe("WAITING_MERCHANT");
    expect(portfolio.merchants[0].exception.waiting_days).toBe(0);
  });

  it("public form: fetch questions, submit with validation, then idempotent", async () => {
    const { app } = makeApp();
    const merchant = await seedMerchant(app);
    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "qk-1" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });

    const form = (
      await app.inject({
        method: "GET",
        url: `/api/public/questionnaire-forms/${questionnaire.share_slug}`,
      })
    ).json();
    expect(form.status).toBe("SENT");
    expect(form.merchant_name).toBe("Only Bear Chicken & Boba");
    expect(form.questions).toHaveLength(12);
    expect(form.answers).toBeUndefined();

    // DRAFT 不能提交（用独立商户，避免同毫秒多份问卷干扰 latest 推导）
    const merchant2 = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: { slug: "hana-bbq", display_name: "Hana Korean BBQ", idempotency_key: "mk-2" },
      })
    ).json();
    const draftSlug = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant2.id}/questionnaires`,
        payload: { idempotency_key: "qk-2" },
      })
    ).json().share_slug;
    const tooEarly = await app.inject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${draftSlug}/submissions`,
      payload: { answers: { q1: "奶茶店" } },
    });
    expect(tooEarly.statusCode).toBe(409);

    const missing = await app.inject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers: { q1: "奶茶店" } },
    });
    expect(missing.statusCode).toBe(400);

    const answers: Record<string, string> = {};
    for (const item of form.questions) {
      if (item.required) answers[item.id] = "答：奶茶与炸鸡";
    }
    const submitted = await app.inject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().status).toBe("FILLED");

    // 已填问卷不再下发题目
    const closed = (
      await app.inject({
        method: "GET",
        url: `/api/public/questionnaire-forms/${questionnaire.share_slug}`,
      })
    ).json();
    expect(closed.status).toBe("FILLED");
    expect(closed.questions).toBeUndefined();

    // 阶段推进到关键词
    const lifecycle = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/merchants/${merchant.id}/lifecycle`,
      })
    ).json();
    expect(lifecycle.stage).toBe("KEYWORDS");
    expect(lifecycle.exception.type).toBe("NONE");

    // 404s
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/public/questionnaire-forms/nope1234",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/seo-ops/merchants/no-such/lifecycle",
        })
      ).statusCode,
    ).toBe(404);
  });
});
