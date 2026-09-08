import type { RunStatus, TaskBlocker, TaskStatus } from './api'
import { formatTime } from './format'

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

export function blockerSummary(blocker: TaskBlocker | null): string {
  if (!blocker) return '可执行'
  if (blocker.code === 'ASSIGNEE_EXECUTION_UNAVAILABLE') return '已分配 Agent，等待执行能力接入'
  if (blocker.code === 'UPSTREAM_NOT_DONE') {
    return blocker.task_title ? `被「${blocker.task_title}」阻塞` : '等待上游任务完成'
  }
  if (blocker.code === 'SCHEDULED_FOR_FUTURE') {
    return blocker.scheduled_start ? `等待至 ${formatTime(blocker.scheduled_start)}` : '等待计划时间'
  }
  if (blocker.code === 'MERCHANT_ARCHIVED') return '商户已归档'
  return 'Plan revision 已停用'
}
