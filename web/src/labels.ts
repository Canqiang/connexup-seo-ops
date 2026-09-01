import type { RunStatus, TaskStatus } from './api'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
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
