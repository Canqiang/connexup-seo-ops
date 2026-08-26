import type { MerchantSummary, SeoOpsPageRequest, TaskSummary } from "../../api/types";
import { taskStatusLabel } from "../../app/statusCopy";

export interface DemoPostOccurrence {
  publish_at: string;
  topic: string;
  intent: string;
  primary_keyword_cluster: string;
  supporting_keywords: string[];
  cta: string;
  status: "待授权" | "待审批" | "待撰稿" | "待排期";
}

export interface DemoTask extends TaskSummary {
  demo: true;
  progress_status?: "COMPLETED" | "IN_PROGRESS" | "WAITING";
  cadence: string;
  trigger: string;
  objective: string;
  inputs: string[];
  deliverable: string;
  success_criteria: string[];
  next_step: string;
  dependencies: string[];
  post_occurrence?: DemoPostOccurrence;
}

export function isDemoTask(task: TaskSummary | DemoTask): task is DemoTask {
  return "demo" in task && task.demo === true;
}

export function taskStatusView(task: TaskSummary | DemoTask): { className: string; label: string } {
  if (isDemoTask(task) && task.progress_status) {
    return {
      COMPLETED: { className: "completed", label: "已完成" },
      IN_PROGRESS: { className: "in-progress", label: "进行中" },
      WAITING: { className: "waiting", label: "待开始" },
    }[task.progress_status];
  }
  return { className: task.status.toLocaleLowerCase(), label: taskStatusLabel(task.status) };
}

type DemoTemplate = Omit<DemoTask,
  "id" | "merchant_id" | "merchant_name" | "location_id" | "location_name" |
  "owner_id" | "due_at" | "updated_at" | "task_revision" | "state_version" | "demo"
> & { due_in_days: number };

const STANDARD_TASKS: DemoTemplate[] = [
  {
    title: "GBP 内容日历｜每周四发布",
    task_type: "GBP_POST",
    priority: "HIGH",
    impact: "HIGH",
    status: "BLOCKED",
    evidence_state: "NONE",
    cadence: "每周四",
    trigger: "周度内容日历",
    objective: "滚动规划未来 4 周的 GBP Post：每个时间点固定一个主题、一个主要搜索意图 / 关键词簇和一个 CTA。",
    inputs: ["本周活动与主推产品", "门店照片", "本地关键词与 CTA"],
    deliverable: "GBP Post 文案、配图、发布预览与发布后链接",
    success_criteria: ["标题与正文自然覆盖目标词", "商户信息和 CTA 准确", "发布前有可核对预览"],
    next_step: "等待 GBP 资产授权后生成发布预览",
    dependencies: ["GBP_WRITE 授权"],
    due_in_days: 1,
  },
  {
    title: "复盘分析｜上周 SEO 动作与指标变化",
    task_type: "PERFORMANCE_REVIEW",
    priority: "MEDIUM",
    impact: "HIGH",
    status: "NEEDS_INPUT",
    evidence_state: "PARTIAL",
    cadence: "每周一",
    trigger: "动作完成后 7 天",
    objective: "把已执行动作、前后指标与竞争解释放进同一证据链，判断哪些变化值得继续验证。",
    inputs: ["上周动作日志", "GBP Insights / GSC 快照", "排名与转化基线"],
    deliverable: "事实、相关性、竞争解释与下一轮验证建议",
    success_criteria: ["不把时间相关写成因果", "每个结论引用证据", "给出下一次可验证动作"],
    next_step: "等待最新 GBP / GSC 指标快照",
    dependencies: ["上周动作证据", "后测指标"],
    due_in_days: 0,
  },
  {
    title: "重新 Audit｜GBP + 官网本地页",
    task_type: "RE_AUDIT",
    priority: "HIGH",
    impact: "HIGH",
    status: "NEEDS_INPUT",
    evidence_state: "NONE",
    cadence: "每 4 周 / 重大变更后",
    trigger: "本轮执行完成",
    objective: "重新检查 GBP 资料完整度、官网本地页与技术问题，形成可与上轮对照的新问题清单。",
    inputs: ["当前 GBP 公共资料", "官网本地页", "上轮 Audit 与变更记录"],
    deliverable: "只读 Re-audit 报告、差异清单与证据附件",
    success_criteria: ["每个地点单独审计", "注明公共数据覆盖范围", "区分新增、已解决与仍存在问题"],
    next_step: "准备只读 Audit 输入与上轮差异基线",
    dependencies: ["本轮动作完成", "上轮 Audit"],
    due_in_days: 3,
  },
  {
    title: "重新生成 Plan｜未来 30 天执行方案",
    task_type: "PLAN_REFRESH",
    priority: "MEDIUM",
    impact: "HIGH",
    status: "NEEDS_INPUT",
    evidence_state: "NONE",
    cadence: "每轮 Audit 后",
    trigger: "Re-audit 与排名基线完成",
    objective: "基于最新问题、排名与上轮复盘，重排未来 30 天的执行优先级、依赖和验收证据。",
    inputs: ["最新 Re-audit", "最新排名基线", "上轮复盘结论"],
    deliverable: "可转成执行任务的 30 天 Local SEO Plan",
    success_criteria: ["每项有优先级和负责人", "外部写入动作单独标记审批", "每项定义验收证据"],
    next_step: "等待重新 Audit 与新排名基线完成",
    dependencies: ["重新 Audit", "排名基线", "复盘结论"],
    due_in_days: 4,
  },
];

