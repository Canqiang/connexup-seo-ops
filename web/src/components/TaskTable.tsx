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

type TaskLike = Task & { merchant_name?: string }

export default function TaskTable({ tasks, showSource = true, showMerchant = false, onAction, selected, onToggleSelect, onToggleAll }: {
  tasks: TaskLike[]
  showSource?: boolean
  showMerchant?: boolean
  onAction?: (taskId: number, status: TaskStatus) => void
  selected?: Set<number>
  onToggleSelect?: (taskId: number) => void
  onToggleAll?: () => void
}) {
  if (tasks.length === 0) return null
  const selectable = selected !== undefined && onToggleSelect !== undefined
  return (
    <div className="table-wrap flush">
      <table className="task-data-table" aria-label={showMerchant ? '跨商户任务列表' : '任务列表'}>
        <thead>
          <tr>
            {selectable && (
              <th>
                <input
                  type="checkbox"
                  checked={tasks.length > 0 && tasks.every(t => selected.has(t.id))}
                  onChange={() => onToggleAll?.()}
                />
              </th>
            )}
            {showMerchant && <th>商户</th>}
            <th>类别</th>
            <th>任务</th>
            <th>动因</th>
            <th>预期效果</th>
            {showSource && <th>来源</th>}
            <th>状态</th>
            <th>计划开始</th>
            <th>创建</th>
            {onAction && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {tasks.map(t => (
            <tr key={t.id} className={t.status === 'cancelled' ? 'row-cancelled' : ''}>
              {selectable && (
                <td>
                  <input type="checkbox" checked={selected.has(t.id)} onChange={() => onToggleSelect(t.id)} />
                </td>
              )}
              {showMerchant && (
                <td className="nowrap"><Link to={`/merchants/${t.merchant_id}`}>{t.merchant_name ?? `#${t.merchant_id}`}</Link></td>
              )}
              <td className="nowrap">
                {t.category
                  ? <span className="badge cat">{CATEGORY_LABELS[t.category] ?? t.category}</span>
                  : <span className="dim">—</span>}
              </td>
              <td className="grow"><Link className="cell-clamp" to={`/tasks/${t.id}`}>{t.title}</Link></td>
              <td className="dim detail-copy" title={t.rationale || undefined}><span className="cell-clamp">{t.rationale || '—'}</span></td>
              <td className="dim detail-copy" title={t.expected_outcome || undefined}><span className="cell-clamp">{t.expected_outcome || '—'}</span></td>
              {showSource && (
                <td className="nowrap">
                  {t.source_run_id != null
                    ? <Link to={`/runs/${t.source_run_id}`} className="dim">AI #{t.source_run_id}</Link>
                    : <span className="dim">手工</span>}
                </td>
              )}
              <td className="nowrap"><span className={`badge ${t.status}`}>{TASK_STATUS_LABELS[t.status]}</span></td>
              <td className="dim nowrap">{t.scheduled_start ? formatTime(t.scheduled_start) : '—'}</td>
              <td className="dim nowrap">{formatTime(t.created_at)}</td>
              {onAction && (
                <td className="nowrap">
                  {NEXT_ACTIONS[t.status].map(a => (
                    <button
                      key={a.to}
                      className={`sm ${a.to === 'doing' || a.to === 'done' ? 'row-primary' : 'quiet'}`}
                      onClick={() => onAction(t.id, a.to)}
                    >
                      {a.label}
                    </button>
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
