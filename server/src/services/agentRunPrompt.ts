import type { AgentRunStage } from "../domain/enums.js";
import type { Location, Merchant } from "../repos/types.js";
import type { Questionnaire } from "../repos/questionnaireTypes.js";

/** 阶段串联时内联上一阶段交付物的每段上限（字符）。core-ai trigger 只收文本，
 * 且触发时校验每日 token 配额——宁可少不可爆。 */
export const PRIOR_EXCERPT_LIMIT = 2400;

/** 截断交付物内容用于内联：整行保留，超限处标注截断。 */
export function excerptForPrompt(text: string, limit = PRIOR_EXCERPT_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, limit);
  const lastNewline = cut.lastIndexOf("\n");
  const kept = lastNewline > limit / 2 ? cut.slice(0, lastNewline) : cut;
  return `${kept}\n（…已截断，原文共 ${trimmed.length} 字符）`;
}

export interface StageRunPromptInput {
  stage: AgentRunStage;
  merchant: Merchant;
  location: Location | null;
  questionnaire: Questionnaire | null;
  /** 上游阶段交付物摘录（调用方已用 excerptForPrompt 截断）。 */
  priorExcerpts?: Partial<Record<AgentRunStage, string>>;
  goal?: string | null;
}

const RED_LINE =
  "你是本地 SEO 分析助手。这是一次只读分析任务：不得执行任何写入或变更操作（不改 GBP、不发内容、不提交表单）。";

const OUTPUT_RULES =
  "输出规范：使用中文；结论先行；数据未知时标注 unknown，不要编造数据。";

interface StageTemplate {
  /** 一句话说清楚要什么。 */
  directive: string;
  /** 期望附件（写进输出契约，附件是主交付物）。 */
  deliverables: string;
  /** 这个阶段依赖哪些上游阶段的交付物。 */
  priorStages: AgentRunStage[];
}

const TEMPLATES: Record<AgentRunStage, StageTemplate> = {
  KEYWORDS: {
    directive: "为这个地点生成本地 SEO 关键词库（含搜索意图分组与优先级）。",
    deliverables:
      "必须产出附件：关键词库 CSV（列：keyword, intent, priority, monthly_volume_estimate）。",
    priorStages: [],
  },
  AUDIT: {
    directive: "对这个地点做双审计：GBP 资料完整度与官网页面本地 SEO 现状，产出问题清单。",
    deliverables:
      "必须产出附件：问题清单 Markdown（每条：问题 / 依据 / 影响面）；如有截图一并附上。",
    priorStages: ["KEYWORDS"],
  },
  RANKING_BASELINE: {
    directive: "基于关键词库建立这个地点的排名基线（local pack 与 organic 两套）。",
    deliverables:
      "必须产出附件：排名基线 CSV（列：keyword, local_rank, organic_rank, checked_at）。",
    priorStages: ["KEYWORDS"],
  },
  PLAN: {
    directive: "基于审计问题清单与排名基线，生成优化 Plan：逐条可执行的建议清单。",
    deliverables:
      "必须产出附件：优化建议清单 Markdown，每条格式为「- [P0|P1|P2] 标题：具体动作」，便于逐条转为执行任务。",
    priorStages: ["AUDIT", "RANKING_BASELINE"],
  },
  REVIEW: {
    directive: "对照上轮优化 Plan 与最新排名基线，做效果复盘：哪些动作见效、哪些存疑、下轮建议。",
    deliverables:
      "必须产出附件：复盘报告 Markdown（结论 / 证据 / 下轮建议三段）。",
    priorStages: ["PLAN", "RANKING_BASELINE"],
  },
};

const STAGE_NAMES: Record<AgentRunStage, string> = {
  KEYWORDS: "关键词库",
  AUDIT: "审计问题清单",
  RANKING_BASELINE: "排名基线",
  PLAN: "优化 Plan",
  REVIEW: "复盘报告",
};

export function priorStagesFor(stage: AgentRunStage): AgentRunStage[] {
  return TEMPLATES[stage].priorStages;
}

function questionnaireBlock(questionnaire: Questionnaire | null): string | null {
  if (!questionnaire || questionnaire.status !== "FILLED" || !questionnaire.answers) {
    return null;
  }
  const lines: string[] = [];
  for (const item of questionnaire.questions) {
    const answer = questionnaire.answers[item.id];
    if (!answer || answer.trim() === "") continue;
    lines.push(`问：${item.question}`);
    lines.push(`答：${answer.trim()}`);
  }
  if (lines.length === 0) return null;
  return `商家问卷回收（商家自行填写，分析时优先以此为据）：\n${lines.join("\n")}`;
}

/** 聚焦请求：固定四段——只读红线 → 具体要什么 → 最小事实集 → 输出契约。
 * 不倾倒任务上下文；阶段串联靠上游交付物摘录内联。 */
export function buildStageRunMessage(input: StageRunPromptInput): string {
  const template = TEMPLATES[input.stage];
  const sections: string[] = [RED_LINE, template.directive];

  const facts: string[] = [`商户：${input.merchant.displayName}（${input.merchant.slug}）`];
  if (input.location) {
    facts.push(`地点：${input.location.displayName}`);
    const identities = Object.entries(input.location.externalIdentities ?? {});
    if (identities.length > 0) {
      facts.push(
        `外部标识：${identities.map(([key, value]) => `${key}=${value}`).join("，")}`,
      );
    }
  }
  sections.push(facts.join("\n"));

  const qBlock = questionnaireBlock(input.questionnaire);
  if (qBlock) sections.push(qBlock);

  for (const priorStage of template.priorStages) {
    const excerpt = input.priorExcerpts?.[priorStage];
    if (excerpt && excerpt.trim() !== "") {
      sections.push(`上游交付物——${STAGE_NAMES[priorStage]}：\n${excerpt.trim()}`);
    } else {
      sections.push(`上游交付物——${STAGE_NAMES[priorStage]}：（未提供，按 unknown 处理，不要编造）`);
    }
  }

  const goal = input.goal?.trim();
  if (goal) sections.push(`操作员补充目标：${goal}`);

  sections.push(`${template.deliverables}\n${OUTPUT_RULES}`);
  return sections.join("\n\n");
}
