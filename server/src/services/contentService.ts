import crypto from "node:crypto";
import type { Db } from "../db/connection.js";
import { badRequest, notFound } from "../errors.js";
import { getTask } from "../repos/taskRepo.js";
import {
  insertDraft,
  latestDraft,
  listDraftsByTask,
  type ContentDraft,
} from "../repos/draftRepo.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** 内容稿指纹：正文 + CTA + 媒体的稳定哈希。审批哈希锁定的 execution_spec
 * 引用 {draft_version, sha256}，改稿必然改哈希 → 批过的稿子改一个字就得重批。 */
export function draftSha256(input: {
  body: string;
  ctaType: string | null;
  ctaUrl: string | null;
  media: string[];
}): string {
  const canonical = JSON.stringify({
    body: input.body,
    cta_type: input.ctaType,
    cta_url: input.ctaUrl,
    media: [...input.media].sort(),
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface AddDraftInput {
  body: string;
  cta_type?: string;
  cta_url?: string;
  media?: string[];
  source: "AGENT_GENERATED" | "AGENT_REWRITE" | "HUMAN_EDIT";
  /** AGENT_REWRITE 必填：触发重写的人工反馈原文（留痕）。 */
  feedback?: string;
}

const DRAFT_SOURCES = new Set(["AGENT_GENERATED", "AGENT_REWRITE", "HUMAN_EDIT"]);

export async function addDraft(
  db: Db,
  taskId: string,
  input: AddDraftInput,
  actorId: string,
): Promise<ContentDraft> {
  if (typeof input.body !== "string" || input.body.trim() === "") {
    throw badRequest("body is required and must be a non-empty string");
  }
  if (!DRAFT_SOURCES.has(input.source)) {
    throw badRequest("source must be AGENT_GENERATED, AGENT_REWRITE or HUMAN_EDIT");
  }
  if (input.source === "AGENT_REWRITE" && !input.feedback?.trim()) {
    throw badRequest("feedback is required for AGENT_REWRITE drafts");
  }

  return db.withTransaction(async (tx) => {
    const task = await getTask(tx, taskId);
    if (!task) throw notFound(`task ${taskId} not found`);

    const last = await latestDraft(tx, taskId);
    const version = (last?.version ?? 0) + 1;
    const media = input.media ?? [];
    const draft: ContentDraft = {
      id: crypto.randomUUID(),
      taskId,
      version,
      body: input.body,
      ctaType: input.cta_type ?? null,
      ctaUrl: input.cta_url ?? null,
      media,
      source: input.source,
      feedback: input.feedback ?? null,
      sha256: draftSha256({
        body: input.body,
        ctaType: input.cta_type ?? null,
        ctaUrl: input.cta_url ?? null,
        media,
      }),
      createdBy: actorId,
      createdAt: nowIso(),
    };
    await insertDraft(tx, draft);
    return draft;
  });
}

export async function draftsView(db: Db, taskId: string): Promise<ContentDraft[]> {
  const task = await getTask(db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  return listDraftsByTask(db, taskId);
}

/** 定稿引用：写进任务修订版 execution_spec 的内容块。审批哈希由 taskService
 * 对整个 spec 计算，这里只负责给出稳定的引用结构。 */
export function specBlockForDraft(draft: ContentDraft): Record<string, unknown> {
  return {
    draft_version: draft.version,
    draft_sha256: draft.sha256,
    body: draft.body,
    cta_type: draft.ctaType,
    cta_url: draft.ctaUrl,
    media: draft.media,
  };
}
