# SEO Ops 鉴权与身份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `connexup-seo-ops` 内实现自有账号登录、服务端 Session、六个权限点、商户/地点访问范围和真实用户审计身份，彻底移除运行时代码中的 `local-dev` 身份占位。

**Architecture:** PostgreSQL 保存用户、密码散列和只存摘要的 Session；浏览器只持有 `HttpOnly`、`SameSite=Strict` Session Cookie，Core AI Token 继续只存在后端环境变量。Fastify 在路由入口解析身份并执行权限与商户范围校验，领域服务显式接收 `actorId` 记录审计；React 增加同源登录/退出页面，不再读取或持久化 API Key。公开问卷仍是唯一不需要内部账号的业务入口。

**Tech Stack:** TypeScript、Fastify 5、`@fastify/cookie`、Node.js `crypto.scrypt`/HMAC、PostgreSQL 16、Zod、React 19、React Router、Vitest

**Spec:** `docs/superpowers/specs/2026-08-20-seo-ops-execution-agent-design.md` §0、§4、§14、§15

## Global Constraints

- 唯一实施仓库是 `/Users/xander/git_repo/connexup-seo-ops`；不得修改、提交、推送或部署 `core-ai` 仓库。
- Core AI 只通过现有服务端 API 使用；`CORE_AI_TOKEN` 不得进入浏览器、Session、响应、日志或测试夹具。
- 权限点固定为 `seoops.view`、`seoops.manage`、`seoops.approve`、`seoops.execute`、`seoops.capability.manage`、`seoops.schedule.manage`，不使用 `*` 通配权限。
- 所有 `/api/seo-ops/*` 路由必须同时满足 Session、权限和商户范围；范围外资源返回 `404`，不泄露资源是否存在。
- 公开面仅包括 `/health-check`、`POST /api/auth/login`、`GET/POST /api/public/questionnaire-forms/:slug`；退出接口允许无 Session 幂等调用。
- Session Cookie 固定为 `seo_ops_session`，属性为 `HttpOnly; SameSite=Strict; Path=/`；UAT 必须设置 `Secure`。
- Session 原始 token 只返回到 Cookie；数据库只保存 `HMAC-SHA-256(SESSION_SECRET, token)`，固定过期，不把 Session 放进 `localStorage`。
- 密码使用 Node.js 内建 `scrypt`，每个密码独立 16-byte salt，校验使用 `timingSafeEqual`；不新增原生二进制密码依赖。
- 登录错误使用同一条 `401 INVALID_CREDENTIALS` 文案；连续 5 次失败锁定 15 分钟，避免泄露邮箱是否存在。
- `HUMAN` 与 `SERVICE` 身份分离；服务身份不能持有 `seoops.approve`、`seoops.execute`、`seoops.capability.manage` 或 `seoops.schedule.manage`。
- 审批、执行确认、成品应用、授权矩阵修改和自动周期开关最终都必须从 Session actor 写入真实 `user_id`；本阶段先覆盖现有审批及所有已有可变更路径，并为后续接口提供同一 `AuthActor` 合约。
- 现有 PostgreSQL schema-isolated 测试继续使用；每个任务先观察失败、再做最小实现、再跑相关测试。

---

## File and Interface Map

### Server auth domain

- Create `server/src/auth/types.ts`: 六权限目录、`SeoUser`、`AuthActor`、服务身份禁权规则。
- Create `server/src/auth/password.ts`: scrypt 编码、验证和常量时间 dummy 验证。
- Create `server/src/repos/userRepo.ts`: 用户读写、失败次数/锁定、登录成功回写。
- Create `server/src/repos/sessionRepo.ts`: Session 插入、按摘要读取、撤销和过期清理。
- Create `server/src/services/authService.ts`: 登录、Session 创建/解析/撤销、Cookie token 摘要。
- Create `server/src/auth/httpAuth.ts`: Fastify request actor、Cookie 解析、权限校验、商户/任务/run/附件范围校验。
- Create `server/src/routes/auth.ts`: `/api/auth/login`、`/api/auth/logout`、`/api/auth/me`。

### Existing server integration

- Modify `server/src/db/schema.ts`: `seo_users`、`seo_sessions` 及索引。
- Modify `server/src/config.ts`: `SESSION_SECRET`、TTL、Secure Cookie 配置和 fail-closed 校验。
- Modify `server/src/index.ts`: 注册 Cookie、auth hook/routes，再注册 SEO Ops routes。
- Modify `server/src/routes/seoOps.ts`: 删除固定身份，逐路由加权限与资源范围。
- Modify `server/src/services/queryService.ts`: portfolio/inbox/reviews/reports 强制按 actor 可见商户过滤。
- Modify `server/src/services/taskService.ts`: 所有审计记录显式接收 `actorId`。
- Modify `server/src/services/agentRunService.ts`: `triggeredBy`/`createdBy` 使用 Session actor。
- Modify `server/src/services/merchantService.ts`: 新商户自动包含创建者，校验 operator 用户。
- Modify `server/src/repos/merchantRepo.ts`: 支持显式替换遗留 `local-dev` operator membership。

