import crypto from "node:crypto";
import type { Db } from "../db/connection.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { requestFingerprint } from "../domain/hashing.js";
import {
  findQuestionnaireByIdempotencyKey,
  getQuestionnaire,
  getQuestionnaireByShareSlug,
  insertQuestionnaire,
  latestQuestionnaireByMerchant,
  updateQuestionnaire,
} from "../repos/questionnaireRepo.js";
import { getMerchant } from "../repos/merchantRepo.js";
import {
  requireIdempotencyKey,
  resolveIdempotentCreate,
  isUniqueViolation,
} from "./merchantService.js";
import type { Questionnaire, QuestionnaireItem } from "../repos/questionnaireTypes.js";

/** v1 问卷为本地模板生成（基于店名/官网拼装固定题组）。「基于官网内容定制」
 * 交给 core-ai 是下一步——存储与流转已按生成器可替换设计。 */
export function buildQuestionnaireTemplate(
  base: Record<string, string>,
): QuestionnaireItem[] {
  const name = base.name ?? "";
  const shortName = name.length > 24 ? `${name.slice(0, 24)}…` : name;
  return [
    { id: "q1", question: `用一句话描述「${shortName}」的主营业务`, required: true },
    { id: "q2", question: "列出主要产品/服务品类（菜品、套餐等，尽量完整）", required: true },
    { id: "q3", question: "顾客最常用来找到你们的服务或产品是什么？（例如：附近奶茶、炸鸡外送）", required: true },
    { id: "q4", question: "服务方式有哪些？（堂食 / 外送 / 自取 / 预订）", required: true },
    { id: "q5", question: "外送/服务覆盖范围（城镇或半径，例如：Mineola 周边 5 英里）", required: true },
    { id: "q6", question: "营业时间（平日 / 周末）", required: true },
    { id: "q7", question: "是否有多个门店或服务点？分别在哪里？", required: false },
    { id: "q8", question: "主要竞争对手或同类商家（本地 3 家以内）", required: false },
    { id: "q9", question: "希望优先被搜到的 3-5 个关键词或场景", required: true },
    { id: "q10", question: "目前 Google 商家资料（GBP）由谁管理？是否有权限？", required: true },
    { id: "q11", question: "官网地址与社交媒体链接（若有）", required: false, hint: base.website ? `已识别：${base.website}` : undefined },
    { id: "q12", question: "其他希望我们了解的信息（促销、季节性、特色）", required: false },
  ];
}

function nowIso(): string {
  return new Date().toISOString();
}

function shareSlug(): string {
  return crypto.randomBytes(4).toString("hex");
}

export interface CreateQuestionnaireInput {
  website?: string | null;
  idempotencyKey: string;
  createdBy?: string | null;
}

export function createQuestionnaire(
  db: Db,
  merchantId: string,
  input: CreateQuestionnaireInput,
): { entity: Questionnaire; replayed: boolean } {
  const key = requireIdempotencyKey(input.idempotencyKey, "idempotency_key");
  const merchant = getMerchant(db, merchantId);
  if (!merchant) throw notFound(`merchant ${merchantId} not found`);

  const baseInfo: Record<string, string> = { name: merchant.displayName };
  if (input.website && input.website.trim() !== "") {
    baseInfo.website = input.website.trim();
  }
  const fingerprint = requestFingerprint({
    merchant_id: merchantId,
    base_info: baseInfo,
  });

  return db.transaction(() => {
    const existing = findQuestionnaireByIdempotencyKey(db, key);
    const replay = resolveIdempotentCreate(existing, fingerprint);
    if (replay) return { entity: replay, replayed: true };

    const questionnaire: Questionnaire = {
      id: crypto.randomUUID(),
      merchantId,
      shareSlug: shareSlug(),
      status: "DRAFT",
      baseInfo,
      questions: buildQuestionnaireTemplate(baseInfo),
      answers: null,
      sendCount: 0,
      sentAt: null,
      lastSentAt: null,
      filledAt: null,
      creationIdempotencyKey: key,
      requestFingerprint: fingerprint,
      createdBy: input.createdBy ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    try {
      insertQuestionnaire(db, questionnaire);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict("share slug collision, retry", "SHARE_SLUG_COLLISION");
      }
      throw err;
    }
    return { entity: questionnaire, replayed: false };
  })();
}

/** 发放/重发：状态置 SENT 并滚动 sent 计数。外发动作本身（短信/邮件）不在
 * 系统内——这里只记录外发事实，供首页按天数排序与催填。 */
export function sendQuestionnaire(
  db: Db,
  questionnaireId: string,
): Questionnaire {
  const questionnaire = getQuestionnaire(db, questionnaireId);
  if (!questionnaire) {
    throw notFound(`questionnaire ${questionnaireId} not found`);
  }
  if (questionnaire.status === "FILLED") {
    throw conflict("questionnaire already filled", "ALREADY_FILLED");
  }
  const at = nowIso();
  const next: Questionnaire = {
    ...questionnaire,
    status: "SENT",
    sendCount: questionnaire.sendCount + 1,
    sentAt: questionnaire.sentAt ?? at,
    lastSentAt: at,
    updatedAt: at,
  };
  return updateQuestionnaire(db, next);
}

function requireAnswers(
  questions: QuestionnaireItem[],
  answers: Record<string, unknown>,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [id, value] of Object.entries(answers)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") cleaned[id] = trimmed.slice(0, 2000);
  }
  for (const item of questions) {
    if (item.required && !cleaned[item.id]) {
      throw badRequest(`answer for ${item.id} is required`);
    }
  }
  return cleaned;
}

/** 商家提交（公开回收端点调用）。重复提交幂等返回已填问卷。 */
export function submitQuestionnaire(
  db: Db,
  shareSlugValue: string,
  answers: Record<string, unknown>,
): Questionnaire {
  const questionnaire = getQuestionnaireByShareSlug(db, shareSlugValue);
  if (!questionnaire) {
    throw notFound(`questionnaire form ${shareSlugValue} not found`);
  }
  if (questionnaire.status === "FILLED") return questionnaire;
  if (questionnaire.status !== "SENT") {
    throw conflict("questionnaire is not open for submission", "NOT_OPEN");
  }
  const cleaned = requireAnswers(questionnaire.questions, answers);
  const at = nowIso();
  return updateQuestionnaire(db, {
    ...questionnaire,
    status: "FILLED",
    answers: cleaned,
    filledAt: at,
    updatedAt: at,
  });
}

export { getQuestionnaire, latestQuestionnaireByMerchant };
