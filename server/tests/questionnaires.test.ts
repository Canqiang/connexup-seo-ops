import { afterEach, describe, expect, it } from "vitest";
import { getQuestionnaire } from "../src/repos/questionnaireRepo.js";
import { PASSWORD, createAuthenticatedTestApp, createTestUser } from "./helpers/authTest.js";

/** Fresh app + fresh schema-isolated postgres db per test. */
async function makeApp() {
  return createAuthenticatedTestApp();
}

async function seedMerchant(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
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
  let app: Awaited<ReturnType<typeof makeApp>>["app"];
  afterEach(() => app.close());

  it("generates a DRAFT questionnaire from merchant + website, idempotent by key", async () => {
    ({ app } = await makeApp());
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
    ({ app } = await makeApp());
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

  it("records the actor who sent and resent a questionnaire", async () => {
    const authenticated = await makeApp();
    app = authenticated.app;
    const secondActor = await createTestUser(authenticated.db, {
      email: "resend-operator@example.test",
      displayName: "Resend operator",
    });
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: {
          slug: "audit-actors",
          display_name: "Audit Actors",
          operator_user_ids: [secondActor.id],
          idempotency_key: "actor-merchant",
        },
      })
    ).json();
    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "actor-questionnaire" },
      })
    ).json();

    const firstSend = await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });
    expect(firstSend.statusCode).toBe(200);
    expect(firstSend.json().last_sent_by).toBe(authenticated.actor.userId);

    const login = await authenticated.rawInject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: secondActor.email, password: PASSWORD },
    });
    const setCookie = login.headers["set-cookie"];
    const resendCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";", 1)[0]!;
    const resend = await authenticated.rawInject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
      headers: { cookie: resendCookie },
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json().last_sent_by).toBe(secondActor.id);
    expect((await getQuestionnaire(authenticated.db, questionnaire.id))!.lastSentBy).toBe(secondActor.id);
  });

  it("atomically records concurrent sends from both scoped operators", async () => {
    const authenticated = await makeApp();
    app = authenticated.app;
    const secondActor = await createTestUser(authenticated.db, {
      email: "concurrent-send-operator@example.test",
      displayName: "Concurrent send operator",
    });
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: {
          slug: "concurrent-sends",
          display_name: "Concurrent Sends",
          operator_user_ids: [secondActor.id],
          idempotency_key: "concurrent-merchant",
        },
      })
    ).json();
    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "concurrent-questionnaire" },
      })
    ).json();
    const url = `/api/seo-ops/questionnaires/${questionnaire.id}/send`;
    const seeded = await authenticated.rawInject({
      method: "POST",
      url,
      headers: { cookie: authenticated.cookie },
    });
    expect(seeded.statusCode).toBe(200);
    const startingCount = seeded.json().send_count;
    const login = await authenticated.rawInject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: secondActor.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const secondCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";", 1)[0]!;

    // Make both real requests read the original row before either old-style
    // read-modify-write update returns. The production atomic update remains
    // correct under the same row-lock contention.
    await authenticated.db.exec(`
      CREATE FUNCTION delay_questionnaire_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER delay_questionnaire_update
      BEFORE UPDATE ON seo_merchant_questionnaires
      FOR EACH ROW EXECUTE FUNCTION delay_questionnaire_update();
    `);

    const [first, second] = await Promise.all([
      authenticated.rawInject({ method: "POST", url, headers: { cookie: authenticated.cookie } }),
      authenticated.rawInject({ method: "POST", url, headers: { cookie: secondCookie } }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const responses = [
      { actorId: authenticated.actor.userId, body: first.json() },
      { actorId: secondActor.id, body: second.json() },
    ];
    expect(responses.map(({ body }) => body.send_count).sort()).toEqual([
      startingCount + 1,
      startingCount + 2,
    ]);

    const stored = (await getQuestionnaire(authenticated.db, questionnaire.id))!;
    expect(stored.sendCount).toBe(startingCount + 2);
    const latest = responses.find(({ body }) => body.send_count === startingCount + 2)!;
    expect(stored.lastSentBy).toBe(latest.actorId);
    expect(stored.lastSentBy).toBe(latest.body.last_sent_by);

    const answers = Object.fromEntries(
      questionnaire.questions
        .filter((item: { required: boolean }) => item.required)
        .map((item: { id: string }) => [item.id, "已确认"]),
    );
    const submitted = await authenticated.rawInject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers },
    });
    expect(submitted.statusCode).toBe(201);
    const rejected = await authenticated.rawInject({
      method: "POST",
      url,
      headers: { cookie: authenticated.cookie },
    });
    expect(rejected.statusCode).toBe(409);
    expect((await getQuestionnaire(authenticated.db, questionnaire.id))!.sendCount).toBe(startingCount + 2);
  });

  it("preserves a committed send when a public submission read the prior SENT snapshot", async () => {
    const authenticated = await makeApp();
    app = authenticated.app;
    const sendingActor = await createTestUser(authenticated.db, {
      email: "send-before-submit@example.test",
      displayName: "Send before submit operator",
    });
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: {
          slug: "send-before-submit",
          display_name: "Send Before Submit",
          operator_user_ids: [sendingActor.id],
          idempotency_key: "send-before-submit-merchant",
        },
      })
    ).json();
    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "send-before-submit-questionnaire" },
      })
    ).json();
    const firstSend = await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });
    expect(firstSend.statusCode).toBe(200);

    const login = await authenticated.rawInject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: sendingActor.email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const sendingCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";", 1)[0]!;

    await authenticated.db.exec(`
      CREATE FUNCTION hold_second_send_lock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'SENT' AND NEW.send_count = 2 THEN
          PERFORM pg_advisory_xact_lock(41231, 90817);
          PERFORM pg_sleep(0.3);
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER hold_second_send_lock
      BEFORE UPDATE ON seo_merchant_questionnaires
      FOR EACH ROW EXECUTE FUNCTION hold_second_send_lock();
    `);

    const sendUrl = `/api/seo-ops/questionnaires/${questionnaire.id}/send`;
    const send = authenticated.rawInject({
      method: "POST",
      url: sendUrl,
      headers: { cookie: sendingCookie },
    });
    let sendLockHeld = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const lock = await authenticated.db.one<{ held: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 41231 AND objid = 90817
        ) AS held`,
      );
      if (lock?.held) {
        sendLockHeld = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sendLockHeld).toBe(true);

    const answers = Object.fromEntries(
      questionnaire.questions
        .filter((item: { required: boolean }) => item.required)
        .map((item: { id: string }) => [item.id, "已确认"]),
    );
    const submission = authenticated.rawInject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers },
    });
    const sent = await send;
    expect(sent.statusCode).toBe(200);
    const submitted = await submission;
    expect(submitted.statusCode).toBe(201);

    const stored = (await getQuestionnaire(authenticated.db, questionnaire.id))!;
    expect(stored.status).toBe("FILLED");
    expect(stored.sendCount).toBe(sent.json().send_count);
    expect(stored.lastSentBy).toBe(sent.json().last_sent_by);
    expect(stored.lastSentAt).toBe(sent.json().last_sent_at);
  });

  it("rejects a send after public submission commits without changing send audit", async () => {
    const authenticated = await makeApp();
    app = authenticated.app;
    const merchant = await seedMerchant(app);
    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "submission-before-send" },
      })
    ).json();
    const sent = await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });
    expect(sent.statusCode).toBe(200);
    const answers = Object.fromEntries(
      questionnaire.questions
        .filter((item: { required: boolean }) => item.required)
        .map((item: { id: string }) => [item.id, "已确认"]),
    );
    const submission = await authenticated.rawInject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers },
    });
    expect(submission.statusCode).toBe(201);
    const beforeRejectedSend = (await getQuestionnaire(authenticated.db, questionnaire.id))!;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });
    expect(rejected.statusCode).toBe(409);
    const afterRejectedSend = (await getQuestionnaire(authenticated.db, questionnaire.id))!;
    expect(afterRejectedSend.sendCount).toBe(beforeRejectedSend.sendCount);
    expect(afterRejectedSend.lastSentBy).toBe(beforeRejectedSend.lastSentBy);
    expect(afterRejectedSend.lastSentAt).toBe(beforeRejectedSend.lastSentAt);
  });

  it("public form: fetch questions, submit with validation, then idempotent", async () => {
    const authenticated = await makeApp();
    app = authenticated.app;
    const { rawInject } = authenticated;
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
      await rawInject({
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
    const tooEarly = await rawInject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${draftSlug}/submissions`,
      payload: { answers: { q1: "奶茶店" } },
    });
    expect(tooEarly.statusCode).toBe(409);

    const missing = await rawInject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers: { q1: "奶茶店" } },
    });
    expect(missing.statusCode).toBe(400);

    const answers: Record<string, string> = {};
    for (const item of form.questions) {
      if (item.required) answers[item.id] = "答：奶茶与炸鸡";
    }
    const submitted = await rawInject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers },
    });
    // 修正后的约定：首次提交 201 Created，幂等重放才是 200
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json().status).toBe("FILLED");

    // 已填问卷不再下发题目
    const closed = (
      await rawInject({
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
        await rawInject({
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