### Test infrastructure

- Create `server/tests/helpers/authTest.ts`: 建用户、登录、自动注入 Session Cookie，同时保留 `rawInject` 验证 401/403。
- Create `server/tests/password.test.ts`: scrypt 正反例与非法编码。
- Create `server/tests/auth.test.ts`: 登录、退出、过期、锁定、Cookie 和 `/me`。
- Create `server/tests/authorization.test.ts`: 六权限、服务身份禁权、商户/地点/任务/run/附件范围。
- Modify existing server route tests: 使用真实测试 Session，不启用生产绕过开关。

### Frontend

- Create `src/features/auth/LoginPage.tsx`: 邮箱/密码登录、错误、safe `return_to`。
- Modify `src/api/authApi.ts`: `login`、`logout`、`me`。
- Modify `src/api/client.ts`: 只发送 same-origin Cookie；移除 Bearer/localStorage API Key。
- Modify `src/auth/AuthContext.tsx`: 不持久化身份；提供 `logout()`；文案从 Core AI 身份改为 SEO Ops 身份。
- Modify `src/auth/redirect.ts`: 自有 `/seo-ops/login` 与严格同源 return path。
- Modify `src/main.tsx`: 登录页、公开问卷、受保护应用三分流。
- Modify `src/app/AppShell.tsx`: 真实退出按钮；Copilot 可见性使用 `seoops.view`，不再依赖旧 `chat.use`。
- Modify `src/features/inbox/demoTasks.ts` 和 fixtures: 无 operator 时使用 `unassigned`，删除 `local-dev`。

### Bootstrap and docs

- Create `server/scripts/bootstrap-user.ts`: 从环境变量读取密码，幂等创建/更新内部用户，可显式认领遗留 operator membership。
- Modify `server/package.json`: `user:bootstrap` 命令与 `@fastify/cookie` 依赖。
- Modify `server/.env.example`: Session 与 bootstrap 环境变量，不包含真实值。
- Modify `README.md`: 自有登录、本地 bootstrap、Cookie、UAT Secret 和验证命令。

## Locked Permission and Route Matrix

| 路由类别 | 权限 | 范围规则 |
| --- | --- | --- |
| config、portfolio、inbox、reviews、reports、task/event、stage-run GET、agent-run GET、deliverable download、lifecycle、ranking | `seoops.view` | 只返回 actor 位于 `operator_user_ids` 的商户；子资源继承商户范围 |
| merchant/location/task/revision/evidence/conversation/questionnaire 创建与发送、stage-run trigger/cancel、manual deliverable | `seoops.manage` | 新商户自动加入 actor；其他写入要求既有商户范围 |
| approval preview、approval decision | `seoops.approve` | task 所属商户范围；decision 的 `actor_id` 是 Session user id |
| Phase 3 执行确认/requeue | `seoops.execute` | 本计划只锁定 helper 和测试合约，不提前创建执行 endpoint |
| Phase 3 资产授权矩阵 | `seoops.capability.manage` | 本计划只锁定 helper 和服务身份拒绝合约 |
| Phase 5 周期开关 | `seoops.schedule.manage` | 本计划只锁定 helper 和服务身份拒绝合约 |

---

### Task 1: Add auth schema, types, password hashing, and repositories

**Files:**
- Create: `server/src/auth/types.ts`
- Create: `server/src/auth/password.ts`
- Create: `server/src/repos/userRepo.ts`
- Create: `server/src/repos/sessionRepo.ts`
- Modify: `server/src/db/schema.ts`
- Modify: `server/tests/migrate.test.ts`
- Create: `server/tests/password.test.ts`
- Create: `server/tests/authRepo.test.ts`

**Interfaces:**
- Produces: `SEO_PERMISSIONS`, `SeoPermission`, `IdentityType`, `SeoUser`, `AuthActor`, `assertAllowedIdentityPermissions()`.
- Produces: `hashPassword(password: string): Promise<string>` and `verifyPassword(password: string, encoded: string): Promise<boolean>`.
- Produces: user/session repository functions consumed by Task 2.

- [ ] **Step 1: Write migration and password tests that fail before the tables/modules exist**

