import type { AttemptWire, SeoTask, SpecialistArtifactWire, TaskAuditReferencesWire } from "../../api/types";
import { safeHref } from "../../app/format";

function Reference({ label, value, linkLabel }: { label: string; value?: string | null; linkLabel?: string }) {
  if (!value) return null;
  const href = safeHref(value);
  return <li><span>{label}</span>{href ? <a aria-label={linkLabel ?? `打开${label}`} href={href} rel="noreferrer" target="_blank">{value}</a> : <code>{value}</code>}</li>;
}

/** Closed audit-only ledger: values are deliberately complete and selectable. */
export function TaskAuditReferences({ task, attempts, artifacts, runReferences }: {
  task: SeoTask; attempts: AttemptWire[]; artifacts: SpecialistArtifactWire[]; runReferences?: TaskAuditReferencesWire;
}) {
  return <section aria-label="审计引用" className="data-panel task-audit-references">
    <div className="panel-heading"><div><span className="eyebrow">AUDIT REFERENCES</span><h2>完整引用与回执</h2></div></div>
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
      {attempts.flatMap((attempt) => [
        <Reference key={`${attempt.id}:id`} label="attempt_id" value={attempt.id} />,
        <Reference key={`${attempt.id}:agent`} label="agent_run_id" value={attempt.agent_run_id} />,
        <Reference key={`${attempt.id}:core`} label="core_run_id" value={attempt.core_run_id} />,
        <Reference key={`${attempt.id}:probe`} label="probe_ref" value={attempt.probe_ref} />,
      ])}
      {artifacts.flatMap((artifact) => [
        <Reference key={`${artifact.id}:id`} label="artifact_id" value={artifact.id} />,
        <Reference key={`${artifact.id}:core`} label="core_run_id" value={artifact.core_run_id} />,
      ])}
      {runReferences?.agent_runs.flatMap((run) => [
        <Reference key={`${run.id}:run`} label="task_agent_run_id" value={run.id} />,
        <Reference key={`${run.id}:core`} label="core_run_id" value={run.core_run_id} />,
        <Reference key={`${run.id}:trace`} label="trace_ref" value={run.trace_ref} />,
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
        <Reference key={`${artifact.id}:audit-file`} label="file_id" value={artifact.file_id} />,
        <Reference key={`${artifact.id}:audit-hash`} label="sha256" value={artifact.sha256} />,
      ])}
    </ul>
  </section>;
}
