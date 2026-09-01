import { Link } from 'react-router-dom'
import type { Task, TaskStatus } from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS, TASK_STATUS_LABELS } from '../labels'

const NEXT_ACTIONS: Record<TaskStatus, { to: TaskStatus; label: string }[]> = {
  todo: [{ to: 'doing', label: '开始' }, { to: 'cancelled', label: '取消' }],
  doing: [{ to: 'done', label: '完成' }, { to: 'cancelled', label: '取消' }],
  done: [],
  cancelled: [],
}

export default function TaskTable({ tasks, showSource = true, onAction }: {
  tasks: Task[]
  showSource?: boolean
  onAction?: (taskId: number, status: TaskStatus) => void
}) {
  if (tasks.length === 0) return null
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>类别</th>
            <th>任务</th>
            <th>动因</th>
            <th>预期效果</th>
            {showSource && <th>来源</th>}
            <th>状态</th>
            <th>创建</th>
            {onAction && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {tasks.map(t => (
            <tr key={t.id}>
              <td className="nowrap">
                {t.category
                  ? <span className="badge cat">{CATEGORY_LABELS[t.category] ?? t.category}</span>
                  : <span className="dim">—</span>}
              </td>
              <td className="grow"><Link to={`/tasks/${t.id}`}>{t.title}</Link></td>
              <td className="dim">{t.rationale || '—'}</td>
              <td className="dim">{t.expected_outcome || '—'}</td>
              {showSource && (
                <td className="nowrap">
                  {t.source_run_id != null
                    ? <Link to={`/runs/${t.source_run_id}`} className="dim">AI #{t.source_run_id}</Link>
                    : <span className="dim">手工</span>}
                </td>
              )}
              <td className="nowrap"><span className={`badge ${t.status}`}>{TASK_STATUS_LABELS[t.status]}</span></td>
              <td className="dim nowrap">{formatTime(t.created_at)}</td>
              {onAction && (
                <td className="nowrap">
                  {NEXT_ACTIONS[t.status].map(a => (
                    <button key={a.to} className="sm" onClick={() => onAction(t.id, a.to)}>{a.label}</button>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