```ts
expect(tableNames).toContain("seo_users");
expect(tableNames).toContain("seo_sessions");

const encoded = await hashPassword("Correct horse battery staple 42!");
expect(encoded).toMatch(/^scrypt\$16384\$8\$1\$/);
expect(await verifyPassword("Correct horse battery staple 42!", encoded)).toBe(true);
expect(await verifyPassword("wrong password", encoded)).toBe(false);
expect(await verifyPassword("anything", "broken")).toBe(false);
```

- [ ] **Step 2: Run the focused tests and observe module/table failures**

Run: `npm --prefix server test -- tests/migrate.test.ts tests/password.test.ts tests/authRepo.test.ts`

Expected: FAIL because auth modules and tables do not exist.

- [ ] **Step 3: Add exact auth types and service-identity prohibition**

```ts
export const SEO_PERMISSIONS = [
  "seoops.view",
  "seoops.manage",
  "seoops.approve",
  "seoops.execute",
  "seoops.capability.manage",
  "seoops.schedule.manage",
] as const;
export type SeoPermission = typeof SEO_PERMISSIONS[number];
export type IdentityType = "HUMAN" | "SERVICE";

export interface AuthActor {
  userId: string;
  email: string;
  name: string;
  role: string;
  identityType: IdentityType;
  permissions: SeoPermission[];
}

const SERVICE_FORBIDDEN = new Set<SeoPermission>([
  "seoops.approve", "seoops.execute",
  "seoops.capability.manage", "seoops.schedule.manage",
]);
```

`assertAllowedIdentityPermissions("SERVICE", permissions)` must throw `400` when any forbidden permission is present and must reject unknown strings or `*`.

- [ ] **Step 4: Add PostgreSQL user/session tables and indexes**

```sql
CREATE TABLE IF NOT EXISTS seo_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  password_hash TEXT,
  status TEXT NOT NULL,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

```sql
CREATE TABLE IF NOT EXISTS seo_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
)
```

Add indexes `idx_users_status`, `idx_sessions_user`, and `idx_sessions_expiry`.

- [ ] **Step 5: Implement scrypt encoding without logging password material**

Use encoding `scrypt$16384$8$1$<base64url salt>$<base64url derivedKey>`, a 16-byte random salt, a 64-byte key, `maxmem: 64 * 1024 * 1024`, and `timingSafeEqual`. Reject passwords outside 12–128 Unicode code points before hashing; `verifyPassword` returns `false` for malformed encodings.

- [ ] **Step 6: Implement repositories with explicit row mappers**

```ts
export async function getUserByEmail(db: Db, email: string): Promise<SeoUser | null>;
export async function getUserById(db: Db, id: string): Promise<SeoUser | null>;
export async function upsertUser(db: Db, user: SeoUser): Promise<SeoUser>;
export async function recordLoginFailure(db: Db, id: string, lockedUntil: string | null): Promise<void>;
export async function recordLoginSuccess(db: Db, id: string, at: string): Promise<void>;

export async function insertSession(db: Db, session: SeoSession): Promise<void>;
export async function getActiveSessionByHash(db: Db, tokenHash: string, nowIso: string): Promise<SeoSession | null>;
export async function revokeSessionByHash(db: Db, tokenHash: string, at: string): Promise<void>;
export async function deleteExpiredSessions(db: Db, nowIso: string): Promise<number>;
```

Normalize emails with `trim().toLocaleLowerCase("en-US")`; parse permissions through the exact catalog rather than unchecked casts.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `npm --prefix server test -- tests/migrate.test.ts tests/password.test.ts tests/authRepo.test.ts`

Run: `npm --prefix server run typecheck`

Expected: all focused tests PASS; typecheck exits `0`.

- [ ] **Step 8: Commit the auth persistence foundation**

```bash
git add server/src/auth server/src/repos/userRepo.ts server/src/repos/sessionRepo.ts server/src/db/schema.ts server/tests/migrate.test.ts server/tests/password.test.ts server/tests/authRepo.test.ts
git commit -m "feat(auth): add user and session persistence"
```

---

### Task 2: Implement login, server-side Session, Cookie, and auth routes

**Files:**
- Create: `server/src/services/authService.ts`
- Create: `server/src/auth/httpAuth.ts`
- Create: `server/src/routes/auth.ts`
- Create: `server/tests/auth.test.ts`
- Modify: `server/src/config.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/routes/seoOps.ts`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`

**Interfaces:**
- Consumes: Task 1 `SeoUser`, repositories, `verifyPassword()`.
- Produces: `createSessionToken()`, `resolveActorFromToken()`, `requireActor()`, `requirePermission()` and authenticated `/api/auth/*` routes.

- [ ] **Step 1: Add failing endpoint tests for unauthenticated, valid, invalid, expired, logout, and lockout flows**

