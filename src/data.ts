export type Merchant = {
  id: string;
  name: string;
  shortName: string;
  location: string;
  service: string;
  health: "stable" | "attention" | "blocked";
};

export type TaskBucket = "decision" | "blocked" | "today" | "after";
export type StepState = "done" | "active" | "pending" | "failed";

export type ExecutionTask = {
  id: string;
  title: string;
  merchantId: string;
  merchantName: string;
  location: string;
  asset: string;
  nextAction: string;
  bucket: TaskBucket;
  owner: string;
  due: string;
  workStage: string;
  executionState: string;
  evidenceState: string;
  evidenceCount: string;
  priority: "P0" | "P1" | "P2";
  impact: string;
  blocker?: string;
  steps: Array<{ label: string; state: StepState }>;
};

export const merchants: Merchant[] = [
  {
    id: "keke",
    name: "可可小卤",
    shortName: "可",
    location: "Flushing",
    service: "Website 建设",
    health: "attention"
  },
  {
    id: "only-bear",
    name: "Only Bear Chicken & Boba",
    shortName: "OB",
    location: "Mineola",
    service: "Website SEO",
    health: "stable"
  },
  {
    id: "choice-uws",
    name: "Choice Brooklyn UWS",
    shortName: "CB",
    location: "Upper West Side",
    service: "Local SEO",
    health: "blocked"
  }
];

export const tasks: ExecutionTask[] = [
  {
    id: "only-bear-menu",
    title: "Only Bear 菜单页发布审批",
    merchantId: "only-bear",
    merchantName: "Only Bear Chicken & Boba",
    location: "Mineola",
    asset: "Menu page",
    nextAction: "批准已核实菜单真值的发布预览",
    bucket: "decision",
    owner: "Xander",
    due: "今天 15:00",
    workStage: "待授权",
    executionState: "READY",
    evidenceState: "部分证据",
    evidenceCount: "4 / 5",
    priority: "P0",
    impact: "解除上线阻塞，进入首次索引窗口",
    steps: [
      { label: "来源", state: "done" },
      { label: "预览", state: "done" },
      { label: "审批", state: "active" },
      { label: "执行", state: "pending" },
      { label: "回读", state: "pending" }
    ]
  },
  {
    id: "uws-provider",
    title: "UWS Provider 身份回读失败",
    merchantId: "choice-uws",
    merchantName: "Choice Brooklyn UWS",
    location: "Upper West Side",
    asset: "GBP Provider",
    nextAction: "核对 Provider ID 与授权资源后再重试",
    bucket: "blocked",
    owner: "Mia",
    due: "已逾期 3 小时",
    workStage: "待回读",
    executionState: "FAILED",
    evidenceState: "不可验证",
    evidenceCount: "2 / 5",
    priority: "P0",
    impact: "地图资料同步暂停",
    blocker: "Provider ID / status 未返回；已禁止自动重试",
    steps: [
      { label: "来源", state: "done" },
      { label: "身份", state: "failed" },
      { label: "执行", state: "pending" },
      { label: "回读", state: "pending" },
      { label: "复测", state: "pending" }
    ]
  },
  {
    id: "keke-architecture",
    title: "可可小卤站点信息架构复核",
    merchantId: "keke",
    merchantName: "可可小卤",
    location: "Flushing",
    asset: "Website IA",
    nextAction: "确认菜单、门店与品牌页的父子关系",
    bucket: "today",
    owner: "Xander",
    due: "今天 17:30",
    workStage: "待复核",
    executionState: "IN_PROGRESS",
    evidenceState: "部分证据",
    evidenceCount: "3 / 5",
    priority: "P1",
    impact: "避免上线后重复调整 URL 结构",
    steps: [
      { label: "盘点", state: "done" },
      { label: "草案", state: "done" },
      { label: "复核", state: "active" },
      { label: "确认", state: "pending" },
      { label: "实施", state: "pending" }
    ]
  },
  {
    id: "only-bear-index",
    title: "Only Bear Sitemap 发布后复测",
    merchantId: "only-bear",
    merchantName: "Only Bear Chicken & Boba",
    location: "Mineola",
    asset: "sitemap.xml",
    nextAction: "回读线上文件并记录 Search Console 提交结果",
    bucket: "after",
    owner: "SEO Agent",
    due: "明天 09:00",
    workStage: "待复测",
    executionState: "PENDING",
    evidenceState: "无证据",
    evidenceCount: "0 / 5",
    priority: "P2",
    impact: "建立索引提交基线",
    steps: [
      { label: "来源", state: "done" },
      { label: "发布", state: "pending" },
      { label: "回读", state: "pending" },
      { label: "提交", state: "pending" },
      { label: "复测", state: "pending" }
    ]
  }
];

export const bucketMeta: Record<
  TaskBucket,
  { title: string; subtitle: string; tone: "amber" | "red" | "blue" | "slate" }
> = {
  decision: { title: "需要我判断", subtitle: "Agent 已准备好，等待人工决策", tone: "amber" },
  blocked: { title: "阻塞", subtitle: "先消除依赖，不允许盲目重试", tone: "red" },
  today: { title: "今天执行", subtitle: "已排程且上下文完整", tone: "blue" },
  after: { title: "执行后", subtitle: "回读、复测与复盘不能省略", tone: "slate" }
};
