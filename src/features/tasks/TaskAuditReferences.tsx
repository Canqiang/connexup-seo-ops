import type { SeoTask, TaskAuditReferencesWire } from "../../api/types";
import { safeHref } from "../../app/format";

function Reference({ label, value, linkLabel }: { label: string; value?: string | null; linkLabel?: string }) {
  if (!value) return null;
  const href = safeHref(value);
  return <li><span>{label}</span>{href ? <a aria-label={linkLabel ?? `打开${label}`} href={href} rel="noreferrer" target="_blank">{value}</a> : <code>{value}</code>}</li>;
}

/** Closed audit-only ledger: values are deliberately complete and selectable. */
export function TaskAuditReferences({ task, runReferences, loadingMore = false, onLoadMore, pageError }: {
  task: SeoTask;
  runReferences?: TaskAuditReferencesWire;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  pageError?: boolean;
}) {
  return <section aria-label="审计引用" className="data-panel task-audit-references">
    <div className="panel-heading"><div><span className="eyebrow">AUDIT REFERENCES</span><h2>完整引用与回执</h2></div><span aria-label="审计引用总数" className="result-count">{runReferences?.total ?? "—"}</span></div>
    <ul className="evidence-list">
      <Reference label="发布回执" linkLabel="打开发布回执" value={task.published_ref} />
      {task.agent_run_links.map((link) => <Reference key={link.agent_run_id} label="agent_run_id" value={link.agent_run_id} />)}
      {task.evidence_refs.flatMap((evidence) => [
        <Reference key={`${evidence.id}:id`} label="evidence_id" value={evidence.id} />,
        <Reference key={`${evidence.id}:artifact`} label="artifact_id" value={evidence.artifact_id} />,
        <Reference key={`${evidence.id}:file`} label="file_id" value={evidence.file_id} />,
        <Reference key={`${evidence.id}:source`} label="evidence_source_ref" linkLabel="打开证据来源" value={evidence.source_ref} />,
        <Reference key={`${evidence.id}:hash`} label="sha256" value={evidence.sha256} />,
      ])}
      {runReferences?.agent_runs.flatMap((run) => [
        <Reference key={`${run.id}:run`} label="task_agent_run_id" value={run.id} />,
        <Reference key={`${run.id}:core`} label="core_run_id" value={run.core_run_id} />,
        <Reference key={`${run.id}:trace`} label="trace_ref" value={run.trace_ref} />,
        <Reference key={`${run.id}:request-fingerprint`} label="request_fingerprint" value={run.request_fingerprint} />,
        <Reference key={`${run.id}:http-request-fingerprint`} label="http_request_fingerprint" value={run.http_request_fingerprint} />,
        <Reference key={`${run.id}:business-fingerprint`} label="business_input_fingerprint" value={run.business_input_fingerprint} />,
        <Reference key={`${run.id}:retry-parent`} label="retry_of_agent_run_id" value={run.retry_of_agent_run_id} />,
        <Reference key={`${run.id}:retry-generation`} label="retry_generation" value={run.retry_generation === undefined ? undefined : String(run.retry_generation)} />,
        <Reference key={`${run.id}:retry-reason`} label="retry_reason" value={run.retry_reason} />,
        ...run.deliverables.flatMap((deliverable) => [
          <Reference key={`${deliverable.id}:id`} label="deliverable_id" value={deliverable.id} />,
          <Reference key={`${deliverable.id}:file`} label="file_id" value={deliverable.file_id} />,
          <Reference key={`${deliverable.id}:hash`} label="sha256" value={deliverable.sha256} />,
          <Reference key={`${deliverable.id}:source`} label="deliverable_source_ref" value={deliverable.source_ref} />,
        ]),
      ])}
      {runReferences?.artifacts.flatMap((artifact) => [
        <Reference key={`${artifact.id}:audit-id`} label="artifact_id" value={artifact.id} />,
        <Reference key={`${artifact.id}:audit-core`} label="core_run_id" value={artifact.core_run_id} />,
      ])}
      {runReferences?.execution_attempts?.flatMap((attempt) => [
        <Reference key={`${attempt.id}:execution-attempt`} label="execution_attempt_id" value={attempt.id} />,
        <Reference key={`${attempt.id}:execution-agent`} label="agent_run_id" value={attempt.agent_run_id} />,
        <Reference key={`${attempt.id}:execution-core`} label="core_run_id" value={attempt.core_run_id} />,
        <Reference key={`${attempt.id}:execution-trace`} label="trace_ref" value={attempt.trace_ref} />,
        <Reference key={`${attempt.id}:execution-probe`} label="probe_ref" value={attempt.probe_ref} />,
        ...attempt.deliverables.flatMap((deliverable) => [
          <Reference key={`${deliverable.id}:execution-deliverable`} label="deliverable_id" value={deliverable.id} />,
          <Reference key={`${deliverable.id}:execution-file`} label="file_id" value={deliverable.file_id} />,
          <Reference key={`${deliverable.id}:execution-hash`} label="sha256" value={deliverable.sha256} />,
          <Reference key={`${deliverable.id}:execution-source`} label="deliverable_source_ref" value={deliverable.source_ref} />,
        ]),
      ])}
    </ul>
    {pageError ? <p className="page-state is-error" role="alert">更多审计引用读取失败，请重试。</p> : null}
    {onLoadMore ? <button className="secondary-button" disabled={loadingMore} onClick={onLoadMore} type="button">{loadingMore ? "正在读取更多…" : "加载更多审计引用"}</button> : null}
  </section>;
}
