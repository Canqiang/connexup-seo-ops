import { FileCheck2, PenLine, Plus } from "lucide-react";
import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateTime } from "../../app/format";
import type { SeoTask } from "../../api/types";
import { useResource } from "../../hooks/useResource";

/** 内容稿面板（Ⓑ/Ⓒ 内容类任务）：每版一行留痕；「定稿」把该版哈希挂进证据链，
 * 审批哈希因此锁定这份稿 —— 批过再改一个字都得重批。 */
export function DraftsPanel({ task, onReadback }: {
  task: SeoTask; onReadback: (next: SeoTask) => void;
}) {
  const drafts = useResource((signal) => seoOpsApi.drafts(task.id, signal), [task.id, task.state_version]);
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const needsDraft = task.required_evidence_types.includes("CONTENT_DRAFT");
  if (!needsDraft && !(drafts.data?.items.length)) return null;

  const finalizedVersions = new Set(
    task.evidence_refs
      .filter((e) => e.requirement_key === "CONTENT_DRAFT" && e.task_revision === task.task_revision && e.source_ref)
      .map((e) => Number(/:v(\d+)$/.exec(e.source_ref ?? "")?.[1] ?? 0)),
  );
  const canEdit = ["DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL", "APPROVED"].includes(task.status);

  const addHumanDraft = async () => {
    if (!body.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const next = await seoOpsApi.addDraftRevision(task.id, {
        body: body.trim(), source: "HUMAN_EDIT", expected_state_version: task.state_version,
        idempotency_key: crypto.randomUUID(),
      });
      setBody(""); setAdding(false); onReadback(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新增稿件失败");
    } finally {
      setBusy(false);
    }
  };

  const finalize = async (version: number) => {
    setBusy(true); setError(undefined);
    try {
      const next = await seoOpsApi.finalizeDraft(task.id, version, {
        expected_state_version: task.state_version,
        idempotency_key: `final-${task.id}-rev${task.task_revision}-v${version}`,
      });
      onReadback(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "定稿失败");
    } finally {
      setBusy(false);
    }
  };

  return <section className="data-panel drafts-panel">
    <div className="panel-heading"><div><span className="eyebrow">CONTENT DRAFTS / 内容稿</span><h2><PenLine size={15} /> 稿件迭代</h2><p className="quiet-copy">agent 初稿 → 反馈重写 / 人工改 → 定稿进证据链。没有定稿，任务到不了审批。</p></div>
      {canEdit ? <button className="secondary-button" onClick={() => setAdding((v) => !v)} type="button"><Plus size={13} /> 人工新稿</button> : null}</div>
    {adding ? <div className="draft-editor">
      <textarea onChange={(e) => setBody(e.target.value)} placeholder="Post 正文（商户口吻，避开违禁词）…" rows={4} value={body} />
      <div><button className="primary-button" disabled={busy || !body.trim()} onClick={() => void addHumanDraft()} type="button">保存为新版本</button></div>
    </div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {drafts.loading ? <div className="page-state" role="status">读取稿件…</div> : (drafts.data?.items.length ?? 0) === 0 ? <div className="empty-state slim"><p>还没有稿件。等内容 agent 产出 v1，或人工新稿。</p></div>
      : <ul className="draft-list">
        {[...(drafts.data?.items ?? [])].reverse().map((d) => <li className={finalizedVersions.has(d.version) ? "is-finalized" : undefined} key={d.id}>
          <header><strong>v{d.version}</strong>
            <span className="kind-tag">{d.source === "AGENT_GENERATED" ? "agent 初稿" : d.source === "AGENT_REWRITE" ? "按反馈重写" : "人工改"}</span>
            {finalizedVersions.has(d.version) ? <span className="status-pill is-stable"><FileCheck2 size={11} /> 已定稿</span>
              : canEdit ? <button className="text-button" disabled={busy} onClick={() => void finalize(d.version)} type="button">定为终稿</button> : null}
            <small>{formatDateTime(d.created_at)} · sha {d.sha256.slice(0, 8)}…</small></header>
          {d.feedback ? <p className="draft-feedback">反馈：{d.feedback}</p> : null}
          <p className="draft-body">{d.body}</p>
          {d.cta_url ? <small className="quiet-copy">CTA：{d.cta_type ?? "LINK"} → {d.cta_url}</small> : null}
        </li>)}
      </ul>}
  </section>;
}
