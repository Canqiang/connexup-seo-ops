import { Link, useLocation } from 'react-router-dom'
import type { TaskBlocker, TaskSummary } from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS, TASK_STATUS_CLASSES, TASK_STATUS_LABELS } from '../labels'

function blockerSummary(blocker: TaskBlocker | null): string {
  if (!blocker) return '可执行'
  if (blocker.code === 'UPSTREAM_NOT_DONE') {
    return blocker.task_title ? `被「${blocker.task_title}」阻塞` : '等待上游任务完成'
  }
  if (blocker.code === 'SCHEDULED_FOR_FUTURE') {
    return blocker.scheduled_start ? `等待至 ${formatTime(blocker.scheduled_start)}` : '等待计划时间'
  }
  if (blocker.code === 'MERCHANT_ARCHIVED') return '商户已归档'
  return 'Plan revision 已停用'
}

export default function TaskTable({ tasks, showSource = true, showMerchant = false }: {
  tasks: TaskSummary[]
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
            <th>就绪条件</th>
            {showSource && <th>来源</th>}
            <th>状态</th>
            <th>计划开始</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map(task => (
            <tr key={task.id} className={task.status === 'CANCELLED' ? 'row-cancelled' : ''}>
              {showMerchant && (
                <td className="nowrap"><Link to={`/merchants/${task.merchant_id}`}>{task.merchant_name || `#${task.merchant_id}`}</Link></td>
              )}
              <td className="nowrap">
                {task.category
                  ? <span className="badge cat">{CATEGORY_LABELS[task.category] ?? task.category}</span>
                  : <span className="dim">—</span>}
              </td>
              <td className="grow">
                <Link className="cell-clamp" to={`/tasks/${task.id}`} state={{ taskOrigin }}>{task.title}</Link>
                <span className="task-key-line">{task.task_key} · v{task.version}</span>
              </td>
              <td className="dim detail-copy" title={task.rationale || undefined}><span className="cell-clamp">{task.rationale || '—'}</span></td>
              <td className="dim detail-copy" title={task.expected_outcome || undefined}><span className="cell-clamp">{task.expected_outcome || '—'}</span></td>
              <td className={`task-blocker ${task.blocker ? 'blocked' : 'ready'}`}>{blockerSummary(task.blocker)}</td>
              {showSource && (
                <td className="nowrap">
                  <Link to={`/task-plans/${task.plan_id}`} className="dim">Plan #{task.plan_id} / R{task.plan_revision}</Link>
                  <span className="task-source-kind">{task.plan.source_kind === 'AGENT' ? 'Agent' : task.plan.source_kind === 'OPERATOR' ? '操作人' : '迁移'}</span>
                </td>
              )}
              <td className="nowrap">
                <span className={`badge ${TASK_STATUS_CLASSES[task.status]}`}>{TASK_STATUS_LABELS[task.status]}</span>
              </td>
              <td className="dim nowrap">{task.scheduled_start ? formatTime(task.scheduled_start) : '—'}</td>
              <td className="nowrap">
                <Link className="table-action-link" aria-label={`查看任务：${task.title}`} to={`/tasks/${task.id}`} state={{ taskOrigin }}>查看</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
