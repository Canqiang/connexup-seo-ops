/** 演示预置：Only Bear 第二条 Post 走到派发后人为制造「结果待查」
 * （模拟 core-ai 超时 → OUTCOME_UNKNOWN → 商户执行链冻结），
 * 用于演示查证工作台。幂等：重复执行直接复用同名任务。
 * 用法：npx tsx scripts/demo-stage-unknown.ts */
import { createDb } from "../src/db/connection.js";
import { findMerchantBySlug } from "../src/repos/merchantRepo.js";
import { listLocations } from "../src/repos/locationRepo.js";
import { appendEvidence, approvalDecision, createTask } from "../src/services/taskService.js";
import { addDraft } from "../src/services/contentService.js";
import { confirmExecution, settleAttemptUnknown } from "../src/services/executionService.js";
import { listAttemptsByTask } from "../src/repos/executionRepo.js";
import { getTask } from "../src/repos/taskRepo.js";

const ACTOR = "single-user-admin";

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev");
  const merchant = await findMerchantBySlug(db, "only-bear");
  if (!merchant) throw new Error("only-bear missing — run seed:demo first");
  const location = (await listLocations(db)).find((l) => l.merchantId === merchant.id);
  if (!location) throw new Error("location missing");

  const { task } = await createTask(db, {
    merchant_id: merchant.id, location_id: location.id,
    definition: {
      title: "GBP Post：周末炸鸡套餐限时价",
      task_type: "GBP_POST", source: "CYCLE", priority: "MEDIUM", impact: "MEDIUM",
      execution_spec: JSON.stringify({ locationName: "locations/only-bear-001", post_type: "OFFER", keyword_cluster: "fried chicken deal mineola" }),
      required_evidence_types: ["CONTENT_DRAFT"], execution_mode: "AUTO_WRITE",
    },
    idempotency_key: "demo-frozen-post",
  }, ACTOR);

  const draft = await addDraft(db, task.id, {
    body: "Weekend only: crispy chicken combo at a special price. Grab it before Sunday closes.",
    source: "AGENT_GENERATED",
  }, ACTOR);
  const t1 = await getTask(db, task.id);
  const fin = await appendEvidence(db, task.id, {
    type: "CONTENT_DRAFT", source_ref: `draft:${task.id}:v${draft.version}`, sha256: draft.sha256,
    captured_at: new Date().toISOString(), verification_status: "VERIFIED", requirement_key: "CONTENT_DRAFT",
    expected_state_version: t1!.stateVersion, idempotency_key: "demo-frozen-final",
  }, ACTOR);
  const approved = await approvalDecision(db, task.id, {
    decision: "APPROVE", task_revision: fin.task.taskRevision,
    execution_spec_hash: fin.task.executionSpecHash,
    expected_state_version: fin.task.stateVersion, idempotency_key: "demo-frozen-approve",
  }, ACTOR);
  await confirmExecution(db, task.id, {
    expected_state_version: approved.task.stateVersion, idempotency_key: "demo-frozen-confirm",
  }, ACTOR);
  const [attempt] = await listAttemptsByTask(db, task.id);
  await settleAttemptUnknown(db, attempt!, "core-ai run TIMEOUT：发布请求已发出，未收到终态回执", "system:executor");
  const final = await getTask(db, task.id);
  console.log("staged:", final!.title, final!.status, "attempt", attempt!.probeRef);
  await db.close();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