const UWS_OVERRIDES: Partial<DemoTemplate>[] = [
  {
    status: "READY_FOR_APPROVAL",
    evidence_state: "VERIFIED",
    next_step: "审核本周文案与配图，确认后进入人工发布",
    dependencies: [],
  },
  {},
  {},
  {},
];

const KEKE_TASKS: DemoTemplate[] = [
  {
    title: "生成并发放商户问卷",
    task_type: "QUESTIONNAIRE",
    priority: "HIGH",
    impact: "CRITICAL",
    status: "APPROVED",
    evidence_state: "VERIFIED",
    progress_status: "COMPLETED",
    cadence: "单次接入",
    trigger: "新店创建后",
    objective: "生成 Keke Food 的接入问卷并登记发放，收集后续关键词、审计和地点识别所需的业务事实。",
    inputs: ["店名与官网", "联系人", "候选门店地址", "主营品类与服务范围"],
    deliverable: "可外发问卷链接与发放记录",
    success_criteria: ["问卷链接可访问", "必填问题覆盖地点、品类和目标", "已登记发放时间"],
    next_step: "问卷已发放并回收，进入关键词调研",
    dependencies: [],
    due_in_days: -8,
  },
  {
    title: "问卷回收后生成关键词库",
    task_type: "KEYWORD_RESEARCH",
    priority: "HIGH",
    impact: "HIGH",
    status: "APPROVED",
    evidence_state: "VERIFIED",
    progress_status: "COMPLETED",
    cadence: "单次接入",
    trigger: "商户问卷已回收",
    objective: "基于商户确认的品类、地点和业务目标生成首轮 Local 与 Organic 关键词库。",
    inputs: ["已填写的商户问卷", "规范地点信息", "主营产品与服务范围"],
    deliverable: "首轮关键词库与搜索意图分组",
    success_criteria: ["关键词与地点一一对应", "区分 Local 与 Organic", "每组有明确搜索意图"],
    next_step: "关键词库已归档，进入首轮双审计",
    dependencies: ["商户问卷已回收"],
    due_in_days: -6,
  },
  {
    title: "执行 GBP + 官网双审计",
    task_type: "AUDIT",
    priority: "HIGH",
    impact: "HIGH",
    status: "APPROVED",
    evidence_state: "VERIFIED",
    progress_status: "COMPLETED",
    cadence: "单次接入",
    trigger: "首轮关键词库已生成",
    objective: "分别检查 GBP 公共资料与官网本地页，建立新店首轮问题和证据基线。",
    inputs: ["首轮关键词库", "GBP 公共资料", "官网与本地页"],
    deliverable: "GBP 审计、官网审计与问题清单",
    success_criteria: ["每个地点单独审计", "标注数据覆盖范围", "每项问题引用证据"],
    next_step: "双审计已完成，开始建立排名基线",
    dependencies: ["首轮关键词库已生成"],
    due_in_days: -3,
  },
  {
    title: "建立 Local + Organic 排名基线",
    task_type: "RANKING_BASELINE",
    priority: "MEDIUM",
    impact: "HIGH",
    status: "NEEDS_INPUT",
    evidence_state: "PARTIAL",
    progress_status: "IN_PROGRESS",
    cadence: "单次接入",
    trigger: "双审计完成",
    objective: "为关键词库建立首轮 Local 与 Organic 排名快照，作为后续复盘的对照基线。",
    inputs: ["首轮关键词库", "规范地点", "双审计结果"],
    deliverable: "首轮排名基线快照",
    success_criteria: ["记录抓取时间和地点", "Local 与 Organic 分开", "无法测量项明确标记"],
    next_step: "完成 Local 与 Organic 首轮排名采集并归档快照",
    dependencies: ["GBP + 官网双审计已完成"],
    due_in_days: 0,
  },
  {
    title: "生成首轮 SEO Plan",
    task_type: "PLAN",
    priority: "HIGH",
    impact: "CRITICAL",
    status: "BLOCKED",
    evidence_state: "NONE",
    progress_status: "WAITING",
    cadence: "单次接入",
    trigger: "审计与排名基线完成",
    objective: "基于首轮审计和排名基线，生成有优先级、依赖和验收证据的 SEO 执行方案。",
    inputs: ["GBP + 官网双审计", "首轮排名基线", "商户目标"],
    deliverable: "首轮 30 天 SEO Plan",
    success_criteria: ["每项有优先级和负责人", "标注审批动作", "定义完成证据"],
    next_step: "等待双审计与排名基线完成",
    dependencies: ["GBP + 官网双审计已完成", "首轮排名基线已建立"],
    due_in_days: 1,
  },
  {
    title: "确认 Plan｜拆分首轮执行任务",
    task_type: "PLAN_CONFIRM",
    priority: "MEDIUM",
    impact: "HIGH",
    status: "BLOCKED",
    evidence_state: "NONE",
    progress_status: "WAITING",
    cadence: "单次接入",
    trigger: "首轮 SEO Plan 已生成",
    objective: "由运营人员确认 Plan 条目，再逐项拆成可审批、可执行和可留证的具体任务。",
    inputs: ["首轮 30 天 SEO Plan", "运营排期", "负责人容量"],
    deliverable: "已确认的首轮执行任务清单",
    success_criteria: ["逐条确认而非整包自动执行", "每项绑定负责人和时间", "外部写入单独审批"],
    next_step: "等待首轮 SEO Plan 生成",
    dependencies: ["首轮 SEO Plan 已生成"],
    due_in_days: 4,
  },
];

