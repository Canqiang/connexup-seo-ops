import { ArrowRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoOpsPageRequest } from "../../api/types";
import { hasPermission } from "../../auth/permissions";
import { useAuth } from "../../auth/AuthContext";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { TaskForm } from "../tasks/TaskForm";
import { DemoTaskDrawer } from "./DemoTaskDrawer";
import { buildDemoTasks, filterDemoTasks, isDemoTask, taskStatusView, type DemoTask } from "./demoTasks";
import { InboxFilters } from "./InboxFilters";

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [demoTask, setDemoTask] = useState<DemoTask>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const workspace = useWorkspace();
  const filters: SeoOpsPageRequest = {
    offset: Number(params.get("offset") ?? 0), limit: 50, merchant_id: params.get("merchant_id") ?? workspace.merchantId,
    location_id: params.get("location_id") ?? undefined, status: params.get("status") ?? undefined,
    owner_id: params.get("owner_id") ?? undefined,
    evidence_state: (params.get("evidence_state") ?? undefined) as SeoOpsPageRequest["evidence_state"]
  };
  const resource = useResource((signal) => seoOpsApi.inbox(filters, signal), [
    filters.offset, filters.merchant_id, filters.location_id, filters.status, filters.owner_id, filters.evidence_state
  ]);
  const demoCatalog = useMemo(() => buildDemoTasks(workspace.merchants), [workspace.merchants]);
  const useDemoTasks = Boolean(resource.data && (workspace.portfolio?.totals.tasks ?? 0) === 0);
  const demoItems = useDemoTasks ? filterDemoTasks(demoCatalog, filters) : [];
  const items = useDemoTasks ? demoItems : (resource.data?.items ?? []);
  const total = useDemoTasks ? demoItems.length : (resource.data?.total ?? 0);
  const openTask = (task: typeof items[number]) => {
    if (isDemoTask(task)) setDemoTask(task);
    else navigate(`/tasks/${task.id}`);
  };
  const change = (patch: Partial<SeoOpsPageRequest>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([key, value]) => value === undefined || value === "" ? next.delete(key) : next.set(key, String(value)));
    setParams(next);
  };
  return <>
    <header className="page-heading"><div><span className="eyebrow">EXECUTION INBOX / SERVER PAGINATED</span><h1>执行任务</h1><p>同一张表跨商户排优先级，不在浏览器里加载整套任务库。</p></div>
      {hasPermission(user?.permissions, "seoops.manage") ? <button className="primary-button" onClick={() => setCreating(true)} type="button"><Plus size={15} /> 新建任务</button> : null}
    </header>
    <section className="data-panel">
      {useDemoTasks ? <div className="demo-inbox-note"><span>FRONTEND DEMO</span><strong>{total} 个演示任务</strong><p>用于演示周期运营、复盘、Re-audit 与 Plan 刷新；不会写入后端。</p></div> : null}
      <div className="panel-heading"><InboxFilters filters={filters} merchant={workspace.merchant} onChange={change} /><span className="result-count">{total || resource.loading ? (resource.loading ? "—" : total) : 0} 项</span></div>
      {resource.loading ? <div className="page-state" role="status">正在读取执行队列…</div> : null}
      {resource.error ? <div className="page-state is-error" role="alert">任务读取失败。<button onClick={resource.reload}>重试</button></div> : null}
      {resource.data ? <div className="table-wrap"><table className="task-table"><thead><tr><th>优先级</th><th>任务 / 商户</th><th>地点</th><th>影响</th><th>状态</th><th>证据</th><th>负责人</th><th>到期</th><th>更新</th><th /></tr></thead>
        <tbody>{items.map((task) => {
          const statusView = taskStatusView(task);
          return <tr className={isDemoTask(task) ? "is-demo-task" : undefined} key={task.id}>
          <td><span className={`priority-tag is-${task.priority.toLocaleLowerCase()}`}>{task.priority}</span></td>
          <td><button className="table-link" onClick={() => openTask(task)} type="button"><strong>{task.title}</strong><small>{task.merchant_name} · {task.task_type}{isDemoTask(task) ? demoTaskMeta(task) : ` · rev ${task.task_revision}`}</small></button></td>
          <td>{task.location_name ?? "商户级"}</td><td>{task.impact}</td><td><span className={`status-pill is-${statusView.className}`}>{statusView.label}</span></td>
          <td>{task.evidence_state}</td><td>{task.owner_id ?? "未分配"}</td><td>{formatDate(task.due_at)}</td><td>{formatDate(task.updated_at)}</td>
          <td><button aria-label={`打开任务 ${task.title}`} className="row-arrow" onClick={() => openTask(task)} type="button"><ArrowRight size={15} /></button></td>
        </tr>;
        })}</tbody></table>
        {!items.length ? <div className="empty-state"><h2>当前筛选没有任务</h2><p>调整筛选条件，或创建新的执行任务。</p></div> : null}
        {!useDemoTasks ? <div className="pagination"><button disabled={filters.offset === 0} onClick={() => change({ offset: Math.max(0, (filters.offset ?? 0) - 50) })}>上一页</button><span>{(filters.offset ?? 0) + 1}–{Math.min((filters.offset ?? 0) + 50, resource.data.total)} / {resource.data.total}</span><button disabled={(filters.offset ?? 0) + 50 >= resource.data.total} onClick={() => change({ offset: (filters.offset ?? 0) + 50 })}>下一页</button></div> : null}
      </div> : null}
    </section>
    {creating ? <TaskForm merchant={workspace.merchant} merchants={workspace.merchants} onClose={() => setCreating(false)} /> : null}
    {demoTask ? <DemoTaskDrawer task={demoTask} onClose={() => setDemoTask(undefined)} /> : null}
  </>;
}

function formatDate(value?: string): string { return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—"; }

function demoTaskMeta(task: DemoTask): string {
  if (!task.post_occurrence) return ` · ${task.cadence}`;
  return ` · ${task.post_occurrence.primary_keyword_cluster} · ${task.post_occurrence.intent} · ${task.post_occurrence.status}`;
}
