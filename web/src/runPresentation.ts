import type { Run } from './api'

export function formatRunDuration(startedAt: string, finishedAt: string | null) {
  if (!finishedAt) return '—'
  const milliseconds = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1000))} 秒`
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return `${hours} 小时${remainder ? ` ${remainder} 分钟` : ''}`
}

export function runResult(run: Run) {
  if (run.status === 'running' && run.dispatch_state === 'UNKNOWN') return '需人工核对'
  if (run.status === 'running') return '生成中'
  if (run.status === 'failed') return run.error || '分析失败'
  return '已生成报告'
}
