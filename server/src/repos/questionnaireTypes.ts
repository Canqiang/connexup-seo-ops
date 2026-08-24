import type { QuestionnaireStatus } from "../domain/enums.js";

/** 商家接入问卷题目（v1 为本地模板生成；接 core-ai 定制生成时只改
 * buildQuestionnaireTemplate，存储与流转不变）。 */
export interface QuestionnaireItem {
  id: string;
  question: string;
  hint?: string;
  required: boolean;
}

export interface Questionnaire {
  id: string;
  merchantId: string;
  shareSlug: string;
  status: QuestionnaireStatus;
  baseInfo: Record<string, string>;
  questions: QuestionnaireItem[];
  answers: Record<string, string> | null;
  sendCount: number;
  sentAt: string | null;
  lastSentAt: string | null;
  lastSentBy: string | null;
  filledAt: string | null;
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
