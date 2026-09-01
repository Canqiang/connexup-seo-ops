import { Link, useLocation } from 'react-router-dom'
import type { Task } from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS, TASK_STATUS_LABELS } from '../labels'

type TaskLike = Task & { merchant_name?: string }

const EXECUTION_LABELS = {
  running: 'Agent 执行中',
  ready: '待审批',
  failed: '执行失败',
  approved: '已完成',
  returned: '已退回',
} as const

export default function TaskTable({ tasks, showSource = true, showMerchant = false }: {
  tasks: TaskLike[]
  showSource?: boolean
  showMerchant?: boolean
}) {
  const location = useLocation()
  if (tasks.length === 0) return null
  const taskOrigin = {
    kind: showMerchant ? 'tasks' : 'merchant',
    from: `${location.pathname}${location.search}`,
  }
  return (
    <div className="table-wrap flush">
      <table className="task-data-table" aria-label={showMerchant ? '跨商户任务列表' : '任务列表'}>
        <thead>
          <tr>
            {showMerchant && <th>商户</th>}
            <th>类别</th>
            <th>任务</th>
            <th>动因</th>
            <th>预期效果</th>
            {showSource && <th>来源</th>}
            <th>状态</th>
            <th>计划开始</th>
            <th>创建</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(t => {
            const planLocked = t.status === 'todo' && t.source_run_id != null && t.source_plan_approved === false
            return (
            <tr key={t.id} className={t.status === 'cancelled' ? 'row-cancelled' : ''}>
              {showMerchant && (
                <td className="nowrap"><Link to={`/merchants/${t.merchant_id}`}>{t.merchant_name ?? `#${t.merchant_id}`}</Link></td>
              )}
              <td className="nowrap">
                {t.category
                  ? <span className="badge cat">{CATEGORY_LABELS[t.category] ?? t.category}</span>
                  : <span className="dim">—</span>}
              </td>
              <td className="grow">
                <Link className="cell-clamp" to={`/tasks/${t.id}`} state={{ taskOrigin }}>{t.title}</Link>
              </td>
              <td className="dim detail-copy" title={t.rationale || undefined}><span className="cell-clamp">{t.rationale || '—'}</span></td>
              <td className="dim detail-copy" title={t.expected_outcome || undefined}><span className="cell-clamp">{t.expected_outcome || '—'}</span></td>
              {showSource && (
                <td className="nowrap">
                  {t.source_run_id != null
                    ? <Link to={`/runs/${t.source_run_id}`} className="dim">AI #{t.source_run_id}</Link>
                    : <span className="dim">手工</span>}
                </td>
              )}
              <td className="nowrap">
                <span className={`badge ${t.execution_status ?? t.status}`}>
                  {t.execution_status ? EXECUTION_LABELS[t.execution_status] : TASK_STATUS_LABELS[t.status]}
                </span>
              </td>
              <td className="dim nowrap">{t.scheduled_start ? formatTime(t.scheduled_start) : '—'}</td>
              <td className="dim nowrap">{formatTime(t.created_at)}</td>
              <td className="nowrap">
                {planLocked
                  ? <span className="plan-lock-label">等待确认 Plan</span>
                  : <Link className="table-action-link" aria-label={`查看任务：${t.title}`} to={`/tasks/${t.id}`} state={{ taskOrigin }}>查看</Link>}
              </td>
            </tr>
          )})}
        </tbody>
      </table>
    </div>
  )
}
