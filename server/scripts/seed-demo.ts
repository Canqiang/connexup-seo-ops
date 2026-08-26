/** 样本世界种子：3 商户 + 能力矩阵 + 周期配置 + agent 绑定 + 建议批次 +
 * Post 双门链路，最后跑一轮 scheduler + mock worker，让每个界面都有活数据。
 *
 * 幂等：全部走固定 idempotency key / upsert，重复执行不产生重复数据。
 * 用法：npm run seed:demo   （DATABASE_URL 缺省用本地 dev 库）
 */
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { SEO_PERMISSIONS } from "../src/auth/types.js";
import { upsertUser, getUserById } from "../src/repos/userRepo.js";
import { createMerchant, createLocation } from "../src/services/merchantService.js";
import { findMerchantBySlug, listMerchants } from "../src/repos/merchantRepo.js";
import { listLocations } from "../src/repos/locationRepo.js";
import {
  deriveCapabilityStatus,
  getCapability,
  getAgentBinding,
  upsertAgentBinding,
  upsertCapability,
  upsertCycleConfig,
  insertStyleProfile,
  latestStyleProfile,
} from "../src/repos/settingsRepo.js";
import { createProposalBatch } from "../src/services/proposalService.js";
import { appendEvidence, approvalDecision, createTask } from "../src/services/taskService.js";
import { addDraft } from "../src/services/contentService.js";
import { findTaskByIdempotencyKey, getTask } from "../src/repos/taskRepo.js";
import { schedulerTick } from "../src/services/schedulerService.js";
import { ExecutionWorker } from "../src/services/executionWorker.js";

/** 与单人模式的合成管理员同 id：关掉单人模式改用真登录时，商户归属仍成立。 */
const ACTOR = "single-user-admin";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev";

