import { ArrowRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoOpsPageRequest } from "../../api/types";
import { canonicalOffset, pageRecoveryOffset, visiblePageRange } from "../../app/pagination";
import { evidenceStateLabel, taskStatusLabel } from "../../app/statusCopy";
import { hasPermission } from "../../auth/permissions";
import { useAuth } from "../../auth/AuthContext";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { TaskForm } from "../tasks/TaskForm";
import { usePageTitle } from "../../hooks/usePageTitle";
import { InboxFilters } from "./InboxFilters";
import { ProposalsTab } from "./ProposalsTab";
import { formatTaskOwner } from "./taskOwner";

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();
  const workspace = useWorkspace();
  const tab = params.get("tab") === "proposals" ? "proposals" : "tasks";
  const parsedOffset = canonicalOffset(params);
  const paramsKey = params.toString();
  usePageTitle(tab === "proposals" ? "待判定建议" : "任务");
  const switchTab = (next: "tasks" | "proposals") => {
    const nextParams = new URLSearchParams(params);
    if (next === "proposals") nextParams.set("tab", "proposals");
    else nextParams.delete("tab");
    setParams(nextParams);
  };
  const filters: SeoOpsPageRequest = {
    offset: parsedOffset.value, limit: 50, merchant_id: params.get("merchant_id") ?? workspace.merchantId,
    location_id: params.get("location_id") ?? undefined, status: params.get("status") ?? undefined,
    owner_id: params.get("owner_id") ?? undefined,
    evidence_state: (params.get("evidence_state") ?? undefined) as SeoOpsPageRequest["evidence_state"]
  };
  const resource = useResource((signal) => seoOpsApi.inbox(filters, signal), [
    filters.offset, filters.merchant_id, filters.location_id, filters.status, filters.owner_id, filters.evidence_state
  ]);
  const page = resource.data;
  const recoveryOffset = page ? pageRecoveryOffset(page) : null;
  const correctingPage = recoveryOffset !== null;
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const range = page ? visiblePageRange(page) : null;
  useEffect(() => {
    if (!parsedOffset.needsNormalization) return;
    const next = new URLSearchParams(paramsKey);
    next.set("offset", "0");
    setParams(next, { replace: true });
  }, [paramsKey, parsedOffset.needsNormalization, setParams]);
  useEffect(() => {
    if (recoveryOffset === null || recoveryOffset === parsedOffset.value) return;
    const next = new URLSearchParams(paramsKey);
    next.set("offset", String(recoveryOffset));
    setParams(next, { replace: true });
  }, [paramsKey, parsedOffset.value, recoveryOffset, setParams]);
  const openTask = (task: typeof items[number]) => navigate(`/tasks/${task.id}`);
  const change = (patch: Partial<SeoOpsPageRequest>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([key, value]) => value === undefined || value === "" ? next.delete(key) : next.set(key, String(value)));
    setParams(next);
  };
  return <>
    <header className="page-heading"><div><span className="eyebrow">EXECUTION INBOX / SERVER PAGINATED</span><h1>任务</h1><p>同一张表跨商户排优先级；「待判定」里的建议采纳后直接变成任务。</p></div>
      {hasPermission(user?.permissions, "seoops.manage") ? <button className="primary-button" onClick={() => setCreating(true)} type="button"><Plus size={15} /> 新建任务</button> : null}
    </header>
    <div className="tab-row" role="tablist">
      <button aria-selected={tab === "tasks"} className={`tab-button${tab === "tasks" ? " is-active" : ""}`} onClick={() => switchTab("tasks")} role="tab" type="button">执行任务</button>
      <button aria-selected={tab === "proposals"} className={`tab-button${tab === "proposals" ? " is-active" : ""}`} onClick={() => switchTab("proposals")} role="tab" type="button">待判定 · 建议</button>
    </div>
    {tab === "proposals" ? <section className="data-panel"><ProposalsTab merchantId={filters.merchant_id} /></section> : <section className="data-panel">
      <div className="panel-heading"><InboxFilters filters={filters} merchant={workspace.merchant} onChange={change} /><span className="result-count">{total || resource.loading ? (resource.loading ? "—" : total) : 0} 项</span></div>
      {resource.loading && !correctingPage ? <div className="page-state" role="status">正在读取执行队列…</div> : null}
      {correctingPage ? <div className="page-state" role="status">正在校正分页…</div> : null}
      {resource.error ? <div className="page-state is-error" role="alert">任务读取失败。<button onClick={resource.reload}>重试</button></div> : null}
      {page && !resource.error && !correctingPage ? <div className="table-wrap"><table className="task-table"><thead><tr><th>优先级</th><th>任务 / 商户</th><th>地点</th><th>影响</th><th>状态</th><th>证据</th><th>负责人</th><th>到期</th><th>更新</th><th /></tr></thead>
        <tbody>{items.map((task) => {
          const statusClass = task.status.toLocaleLowerCase();
          return <tr key={task.id}>
          <td data-label="优先级"><span className={`priority-tag is-${task.priority.toLocaleLowerCase()}`}>{task.priority}</span></td>
          <td data-label="任务 / 商户"><button className="table-link" onClick={() => openTask(task)} type="button"><strong>{task.title}</strong><small>{task.merchant_name} · {task.task_type} · rev {task.task_revision}</small></button></td>
          <td data-label="地点">{task.location_name ?? "商户级"}</td><td data-label="影响">{task.impact}</td><td data-label="状态"><span className={`status-pill is-${statusClass}`}>{taskStatusLabel(task.status)}</span></td>
          <td data-label="证据">{evidenceStateLabel(task.evidence_state)}</td><td data-label="负责人">{formatTaskOwner(task.owner_id)}</td><td data-label="到期">{formatDate(task.due_at)}</td><td data-label="更新">{formatDate(task.updated_at)}</td>
          <td data-label="操作"><button aria-label={`打开任务 ${task.title}`} className="row-arrow" onClick={() => openTask(task)} type="button"><ArrowRight size={15} /></button></td>
        </tr>;
        })}</tbody></table>
        {page.total === 0 ? <div className="empty-state"><h2>当前筛选没有任务</h2><p>调整筛选条件，或创建新的执行任务。</p></div> : null}
        {page.total > 0 && !range ? <div className="page-state" role="status">当前页未返回任务，请重试。</div> : null}
        {range ? <div className="pagination"><button disabled={page.offset === 0} onClick={() => change({ offset: Math.max(0, page.offset - page.limit) })}>上一页</button><span>显示 {range.start}–{range.end} / {page.total}</span><button disabled={page.offset + page.limit >= page.total} onClick={() => change({ offset: page.offset + page.limit })}>下一页</button></div> : null}
      </div> : null}
    </section>}
    {creating ? <TaskForm merchant={workspace.merchant} merchants={workspace.merchants} onClose={() => setCreating(false)} /> : null}
  </>;
}

function formatDate(value?: string): string { return value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—"; }
