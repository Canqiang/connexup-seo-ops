import type { RunStatus, TaskStatus } from './api'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  PENDING: '待办',
  PREPARING: '准备中',
  AWAITING_APPROVAL: '待内容审批',
  EXECUTING: '发布中',
  VERIFYING: '验证中',
  DONE: '已完成',
  NEEDS_ATTENTION: '需要人工处理',
  CANCELLED: '已取消',
}

export const TASK_STATUS_CLASSES: Record<TaskStatus, string> = {
  PENDING: 'todo',
  PREPARING: 'doing',
  AWAITING_APPROVAL: 'awaiting',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  DONE: 'done',
  NEEDS_ATTENTION: 'failed',
  CANCELLED: 'cancelled',
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: '进行中',
  succeeded: '成功',
  failed: '失败',
}

export const CATEGORY_LABELS: Record<string, string> = {
  gbp: 'GBP 资料',
  content: '内容建设',
  review: '评论口碑',
  citation: '信息一致性',
  technical: '技术优化',
  other: '其他',
}
