import { Bot, MessageSquareText, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoTask, TaskAuditReferencesWire } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { hasPermission } from "../../auth/permissions";
import { BackButton } from "../../app/BackButton";
import { evidenceStateLabel, executionModeLabel, REVISABLE_STATUSES, taskDecisionDescriptor, taskStatusLabel } from "../../app/statusCopy";
import type { ViewMode } from "../../app/viewMode";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { ApprovalPanel } from "./ApprovalPanel";
import { DraftsPanel } from "./DraftsPanel";
import { EvidenceForm } from "./EvidenceForm";
import { EvidenceRail } from "./EvidenceRail";
import { ExecutionPanel } from "./ExecutionPanel";
import { SpecialistArtifactsPanel } from "./SpecialistArtifactsPanel";
import { TaskDecisionHero } from "./TaskDecisionHero";
import { TaskRevisionForm } from "./TaskRevisionForm";
import { TaskTimeline } from "./TaskTimeline";
import { TechnicalDetails } from "./TechnicalDetails";
import { TaskAuditReferences } from "./TaskAuditReferences";
import { ManualCompletionPanel } from "./ManualCompletionPanel";

const AUDIT_REFERENCE_PAGE_LIMIT = 20;

function mergeById<T extends { id: string }>(current: T[], next: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of next) merged.set(item.id, item);
  return [...merged.values()];
}

function mergeRowsWithDeliverables<
  D extends { id: string },
  T extends { id: string; deliverables: D[] },
>(current: T[], next: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of next) {
    const prior = merged.get(item.id);
    merged.set(item.id, prior
      ? { ...prior, ...item, deliverables: mergeById(prior.deliverables, item.deliverables) }
      : item);
  }
  return [...merged.values()];
}

function mergeAuditReferencePages(
  current: TaskAuditReferencesWire,
  next: TaskAuditReferencesWire,
): TaskAuditReferencesWire {
  return {
    offset: next.offset ?? current.offset ?? 0,
    limit: next.limit ?? current.limit ?? AUDIT_REFERENCE_PAGE_LIMIT,
    total: Math.max(current.total ?? 0, next.total ?? 0),
    agent_runs: mergeRowsWithDeliverables(current.agent_runs, next.agent_runs),
    artifacts: mergeById(current.artifacts, next.artifacts),
    execution_attempts: mergeRowsWithDeliverables(
      current.execution_attempts ?? [],
      next.execution_attempts ?? [],
    ),
  };
}