function addDays(now: Date, days: number): string {
  const value = new Date(now);
  value.setDate(value.getDate() + days);
  value.setHours(17, 0, 0, 0);
  return value.toISOString();
}

function nextThursday(now: Date): Date {
  const value = new Date(now);
  const daysUntilThursday = (4 - value.getDay() + 7) % 7;
  value.setDate(value.getDate() + daysUntilThursday);
  value.setHours(11, 30, 0, 0);
  return value;
}

type PostOccurrenceCopy = Omit<DemoPostOccurrence, "publish_at" | "status">;

const ONLY_BEAR_POSTS: PostOccurrenceCopy[] = [
  {
    topic: "午餐选择",
    intent: "LOCAL · 午餐",
    primary_keyword_cluster: "fried chicken lunch Mineola",
    supporting_keywords: ["fried chicken near me", "lunch Mineola"],
    cta: "查看菜单",
  },
  {
    topic: "奶茶搭配",
    intent: "LOCAL · 饮品",
    primary_keyword_cluster: "boba near Mineola",
    supporting_keywords: ["bubble tea Mineola", "chicken and boba"],
    cta: "查看菜单",
  },
  {
    topic: "周末聚餐",
    intent: "LOCAL · 聚餐",
    primary_keyword_cluster: "family meal Mineola",
    supporting_keywords: ["fried chicken Mineola", "weekend food near me"],
    cta: "规划到店",
  },
  {
    topic: "外带场景",
    intent: "LOCAL · 外带",
    primary_keyword_cluster: "takeout Mineola",
    supporting_keywords: ["fried chicken takeout", "quick lunch Mineola"],
    cta: "查看路线",
  },
];