```ts
expect((await rawInject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
expect((await rawInject({ method: "POST", url: "/api/auth/login", payload: validLogin })).headers["set-cookie"]).toContain("seo_ops_session=");
expect((await rawInject({ method: "POST", url: "/api/auth/login", payload: badLogin })).json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
expect((await rawInject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBe(204);
```

Assert the Cookie contains `HttpOnly`, `SameSite=Strict`, `Path=/`, and contains `Secure` only when `sessionCookieSecure=true`. After five invalid attempts, a correct password before `locked_until` still returns the same generic 401.

- [ ] **Step 2: Run the auth test and observe the fixed `/me` stub failure**

Run: `npm --prefix server test -- tests/auth.test.ts`

Expected: FAIL because `/api/auth/me` still returns `local-dev` and login/logout do not exist.

- [ ] **Step 3: Add fail-closed Session configuration**

```ts
export interface ServerConfig {
  sessionSecret: string;
  sessionTtlHours: number;
  sessionCookieSecure: boolean;
}
```

`SESSION_SECRET` must be at least 32 characters. `loadConfig()` may use a fixed test-only value only when `NODE_ENV === "test"`; every non-test startup without a valid secret throws before listening. Defaults: `SESSION_TTL_HOURS=12`, `SESSION_COOKIE_SECURE=false` locally; UAT sets it to `true`.

- [ ] **Step 4: Install and register Cookie parsing before SEO Ops routes**

Run: `npm --prefix server install @fastify/cookie@^11`

In `buildApp()`, `await app.register(cookie)` before auth/SEO routes. Add `request.actor: AuthActor | null` through Fastify module augmentation and an `onRequest` hook that resolves the cookie without logging it.

- [ ] **Step 5: Implement token hashing and credential authentication**

```ts
export function sessionTokenHash(secret: string, rawToken: string): string {
  return createHmac("sha256", secret).update(rawToken).digest("hex");
}

export async function login(
  db: Db,
  input: { email: string; password: string },
  config: Pick<ServerConfig, "sessionSecret" | "sessionTtlHours">,
  now: Date,
): Promise<{ actor: AuthActor; rawToken: string; expiresAt: string }>;
```

Unknown email must run `verifyPassword()` against a module-level dummy scrypt hash before returning `INVALID_CREDENTIALS`. A disabled, service, locked, unknown, or wrong-password identity receives the same external response.

- [ ] **Step 6: Replace the fixed identity with three auth routes**

```ts
POST /api/auth/login  { email, password } -> 200 AuthenticatedUser + Set-Cookie
POST /api/auth/logout -> 204 + expired Set-Cookie
GET  /api/auth/me     -> 200 AuthenticatedUser or 401 AUTH_REQUIRED
```

The wire user remains `{user_id,name,role,permissions}`; email and password hash are never returned. Remove `ACTOR_ID` import and the fixed `/api/auth/me` route from `seoOps.ts`.

- [ ] **Step 7: Run auth tests and typecheck**

Run: `npm --prefix server test -- tests/auth.test.ts`

Run: `npm --prefix server run typecheck`

Expected: endpoint tests PASS and typecheck exits `0`.

- [ ] **Step 8: Commit Session authentication**

```bash
git add server/package.json server/package-lock.json server/src/config.ts server/src/index.ts server/src/auth/httpAuth.ts server/src/routes/auth.ts server/src/routes/seoOps.ts server/src/services/authService.ts server/tests/auth.test.ts
git commit -m "feat(auth): add cookie session login"
```

---

### Task 3: Protect routes and enforce merchant/resource scope

**Files:**
- Create: `server/tests/helpers/authTest.ts`
- Create: `server/tests/authorization.test.ts`
- Modify: `server/src/auth/httpAuth.ts`
- Modify: `server/src/routes/seoOps.ts`
- Modify: `server/src/services/queryService.ts`
- Modify: `server/src/services/merchantService.ts`
- Modify: `server/src/repos/merchantRepo.ts`
- Modify: all existing server route test files that call protected endpoints

**Interfaces:**
- Consumes: Task 2 request actor and permission catalog.
- Produces: `requireMerchantAccess()`, `requireTaskAccess()`, `requireRunAccess()`, `requireDeliverableAccess()` and actor-scoped projections.

- [ ] **Step 1: Build a real authenticated test harness before turning on route guards**

```ts
export async function createAuthenticatedTestApp(options?: {
  permissions?: SeoPermission[];
  identityType?: IdentityType;
}): Promise<{
  app: FastifyInstance;
  db: Db;
  actor: AuthActor;
  rawInject: FastifyInstance["inject"];
}>;
```