const randomUUID = () => crypto.randomUUID();

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL);
  await migrate(db);
  const now = new Date();
  const log = (msg: string) => console.log(`[seed] ${msg}`);

  // 种子管理员（ACTIVE HUMAN，商户 operator 校验要求真实用户行）
  if (!(await getUserById(db, ACTOR))) {
    const ts = new Date().toISOString();
    await upsertUser(db, {
      id: ACTOR, email: "admin@local", displayName: "本地管理员", role: "ADMIN",
      identityType: "HUMAN", permissions: [...SEO_PERMISSIONS], passwordHash: null,
      status: "ACTIVE", failedLoginCount: 0, lockedUntil: null, lastLoginAt: null,
      createdAt: ts, updatedAt: ts,
    });
    log("种子管理员就绪（single-user-admin）");
  }

  // ---------- 商户 + 地点 ----------
  const world = [
    {
      slug: "uws-bistro", name: "UWS Bistro", tz: "America/New_York",
      location: { slug: "uws", name: "Upper West Side", gbp: "locations/uws-bistro-001" },
      gbpAuthorized: true,
      voice: { tone: "warm-neighborhood", address: "we", banned: ["cheap", "#1"], example: "Fresh from our kitchen on the Upper West Side." },
    },
    {
      slug: "keke-braised", name: "可可小卤", tz: "America/New_York",
      location: { slug: "flushing", name: "Flushing", gbp: "locations/keke-braised-001" },
      gbpAuthorized: false, // 演示 BLOCKED：已接入未授权
      voice: { tone: "亲切家常", address: "咱们", banned: ["最便宜"], example: "老卤慢炖，今天也在法拉盛等你。" },
    },
    {
      slug: "only-bear", name: "Only Bear Chicken & Boba", tz: "America/New_York",
      location: { slug: "mineola", name: "Mineola", gbp: "locations/only-bear-001" },
      gbpAuthorized: true,
      voice: { tone: "playful", address: "we", banned: ["greasy"], example: "Crispy chicken. Real boba. No shortcuts." },
    },
  ];

  const ids = new Map<string, { merchantId: string; locationId: string; gbp: string }>();
  for (const w of world) {
    let merchant = await findMerchantBySlug(db, w.slug);
    if (!merchant) {
      merchant = (await createMerchant(db, {
        slug: w.slug, displayName: w.name, tags: ["demo"],
        operatorUserIds: [], idempotencyKey: `seed-m-${w.slug}`,
        createdBy: ACTOR, actorUserId: ACTOR,
      })).entity;
    }
    const existingLocations = (await listLocations(db)).filter((l) => l.merchantId === merchant!.id);
    let location = existingLocations.find((l) => l.slug === w.location.slug);
    if (!location) {
      location = (await createLocation(db, merchant.id, {
        slug: w.location.slug, displayName: w.location.name, timezone: w.tz,
        externalIdentities: { google_business: w.location.gbp },
        readinessStatus: "READY", missingRequirements: [],
        idempotencyKey: `seed-l-${w.slug}`, createdBy: ACTOR,
      })).entity;
    }
    ids.set(w.slug, { merchantId: merchant.id, locationId: location.id, gbp: w.location.gbp });

    // 能力矩阵：GBP 写入（可可小卤演示 BLOCKED）
    const existing = await getCapability(db, merchant.id, "GBP_WRITE");
    const ts = new Date().toISOString();
    await upsertCapability(db, {
      id: existing?.id ?? randomUUID(), merchantId: merchant.id, asset: "GBP",
      capability: "GBP_WRITE", externalRef: w.location.gbp,
      techConnected: true, merchantAuthorized: w.gbpAuthorized,
      status: deriveCapabilityStatus(true, w.gbpAuthorized),
      verifiedAt: w.gbpAuthorized ? ts : null, verifiedBy: w.gbpAuthorized ? ACTOR : null,
      note: w.gbpAuthorized ? null : "商户 OAuth 授权待完成", createdAt: existing?.createdAt ?? ts, updatedAt: ts,
    });

    // 周期配置：post 日=今天（演示当天就能看到调度产物）；月度快照关闭避免日期依赖
    await upsertCycleConfig(db, {
      merchantId: merchant.id, snapshotDay: null, postWeekday: now.getUTCDay(),
      postPerWeek: 1, reviewWindowDays: 7, auditIntervalDays: 30,
      enabled: true, updatedBy: ACTOR, createdAt: ts, updatedAt: ts,
    });

    // 风格档案 v1（来自品牌档案 voice 的演示形态）
    if (!(await latestStyleProfile(db, merchant.id))) {
      await insertStyleProfile(db, {
        id: randomUUID(), merchantId: merchant.id, version: 1,
        voice: w.voice, updatedBy: ACTOR, createdAt: ts,
      });
    }
    log(`商户就绪：${w.name}`);
  }

  // ---------- Agent 绑定（占位 id；#38 在 UAT 建好后替换真 id） ----------
  const BINDING_KEYS = [
    "PLANNER", "QUESTIONNAIRE", "KEYWORD_RESEARCH", "KEYWORD_WEEKLY", "AUDIT",
    "REPORT", "PLAN", "GBP_POST", "GBP_UPDATE", "WEBSITE_CONTENT", "REVIEW", "GBP_EXECUTION",
  ];
  const ts = new Date().toISOString();
  let seededBindings = 0;
  for (const key of BINDING_KEYS) {
    // 已有绑定不覆盖：真 agent id 回填后重跑种子不能把它打回占位。
    const existingBinding = await getAgentBinding(db, key);
    if (existingBinding) continue;
    await upsertAgentBinding(db, {
      taskType: key, agentId: `pending-uat-${key.toLowerCase()}`,
      agentLabel: `${key}（占位，待 UAT 建 agent 后回填）`, publishedRef: null,
      updatedBy: ACTOR, createdAt: ts, updatedAt: ts,
    });
    seededBindings += 1;
  }
  log(`agent 绑定占位 ×${seededBindings}（已存在 ${BINDING_KEYS.length - seededBindings} 个未动）`);

  const uws = ids.get("uws-bistro")!;
  const onlyBear = ids.get("only-bear")!;

  // ---------- 建议批次（待判定演示：2 好 1 坏） ----------
  await createProposalBatch(db, {
    merchant_id: uws.merchantId,
    origin: "PLANNER",
    trigger_reason: "月度快照：brunch 词簇排名下滑 3 位",
    snapshot_note: "local pack 均值 6.2 → 9.1；'french brunch uws' 掉出首页",
    idempotency_key: "seed-batch-uws-1",
    items: [
      {
        title: "重跑表现报告（含 LF 扫描）核实下滑范围",
        task_type: "REPORT", execution_mode: "READ_ONLY",
        priority: "HIGH", impact: "MEDIUM",
        acceptance_criteria: "报告落盘，含 brunch 词簇的网格排名对比",
        execution_spec: JSON.stringify({ cycle: "ADHOC_REPORT", focus: "brunch-cluster" }),
      },
      {
        title: "补发一篇 brunch 主题 GBP Post（本周窗口）",
        task_type: "GBP_POST", execution_mode: "AUTO_WRITE",
        location_id: uws.locationId, priority: "MEDIUM", impact: "MEDIUM",
        acceptance_criteria: "Post 发布且 7 天内核验可见",
        execution_spec: JSON.stringify({ locationName: uws.gbp, post_type: "UPDATE", keyword_cluster: "french brunch uws" }),
        required_evidence_types: ["CONTENT_DRAFT"],
      },
      {
        title: "（演示坏建议）依赖不存在的条目",
        task_type: "REPORT", execution_mode: "READ_ONLY",
        depends_on: [9], priority: "LOW", impact: "LOW",
        execution_spec: JSON.stringify({ x: 1 }),
      },
    ],
  }, ACTOR).catch((err) => log(`建议批次已存在或失败：${err instanceof Error ? err.message : err}`));
  log("建议批次就绪（UWS ×3）");

  // ---------- Only Bear：一条 Post 任务走到门 2 前（待执行确认演示） ----------
  const postKey = "seed-task-onlybear-post1";
  let post = await findTaskByIdempotencyKey(db, postKey);
  if (!post) {
    post = (await createTask(db, {
      merchant_id: onlyBear.merchantId, location_id: onlyBear.locationId,
      definition: {
        title: "GBP Post：新品奶茶上线（周窗口）",
        task_type: "GBP_POST", source: "CYCLE", priority: "MEDIUM", impact: "MEDIUM",
        execution_spec: JSON.stringify({ locationName: onlyBear.gbp, post_type: "UPDATE", keyword_cluster: "boba mineola" }),
        required_evidence_types: ["CONTENT_DRAFT"], execution_mode: "AUTO_WRITE",
      },
      idempotency_key: postKey,
    }, ACTOR)).task;
    await addDraft(db, post.id, {
      body: "New this week: Brown Sugar Boba meets our signature crispy chicken combo. Mineola, come thirsty.",
      source: "AGENT_GENERATED",
    }, ACTOR);
    const v2 = await addDraft(db, post.id, {
      body: "Brown Sugar Boba just landed. Pair it with the crispy chicken combo — this week at our Mineola shop.",
      source: "AGENT_REWRITE", feedback: "语气再口语一点，把门店放句尾",
    }, ACTOR);
    const afterDraft = await getTask(db, post.id);
    if (!afterDraft) throw new Error("post task vanished mid-seed");
    const finalized = await appendEvidence(db, post.id, {
      type: "CONTENT_DRAFT", source_ref: `draft:${post.id}:v${v2.version}`, sha256: v2.sha256,
      captured_at: new Date().toISOString(), verification_status: "VERIFIED",
      requirement_key: "CONTENT_DRAFT",
      expected_state_version: afterDraft.stateVersion, idempotency_key: `${postKey}-final`,
    }, ACTOR);
    await approvalDecision(db, post.id, {
      decision: "APPROVE", task_revision: finalized.task.taskRevision,
      execution_spec_hash: finalized.task.executionSpecHash,
      expected_state_version: finalized.task.stateVersion,
      idempotency_key: `${postKey}-approve`,
    }, ACTOR);
    log("Only Bear Post 任务已批准，停在门 2 前");
  }

  // ---------- 跑一轮周期调度 + mock 执行（Ⓐ级任务直接 DONE） ----------
  const tick = await schedulerTick({ db, systemActor: "system:scheduler", log: (m, e) => console.warn(m, e ?? "") });
  log(`调度：新建 ${tick.created.length} · 自动派发 ${tick.dispatched}`);
  const worker = new ExecutionWorker({ db, client: null, mockMode: true });
  await worker.pollOnce();
  await worker.pollOnce(); // 第二轮结算 autoDispatch 的新 attempt
  log("mock worker 已结算（Ⓐ级只读任务归档 DONE）");

  const merchants = await listMerchants(db);
  log(`完成：${merchants.length} 商户在库`);
  await db.close();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exitCode = 1;
});