const UWS_POSTS: PostOccurrenceCopy[] = [
  {
    topic: "工作日午餐",
    intent: "LOCAL · 午餐",
    primary_keyword_cluster: "lunch Upper West Side",
    supporting_keywords: ["restaurant UWS", "weekday lunch near me"],
    cta: "查看菜单",
  },
  {
    topic: "附近晚餐",
    intent: "LOCAL · 晚餐",
    primary_keyword_cluster: "dinner Upper West Side",
    supporting_keywords: ["restaurant near me", "Upper West Side dinner"],
    cta: "规划到店",
  },
  {
    topic: "周末用餐",
    intent: "LOCAL · 周末",
    primary_keyword_cluster: "weekend brunch Upper West Side",
    supporting_keywords: ["brunch UWS", "weekend restaurant near me"],
    cta: "查看菜单",
  },
  {
    topic: "外带选择",
    intent: "LOCAL · 外带",
    primary_keyword_cluster: "takeout Upper West Side",
    supporting_keywords: ["food to go UWS", "takeout near me"],
    cta: "查看路线",
  },
];

function buildPostSchedule(merchant: MerchantSummary, now: Date): DemoPostOccurrence[] {
  const start = nextThursday(now);
  const copy = merchant.slug === "choice-brooklyn-uws" ? UWS_POSTS : ONLY_BEAR_POSTS;
  return copy.map((item, index) => ({
    ...item,
    publish_at: addDays(start, index * 7),
    status: index === 0
      ? (merchant.slug === "choice-brooklyn-uws" ? "待审批" : "待授权")
      : index === 1 ? "待撰稿" : "待排期",
  }));
}