The helper creates a real hashed HUMAN user, calls `/api/auth/login`, captures only the `name=value` Cookie, and wraps `app.inject()` to add that Cookie. `rawInject` bypasses only the wrapper, not production auth, so 401/403 tests exercise the real hook.

- [ ] **Step 2: Convert existing route tests to the authenticated helper**

Replace per-file `createTestDb()`/`buildApp()` setup with `createAuthenticatedTestApp()`. Keep `connection.test.ts`, pure domain tests, and public questionnaire submission tests independent. No production `AUTH_DISABLED` or test actor switch is allowed.

- [ ] **Step 3: Add failing permission and isolation tests**

Create two users and two merchants. Assert:

```ts
expect((await userA.rawInject({ method: "GET", url: "/api/seo-ops/portfolio", headers: { cookie: userA.cookie } })).json().merchants).toHaveLength(1);
expect((await userA.inject({ method: "GET", url: `/api/seo-ops/tasks/${merchantBTask}` })).statusCode).toBe(404);
expect((await viewOnly.inject({ method: "POST", url: "/api/seo-ops/tasks", payload })).statusCode).toBe(403);
expect((await serviceWithManage.inject({ method: "POST", url: approvalUrl, payload: decision })).statusCode).toBe(403);
```

Cover task, location, stage run, agent run, questionnaire send and deliverable download inherited scope. Cover all six permission strings and the service-identity forbidden set.

- [ ] **Step 4: Run authorization tests and observe unscoped data/unguarded writes**

Run: `npm --prefix server test -- tests/authorization.test.ts`

Expected: FAIL because current routes do not enforce permissions or merchant scope.

- [ ] **Step 5: Add reusable permission and scope guards**

```ts
export function requirePermission(request: FastifyRequest, code: SeoPermission): AuthActor;
export async function requireMerchantAccess(db: Db, actor: AuthActor, merchantId: string): Promise<Merchant>;
export async function requireTaskAccess(db: Db, actor: AuthActor, taskId: string): Promise<Task>;
export async function requireRunAccess(db: Db, actor: AuthActor, runId: string): Promise<AgentRun>;
export async function requireDeliverableAccess(db: Db, actor: AuthActor, deliverableId: string): Promise<RunDeliverable>;
```

`requirePermission` returns `401 AUTH_REQUIRED` without actor and `403 FORBIDDEN` without the exact permission. Resource scope helpers return the same not-found response for absent and inaccessible resources.

- [ ] **Step 6: Apply the locked permission matrix to every SEO Ops route**

Use route-level `preHandler` or a first-line guard; do not rely on frontend visibility. Public questionnaire routes remain outside these guards. Approval preview and decision require `seoops.approve`, not `seoops.manage`.

- [ ] **Step 7: Scope all collection projections in the service layer**

Change signatures to require actor identity:

```ts
portfolio(db: Db, actorUserId: string, now?: Date): Promise<PortfolioResponseWire>
inbox(db: Db, query: InboxQuery, actorUserId: string): Promise<PageResult<TaskSummaryWire>>
reviews(db: Db, query: ReviewQuery, actorUserId: string): Promise<PageResult<Record<string, unknown>>>
reports(db: Db, query: ReportQuery, actorUserId: string, now?: Date): Promise<PageResult<Record<string, unknown>>>
```

Filter merchants first through `merchant.operatorUserIds.includes(actorUserId)`, then filter every task/run/deliverable projection through those merchant IDs. A query parameter naming a hidden merchant returns an empty collection; a direct resource path returns 404.

- [ ] **Step 8: Make merchant creation self-scoping and validate operators**

When `operator_user_ids` is absent, store `[actor.userId]`; when present, deduplicate `[actor.userId, ...requested]`. Reject unknown, disabled, or SERVICE operator IDs with `400 INVALID_OPERATOR`. This prevents creation of an immediately invisible merchant.

- [ ] **Step 9: Run authorization plus the full server suite**

Run: `npm --prefix server test -- tests/authorization.test.ts`

Run: `npm --prefix server test`

Expected: authorization tests and all migrated server tests PASS.

- [ ] **Step 10: Commit protected route and scope enforcement**

```bash
git add server/src/auth/httpAuth.ts server/src/routes/seoOps.ts server/src/services/queryService.ts server/src/services/merchantService.ts server/src/repos/merchantRepo.ts server/tests
git commit -m "feat(auth): enforce permissions and merchant scope"
```

---

### Task 4: Propagate real actor identity through all existing mutations

