import type { TaskEvent } from "../../api/types";

export function TaskTimeline({ events }: { events: TaskEvent[] }) {
  return <ol className="timeline" aria-label="任务审计时间线">{events.map((event) => <li key={event.id}><span /><div><strong>{event.type}</strong><p>{event.from_status ? `${event.from_status} → ` : ""}{event.to_status}</p><small>{event.actor_id} · rev {event.task_revision} · state {event.resulting_state_version}</small></div><time>{new Date(event.occurred_at).toLocaleString("zh-CN")}</time></li>)}</ol>;
}