function formatTaskDate(value: string): string {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}月${day}日`;
}

function taskStatusForOccurrence(item: DemoPostOccurrence): DemoTask["status"] {
  if (item.status === "待授权") return "BLOCKED";
  if (item.status === "待审批") return "READY_FOR_APPROVAL";
  return "NEEDS_INPUT";
}

function nextStepForOccurrence(item: DemoPostOccurrence): string {
  switch (item.status) {
    case "待授权": return "等待 GBP 资产授权后生成本次发布预览";
    case "待审批": return "审核本次文案与配图，确认后进入人工发布";
    case "待撰稿": return "根据本次关键词 Brief 完成文案与配图草稿";
    case "待排期": return "确认内容事实与素材后进入撰稿排期";
  }
}

const ONBOARDING_STAGE_INDEX = {
  QUESTIONNAIRE: 0,
  KEYWORDS: 1,
  AUDIT: 2,
  RANKING_BASELINE: 3,
  PLAN: 4,
} as const;

type OnboardingStage = keyof typeof ONBOARDING_STAGE_INDEX;

function isOnboardingStage(stage: MerchantSummary["stage"]): stage is OnboardingStage {
  return Boolean(stage && stage in ONBOARDING_STAGE_INDEX);
}

function onboardingTasksForStage(stage: OnboardingStage): DemoTemplate[] {
  const currentIndex = ONBOARDING_STAGE_INDEX[stage];
  const schedule = [0, 2, 5, 8, 9, 12];
  const currentNextSteps = [
    "等待商户填写并回收问卷",
    "基于已回收问卷生成首轮关键词库",
    "执行 GBP 与官网双审计并归档证据",
    "完成 Local 与 Organic 首轮排名采集并归档快照",
    "基于审计与排名基线生成首轮 SEO Plan",
  ];

  return KEKE_TASKS.map((task, index) => {
    const completed = index < currentIndex;
    const current = index === currentIndex;
    return {
      ...task,
      status: completed ? "APPROVED" : current ? "NEEDS_INPUT" : "BLOCKED",
      evidence_state: completed ? "VERIFIED" : current ? "PARTIAL" : "NONE",
      progress_status: completed ? "COMPLETED" : current ? "IN_PROGRESS" : "WAITING",
      due_in_days: (schedule[index] ?? index) - schedule[currentIndex],
      ...(current ? { next_step: currentNextSteps[currentIndex] } : {}),
    };
  });
}

function tasksForMerchant(merchant: MerchantSummary): DemoTemplate[] {
  if (merchant.slug === "keke-food") return KEKE_TASKS;
  if (isOnboardingStage(merchant.stage)) return onboardingTasksForStage(merchant.stage);
  if (merchant.slug === "choice-brooklyn-uws") {
    return STANDARD_TASKS.map((task, index) => ({ ...task, ...UWS_OVERRIDES[index] }));
  }
  return STANDARD_TASKS;
}

export function buildDemoTasks(merchants: MerchantSummary[], now = new Date()): DemoTask[] {
  return merchants.flatMap((merchant) => {
    const location = merchant.locations[0];
    return tasksForMerchant(merchant).flatMap((template, index): DemoTask[] => {
      if (template.task_type === "GBP_POST") {
        return buildPostSchedule(merchant, now).map((occurrence, occurrenceIndex) => ({
          ...template,
          id: `demo-${merchant.slug}-gbp-post-${occurrence.publish_at.slice(0, 10)}`,
          merchant_id: merchant.id,
          merchant_name: merchant.display_name,
          ...(location ? { location_id: location.id, location_name: location.display_name } : {}),
          owner_id: merchant.operators[0]?.id ?? "unassigned",
          due_at: occurrence.publish_at,
          updated_at: addDays(now, -occurrenceIndex),
          title: `${formatTaskDate(occurrence.publish_at)}发布 GBP Post｜${occurrence.topic}`,
          status: taskStatusForOccurrence(occurrence),
          evidence_state: occurrence.status === "待审批" ? "VERIFIED" : "NONE",
          cadence: "单次执行",
          trigger: "来源：每周四 GBP 内容日历",
          objective: `在计划时间发布“${occurrence.topic}”内容，围绕 ${occurrence.primary_keyword_cluster} 服务一个明确的本地搜索意图。`,
          inputs: [
            `主题：${occurrence.topic}`,
            `主关键词簇：${occurrence.primary_keyword_cluster}`,
            `辅助词：${occurrence.supporting_keywords.join("、")}`,
            `CTA：${occurrence.cta}`,
          ],
          next_step: nextStepForOccurrence(occurrence),
          task_revision: 1,
          state_version: 1,
          post_occurrence: occurrence,
          demo: true as const,
        }));
      }
      return [{
        ...template,
        id: `demo-${merchant.slug}-${template.task_type.toLocaleLowerCase()}`,
        merchant_id: merchant.id,
        merchant_name: merchant.display_name,
        ...(location ? { location_id: location.id, location_name: location.display_name } : {}),
        owner_id: merchant.operators[0]?.id ?? "unassigned",
        due_at: addDays(now, template.due_in_days),
        updated_at: addDays(now, -index),
        task_revision: 1,
        state_version: 1,
        demo: true as const,
      }];
    });
  });
}

export function filterDemoTasks(tasks: DemoTask[], filters: SeoOpsPageRequest): DemoTask[] {
  return tasks.filter((task) =>
    (!filters.merchant_id || task.merchant_id === filters.merchant_id) &&
    (!filters.location_id || task.location_id === filters.location_id) &&
    (!filters.status || task.status === filters.status) &&
    (!filters.owner_id || task.owner_id === filters.owner_id) &&
    (!filters.evidence_state || task.evidence_state === filters.evidence_state)
  );
}