**Files:**
- Modify: `server/src/services/taskService.ts`
- Modify: `server/src/services/agentRunService.ts`
- Modify: `server/src/routes/seoOps.ts`
- Modify: `server/tests/taskService.test.ts`
- Modify: `server/tests/agentRuns.test.ts`
- Modify: `server/tests/queryService.test.ts`
- Modify: `server/tests/questionnaires.test.ts`
- Modify: `server/tests/merchantService.test.ts`
- Modify: `src/features/inbox/demoTasks.ts`
- Modify: `src/features/inbox/demoTasks.test.ts`
- Modify: `src/test/fixtures.ts`

**Interfaces:**
- Consumes: Task 2 `AuthActor` and Task 3 route guards.
- Produces: actor-aware task events, revisions, evidence, conversation links, approvals, merchant/location/questionnaire creation and stage runs.

- [ ] **Step 1: Add failing audit assertions using a non-placeholder user id**

```ts
expect(created.created_by).toBe(actor.userId);
expect(revised.revisions.at(-1).created_by).toBe(actor.userId);
expect(withEvidence.evidence_refs.at(-1).created_by).toBe(actor.userId);
expect(approved.approval_decisions.at(-1).actor_id).toBe(actor.userId);
expect(run.triggered_by).toBe(actor.userId);
expect(events.every((event) => event.actor_id !== "local-dev")).toBe(true);
```

- [ ] **Step 2: Run focused mutation tests and observe `local-dev` failures**

Run: `npm --prefix server test -- tests/taskService.test.ts tests/agentRuns.test.ts tests/merchantService.test.ts tests/questionnaires.test.ts`

Expected: FAIL on current fixed actor fields.

- [ ] **Step 3: Remove `ACTOR_ID` and make actor explicit in task service signatures**

```ts
createTask(db, input, actorId)
createRevision(db, taskId, input, actorId)
appendEvidence(db, taskId, input, actorId)
linkConversation(db, taskId, input, actorId)
approvalDecision(db, taskId, input, actorId)
buildEvent(type, taskRevision, stateVersion, actorId, options)
```

Every nested revision/evidence/decision/event record uses the passed actor. Idempotent replay returns the original audit identity and does not overwrite it with the replaying caller.

- [ ] **Step 4: Thread actor through route-owned mutations**

Use `const actor = requirePermission(request, code)` once per handler. Pass `actor.userId` to merchant/location/questionnaire/task/stage-run service inputs. Extend `triggerStageRun(..., actorId)` so both `triggeredBy` and `createdBy` are the actor.

- [ ] **Step 5: Remove runtime placeholders from frontend demo data**

Replace fallback owner `local-dev` with `unassigned`; update display copy to `未分配`. Replace fixture `triggered_by: "local-dev"` with `triggered_by: "user-1"`.

- [ ] **Step 6: Prove the placeholder is absent from runtime code**

Run: `rg -n 'local-dev|ACTOR_ID' server/src src`

Expected: no output. Historical migration documentation and old Git commits are not rewritten.

- [ ] **Step 7: Run focused and full tests**

Run: `npm --prefix server test`

Run: `npm run test:run`

Expected: server and frontend suites PASS.

- [ ] **Step 8: Commit real identity propagation**

```bash
git add server/src/services/taskService.ts server/src/services/agentRunService.ts server/src/routes/seoOps.ts server/tests src/features/inbox/demoTasks.ts src/features/inbox/demoTasks.test.ts src/test/fixtures.ts
git commit -m "feat(auth): record real operator identities"
```

---

### Task 5: Replace API-key frontend auth with self-hosted login and logout

**Files:**
- Create: `src/features/auth/LoginPage.tsx`
- Create: `src/features/auth/LoginPage.test.tsx`
- Modify: `src/api/authApi.ts`
- Modify: `src/api/client.ts`
- Modify: `src/api/client.test.ts`
- Modify: `src/api/types.ts`
- Modify: `src/auth/AuthContext.tsx`
- Modify: `src/auth/redirect.ts`
- Modify: `src/auth/redirect.test.ts`
- Modify: `src/main.tsx`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: Task 2 `/api/auth/login|logout|me` Cookie contract.
- Produces: `LoginPage`, `authApi.login/logout`, `AuthContext.logout`, safe self-hosted login redirect.

- [ ] **Step 1: Add failing client and login-page tests**

```ts
expect(fetch).toHaveBeenCalledWith("/api/seo-ops/portfolio", expect.objectContaining({
  credentials: "same-origin",
  headers: expect.not.objectContaining({ Authorization: expect.anything() }),
}));

expect(buildLoginUrl("/seo-ops/tasks/task-1?tab=evidence"))
  .toBe("/seo-ops/login?return_to=%2Fseo-ops%2Ftasks%2Ftask-1%3Ftab%3Devidence");
expect(safeReturnTo("https://evil.example/x")).toBe("/seo-ops/");
```