export function TaskPage() {
  const { taskId = "" } = useParams();
  const currentTaskId = useRef(taskId);
  currentTaskId.current = taskId;
  const auditPageController = useRef<AbortController | undefined>(undefined);
  const { mode = "operator" } = useOutletContext<{ mode?: ViewMode }>();
  const { user } = useAuth();
  const taskResource = useResource((signal) => seoOpsApi.task(taskId, signal), [taskId]);
  const eventResource = useResource((signal) => seoOpsApi.events(taskId, { limit: 100 }, signal), [taskId]);
  const artifactResource = useResource((signal) => seoOpsApi.taskArtifacts(taskId, signal), [taskId]);
  const draftResource = useResource((signal) => seoOpsApi.drafts(taskId, signal), [taskId]);
  const [task, setTask] = useState<SeoTask>();
  const [showEvidence, setShowEvidence] = useState(false);
  const [showRevision, setShowRevision] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditReferences, setAuditReferences] = useState<TaskAuditReferencesWire>();
  const [auditPageLoading, setAuditPageLoading] = useState(false);
  const [auditPageError, setAuditPageError] = useState(false);
  const auditReferenceResource = useResource<TaskAuditReferencesWire | undefined>(
    (signal) => auditOpen
      ? seoOpsApi.taskAuditReferences(
          taskId,
          { offset: 0, limit: AUDIT_REFERENCE_PAGE_LIMIT },
          signal,
        )
      : Promise.resolve(undefined),
    [taskId, auditOpen],
  );
  useEffect(() => { if (taskResource.data) setTask(taskResource.data); }, [taskResource.data]);
  useEffect(() => {
    auditPageController.current?.abort();
    auditPageController.current = undefined;
    setAuditReferences(undefined);
    setAuditPageLoading(false);
    setAuditPageError(false);
    return () => auditPageController.current?.abort();
  }, [taskId]);
  useEffect(() => {
    if (auditReferenceResource.data) {
      setAuditReferences(auditReferenceResource.data);
      setAuditPageError(false);
    }
  }, [auditReferenceResource.data]);
  usePageTitle(task ? task.title : "任务");
  const readback = (next: SeoTask) => { setTask(next); taskResource.reload(); eventResource.reload(); artifactResource.reload(); draftResource.reload(); if (auditOpen) auditReferenceResource.reload(); };
  const reload = () => { taskResource.reload(); eventResource.reload(); artifactResource.reload(); draftResource.reload(); if (auditOpen) auditReferenceResource.reload(); };
  const nextAuditOffset = (auditReferences?.offset ?? 0)
    + (auditReferences?.limit ?? AUDIT_REFERENCE_PAGE_LIMIT);
  const hasMoreAuditReferences = nextAuditOffset < (auditReferences?.total ?? 0);
  const loadMoreAuditReferences = async () => {
    if (!auditReferences || auditPageLoading || !hasMoreAuditReferences) return;
    const requestedTaskId = taskId;
    const controller = new AbortController();
    auditPageController.current?.abort();
    auditPageController.current = controller;
    setAuditPageLoading(true);
    setAuditPageError(false);
    try {
      const next = await seoOpsApi.taskAuditReferences(taskId, {
        offset: nextAuditOffset,
        limit: auditReferences.limit ?? AUDIT_REFERENCE_PAGE_LIMIT,
      }, controller.signal);
      if (controller.signal.aborted || currentTaskId.current !== requestedTaskId) return;
      setAuditReferences((current) => current ? mergeAuditReferencePages(current, next) : next);
    } catch {
      if (!controller.signal.aborted && currentTaskId.current === requestedTaskId) {
        setAuditPageError(true);
      }
    } finally {
      if (auditPageController.current === controller) {
        auditPageController.current = undefined;
        if (currentTaskId.current === requestedTaskId) setAuditPageLoading(false);
      }
    }
  };
  if (taskResource.loading && !task) return <div className="page-state" role="status">正在读取任务聚合…</div>;
  if (taskResource.error || !task) return <div className="page-state is-error" role="alert">任务不存在、不可见或读取失败。<BackButton fallback="/inbox" label="返回任务列表" /></div>;

  const canManage = hasPermission(user?.permissions, "seoops.manage");
  const canApprove = hasPermission(user?.permissions, "seoops.approve");
  const canExecute = hasPermission(user?.permissions, "seoops.execute");
  const canRevise = canManage && REVISABLE_STATUSES.has(task.status);
  const decision = taskDecisionDescriptor(task, { canManage, canApprove, canExecute });
  const heroAction = !decision.actionLabel ? undefined : decision.actionKind === "APPROVE"
    ? <ApprovalPanel canApprove={canApprove} compact onReadback={readback} primaryLabel="批准当前版本" task={task} />
    : decision.actionKind === "MANUAL_COMPLETE"
      ? <ManualCompletionPanel onReadback={readback} task={task} />
      : decision.actionKind === "CONFIRM" || decision.actionKind === "VERIFY" || decision.actionKind === "RECONCILE"
      ? <ExecutionPanel audit={false} canExecute={canExecute} compact onReadback={readback} task={task} />
      : decision.actionKind === "CONTACT" && decision.actionLabel
        ? <button className="primary-button" disabled={!canRevise} onClick={() => setShowRevision(true)} type="button">{decision.actionLabel}</button>
        : decision.actionLabel ? <button className="secondary-button" onClick={() => setAuditOpen(true)} type="button">{decision.actionLabel}</button> : undefined;

  return <>
    <header className="task-page-toolbar"><BackButton fallback="/inbox" label="返回任务列表" /><button aria-label="刷新任务" className="icon-button" onClick={reload} type="button"><RefreshCw size={16} /></button></header>
    <TaskDecisionHero artifacts={artifactResource.data?.items ?? []} decision={decision} drafts={draftResource.data?.items ?? []} task={task}>{heroAction}</TaskDecisionHero>
    {showRevision ? <section className="data-panel inline-form"><TaskRevisionForm task={task} onClose={() => setShowRevision(false)} onReadback={readback} /></section> : null}
    {showEvidence ? <section className="data-panel inline-form"><div className="panel-heading"><div><span className="eyebrow">EVIDENCE COMMAND</span><h2>附加当前版本证据</h2></div></div><EvidenceForm task={task} onReadback={readback} /></section> : null}
    <TechnicalDetails onToggle={setAuditOpen} open={auditOpen} task={task}>
      <section className="task-state-ribbon is-six"><div><span>任务版本</span><strong>rev {task.task_revision}</strong></div><div><span>状态版本</span><strong>{task.state_version}</strong></div><div><span>执行状态</span><strong>{taskStatusLabel(task.status)}</strong></div><div><span>证据状态</span><strong>{evidenceStateLabel(task.evidence_state)}</strong></div><div><span>执行模式</span><strong>{executionModeLabel(task.execution_mode)}</strong></div><div><span>影响</span><strong>{task.impact}</strong></div></section>
      {auditOpen ? <TaskAuditReferences
        loadingMore={auditPageLoading}
        onLoadMore={hasMoreAuditReferences ? () => { void loadMoreAuditReferences(); } : undefined}
        pageError={auditPageError || Boolean(auditReferenceResource.error)}
        runReferences={auditReferences}
        task={task}
      /> : null}
      <div className="task-layout"><div className="task-primary">
        {artifactResource.loading && !artifactResource.data ? <div className="page-state" role="status">读取 Agent 产物…</div> : null}
        {artifactResource.error ? <div className="page-state is-error" role="alert">Agent 产物读取失败。</div> : null}
        <SpecialistArtifactsPanel artifacts={artifactResource.data?.items ?? []} />
        <DraftsPanel onReadback={readback} task={task} />
        <section className="data-panel"><div className="panel-heading"><div><span className="eyebrow">AUDIT TRAIL</span><h2>事件时间线</h2></div><span className="result-count">{eventResource.data?.total ?? "—"}</span></div>{eventResource.loading ? <div className="page-state" role="status">读取事件…</div> : <TaskTimeline events={eventResource.data?.items ?? []} />}</section>
      </div><aside className="task-context">
        <ExecutionPanel audit={mode === "audit"} canExecute={canExecute} onReadback={readback} task={task} />
        <section className="data-panel evidence-panel"><div className="panel-heading"><div><span className="eyebrow">EVIDENCE SPINE</span><h2>证据脊柱</h2></div></div><EvidenceRail task={task} /></section>
        <ApprovalPanel canApprove={canApprove} onReadback={readback} task={task} />
        <section className="link-panel"><div><MessageSquareText size={15} /><span><strong>{task.conversation_links.length}</strong> 对话链接</span></div><div><Bot size={15} /><span><strong>{task.agent_run_links.length}</strong> Agent Run 引用</span></div><p><ShieldCheck size={13} /> 这里只显示 ID 和状态摘要，不载入聊天正文或运行载荷。</p></section>
      </aside></div>
    </TechnicalDetails>
  </>;
}
