import type {
  AgentRunStage,
  AgentRunStatus,
  AgentRunType,
  DeliverableKind,
} from "../domain/enums.js";

/** 阶段运行：归属于（商户，地点，阶段）。task_id 仅溯源用（Plan 转任务后
 * 回填），运行本身永不依赖任务存在。 */
export interface AgentRun {
  id: string;
  merchantId: string;
  locationId: string | null;
  stage: AgentRunStage;
  taskId: string | null;
  runType: AgentRunType;
  goal: string | null;
  status: AgentRunStatus;
  coreRunId: string | null;
  traceRef: string | null;
  coreStatus: string | null;
  inputMessage: string;
  output: string | null;
  error: string | null;
  errorCode: string | null;
  tokenUsage: Record<string, number>;
  triggeredBy: string;
  triggeredAt: string;
  lastPolledAt: string | null;
  completedAt: string | null;
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 交付物：一文件一行。SUMMARY = 运行正文落盘；ATTACHMENT = agent 返回的附件；
 * MANUAL = 运营手工上传兜底。下载失败时 local_path 为空、保留 remote_url，
 * 补下载幂等（同字节 tmp+rename）。 */
export interface RunDeliverable {
  id: string;
  runId: string;
  kind: DeliverableKind;
  fileId: string | null;
  fileName: string;
  contentType: string | null;
  size: number | null;
  title: string | null;
  description: string | null;
  sha256: string | null;
  localPath: string | null;
  remoteUrl: string | null;
  downloadedAt: string | null;
  downloadError: string | null;
  createdAt: string;
}