Login-page tests submit email/password, show generic invalid-credential copy, never persist the password, and navigate only to a safe `/seo-ops/...` return path.

- [ ] **Step 2: Run focused frontend tests and observe Bearer/redirect failures**

Run: `npm run test:run -- src/api/client.test.ts src/auth/redirect.test.ts src/features/auth/LoginPage.test.tsx`

Expected: FAIL because current client reads `apiKey` and redirects to external `/login`.

- [ ] **Step 3: Make the API client Cookie-only**

```ts
export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  options: { redirectOn401?: boolean } = {},
): Promise<T>;
```

Always set `credentials: "same-origin"`; never read `apiKey`, user identity, role, or permissions from `localStorage`; on 401 redirect unless `redirectOn401 === false` (login itself uses false).

- [ ] **Step 4: Add auth API and safe redirects**

```ts
login: (email: string, password: string) => requestJson<AuthenticatedUser>(
  "/api/auth/login",
  { method: "POST", body: JSON.stringify({ email, password }) },
  { redirectOn401: false },
),
logout: () => requestJson<void>("/api/auth/logout", { method: "POST" }, { redirectOn401: false }),
```

`safeReturnTo()` accepts only strings beginning exactly with `/seo-ops/` and rejects `//`, encoded external schemes, control characters and `/seo-ops/login` loops.

- [ ] **Step 5: Implement the internal login page**

Render Connexup SEO Ops branding, email/password inputs, submit state and generic error. After successful login call `window.location.assign(safeReturnTo(searchParams.get("return_to")))`. The page must not mention Core AI credentials.

- [ ] **Step 6: Update app routing and AuthContext**

`main.tsx` branches in this order: `/seo-ops/q/:slug` public questionnaire, `/seo-ops/login` LoginPage, otherwise `AuthProvider + App`. AuthContext stores actor only in React memory and exposes `logout()` which POSTs logout then navigates to `/seo-ops/login`.

- [ ] **Step 7: Add logout UI and align permission copy**

Add an accessible `退出登录` button in `AppShell`. Change Copilot user gating from legacy `chat.use` to `seoops.view` plus `copilot_enabled`; keep Copilot read-only. Update loading copy to `正在确认 SEO Ops 身份…`.

- [ ] **Step 8: Run frontend tests and production build**

Run: `npm run test:run`

Run: `npm run build`

Expected: all frontend tests PASS and Vite production build exits `0`.

- [ ] **Step 9: Commit self-hosted frontend auth**

```bash
git add src
git commit -m "feat(auth): add internal login and logout UI"
```

---

### Task 6: Add safe user bootstrap and legacy operator claiming

**Files:**
- Create: `server/scripts/bootstrap-user.ts`
- Create: `server/tests/bootstrapUser.test.ts`
- Modify: `server/src/repos/merchantRepo.ts`
- Modify: `server/package.json`
- Modify: `server/.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 user/password repository and Task 3 merchant operator update.
- Produces: `npm --prefix server run user:bootstrap -- --email <email> --name <name> --role <role> --permissions <csv> [--claim-local-dev-merchants]`.

- [ ] **Step 1: Add failing bootstrap argument and idempotence tests**

Test exported `runBootstrap(args, env, db)` directly. Assert missing `SEO_OPS_BOOTSTRAP_PASSWORD` fails before DB mutation; a second identical run updates the existing user instead of inserting a duplicate; `--claim-local-dev-merchants` replaces only the exact `local-dev` membership and preserves every other operator ID.

- [ ] **Step 2: Run the bootstrap test and observe the missing module failure**

Run: `npm --prefix server test -- tests/bootstrapUser.test.ts`

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement secret-safe bootstrap behavior**

```ts
const password = env.SEO_OPS_BOOTSTRAP_PASSWORD;
if (!password) throw new Error("SEO_OPS_BOOTSTRAP_PASSWORD is required");
```

Do not accept password on argv, do not print it, and do not print password/session hashes. Validate permissions against the exact catalog and call `assertAllowedIdentityPermissions`. Print only user id, normalized email, role, permission codes and claimed merchant count.

- [ ] **Step 4: Add explicit legacy membership claiming**

```ts
export async function replaceMerchantOperatorId(
  db: Db,
  fromUserId: string,
  toUserId: string,
): Promise<number>;
```

The repository reads each affected JSON operator list, replaces exact IDs, deduplicates, and updates `updated_at` in one transaction. The bootstrap CLI invokes it only with the explicit flag.

- [ ] **Step 5: Document local and UAT setup**

Add these non-secret variables to `.env.example`:

```dotenv
SESSION_SECRET=
SESSION_TTL_HOURS=12
SESSION_COOKIE_SECURE=false
SEO_OPS_BOOTSTRAP_PASSWORD=
```

README local flow: start PG, set a 32+ character Session secret, export bootstrap password in the current shell, run the CLI, unset the password, start server, log in at `/seo-ops/login`. UAT contract: `DATABASE_URL`, `SESSION_SECRET`, `CORE_AI_TOKEN`, and bootstrap password are Kubernetes Secrets; `SESSION_COOKIE_SECURE=true`; no secret is committed or printed.

- [ ] **Step 6: Run bootstrap, server tests and typecheck**

Run: `npm --prefix server test -- tests/bootstrapUser.test.ts`

Run: `npm --prefix server test`

Run: `npm --prefix server run typecheck`

Expected: all commands exit `0`.

- [ ] **Step 7: Commit bootstrap and documentation**

```bash
git add server/scripts/bootstrap-user.ts server/tests/bootstrapUser.test.ts server/src/repos/merchantRepo.ts server/package.json server/.env.example README.md
git commit -m "feat(auth): add internal user bootstrap"
```

---

### Task 7: Run the phase gate and close the roadmap item

**Files:**
- Modify: `docs/superpowers/plans/2026-08-20-execution-agent-roadmap.md`
- Modify: `docs/superpowers/plans/2026-08-24-auth-identity.md`

**Interfaces:**
- Consumes: Tasks 1–6 complete.
- Produces: a verified auth phase ready for the separate Task Execution Domain plan.

- [ ] **Step 1: Run repository-wide secret and placeholder scans**

Run: `rg -n 'local-dev|ACTOR_ID|localStorage\.getItem\("apiKey"\)|Authorization.*Bearer' server/src src`

Expected: no runtime identity placeholder, frontend bearer injection, or Core AI token exposure. The server-side `coreAiClient.ts` Authorization header is the sole expected Bearer use; inspect it manually rather than deleting it.

Run: `rg -n 'CORE_AI_TOKEN=.+|SESSION_SECRET=.+|SEO_OPS_BOOTSTRAP_PASSWORD=.+' --glob '!package-lock.json' .`

Expected: examples have empty values and no credential material is present.

- [ ] **Step 2: Run the complete quality gate**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm run test:run
npm run build
git diff --check
```

Expected: server tests, server typecheck, frontend tests, build and diff check all exit `0`.

- [ ] **Step 3: Perform a local authenticated smoke test**

Start PostgreSQL and the server with non-secret local values, bootstrap one HUMAN user, then verify:

```text
GET  /api/auth/me without Cookie -> 401 AUTH_REQUIRED
POST /api/auth/login             -> 200 + HttpOnly Cookie
GET  /api/auth/me with Cookie    -> 200 real user_id
GET  /api/seo-ops/portfolio      -> only assigned merchants
POST /api/auth/logout            -> 204
GET  /api/auth/me after logout   -> 401 AUTH_REQUIRED
```

Open `/seo-ops/login`, sign in, deep-link to one accessible merchant/task, verify a hidden merchant cannot be opened, then log out. Do not use or expose Core AI Token during this smoke test.

- [ ] **Step 4: Mark the roadmap phase complete only after all evidence is green**

Change the auth row status from `已写` to `已完成` and check every completed checkbox in this plan. If any gate is red, leave the row `实施中` and record the exact failing command beneath that task.

- [ ] **Step 5: Commit phase completion**

```bash
git add docs/superpowers/plans/2026-08-20-execution-agent-roadmap.md docs/superpowers/plans/2026-08-24-auth-identity.md
git commit -m "docs(auth): record completed phase gate"
```

## Self-Review Record

- Spec coverage: §4 login/Session、六权限、商户范围、真实身份、Core AI Token 后端边界、服务身份禁权均映射到 Tasks 1–6；§14 Session Secret/UAT Secure Cookie 映射到 Tasks 2/6；§15 鉴权测试映射到 Tasks 2–5。
- Scope boundary: 计划没有 `core-ai` 文件、migration、endpoint、登录或部署修改项；旧 8 月 17 日 Core AI 后端计划不作为执行输入。
- Type consistency: `AuthActor.userId` 在 route guard、query scope、task audit 和 Agent Run audit 中保持一致；前端 wire 字段仍为 `user_id`。
- Deferred intentionally: `seoops.execute`、`seoops.capability.manage`、`seoops.schedule.manage` 的实际业务 endpoints 分别属于路线图 Phase 3/5；本阶段实现权限目录、服务身份拒绝和可复用 guard，不提前创建空接口。
- Placeholder scan: 本计划不包含未定义实现项；Phase 3/5 延后内容有明确所属计划和当前交付合约。
