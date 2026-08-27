import { useState, type ReactNode } from "react";
import type { DraftWire, SeoTask, SpecialistArtifactWire } from "../../api/types";
import type { TaskDecisionDescriptor } from "../../app/statusCopy";

/** 首屏只呈现一个人需要作出的决定；版本、哈希和运行轨迹留给审计详情。 */
interface FinalizedDraftSnapshot {
  draft_version: number;
  draft_sha256: string;
  body: string;
  cta_type: string | null;
  cta_url: string | null;
  media: string[];
}

function finalizedSnapshot(task: SeoTask): FinalizedDraftSnapshot | undefined {
  if (task.task_type !== "GBP_POST") return undefined;
  try {
    const value = JSON.parse(task.execution_spec) as Record<string, unknown>;
    const draft = value.content_draft;
    if (draft === null || typeof draft !== "object" || Array.isArray(draft)) return undefined;
    const record = draft as Record<string, unknown>;
    if (!Number.isInteger(record.draft_version)
      || typeof record.draft_sha256 !== "string"
      || typeof record.body !== "string"
      || !(record.cta_type === null || typeof record.cta_type === "string")
      || !(record.cta_url === null || typeof record.cta_url === "string")
      || !Array.isArray(record.media) || !record.media.every((item) => typeof item === "string")) return undefined;
    return record as unknown as FinalizedDraftSnapshot;
  } catch {
    return undefined;
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactApprovalPreviewKey(draft: DraftWire | undefined): string | undefined {
  if (!draft || draft.media.length !== 1 || draft.media_previews?.length !== 1) return undefined;
  let ref: Record<string, unknown>;
  try { ref = JSON.parse(draft.media[0]!) as Record<string, unknown>; } catch { return undefined; }
  const preview = draft.media_previews[0]!;
  if (ref.schema_version !== "seo_ops.media_ref.v1"
    || typeof ref.deliverable_id !== "string" || ref.deliverable_id === ""
    || typeof ref.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(ref.sha256)
    || preview.deliverable_id !== ref.deliverable_id
    || preview.sha256 !== ref.sha256
    || preview.download_path !== `/api/seo-ops/deliverables/${encodeURIComponent(preview.deliverable_id)}/download`) return undefined;
  return `${draft.id}:${preview.deliverable_id}:${preview.sha256}`;
}

export function resolveTaskDraftDisplay(task: SeoTask, drafts: DraftWire[]) {
  if (task.task_type !== "GBP_POST") {
    return { displayedDraft: drafts.at(-1), candidateDraft: undefined, approvalIdentityValid: true, approvalPreviewKey: undefined };
  }
  const snapshot = finalizedSnapshot(task);
  const displayedDraft = snapshot ? drafts.find((draft) => draft.version === snapshot.draft_version
    && draft.sha256 === snapshot.draft_sha256
    && draft.body === snapshot.body
    && draft.cta_type === snapshot.cta_type
    && draft.cta_url === snapshot.cta_url
    && sameStrings(draft.media, snapshot.media)) : undefined;
  // Only a revision created after the finalized snapshot is a real candidate.
  // Older drafts belong in history and would duplicate the hero during a demo.
  const candidateDraft = [...drafts].reverse().find((draft) => !displayedDraft || draft.version > displayedDraft.version);
  return {
    displayedDraft,
    candidateDraft,
    approvalIdentityValid: Boolean(displayedDraft),
    approvalPreviewKey: exactApprovalPreviewKey(displayedDraft),
  };
}

export function TaskDecisionHero({ task, decision, displayedDraft, candidateDraft, approvalPreviewKey, onApprovalMediaReady, artifacts = [], children }: {
  task: SeoTask;
  decision: TaskDecisionDescriptor;
  displayedDraft?: DraftWire;
  candidateDraft?: DraftWire;
  approvalPreviewKey?: string;
  onApprovalMediaReady?: (key: string, ready: boolean) => void;
  artifacts?: SpecialistArtifactWire[];
  children?: ReactNode;
}) {
  const [failedMedia, setFailedMedia] = useState<Set<string>>(() => new Set());
  const [loadedMedia, setLoadedMedia] = useState<Set<string>>(() => new Set());
  // Task artifact API is newest-first (created_at DESC), unlike drafts.
  const latestArtifact = artifacts[0];
  const workingDraft = !displayedDraft ? candidateDraft : undefined;
  const renderDraft = (draft: DraftWire, label: string, approvalTarget = false) => <><strong>{label} v{draft.version}</strong><p>{draft.body}</p>
    {(draft.media_previews ?? []).map((preview) => <div className="task-media-preview" key={preview.deliverable_id}>
      <span className={`media-origin is-${(preview.origin ?? "AI_GENERATED").toLocaleLowerCase()}`}>{preview.origin === "OPERATOR_UPLOAD" ? "人工上传商户素材" : "AI 生成图"}</span>
      {failedMedia.has(preview.deliverable_id)
        ? <span className="task-media-fallback" role="status">图片预览暂不可用；批准前请刷新重试。</span>
        : <>{!loadedMedia.has(preview.deliverable_id)
            ? <span className="task-media-fallback" role="status">图片加载中…</span>
            : null}<img
            alt={preview.alt_text}
            height="640"
            loading="lazy"
            onError={() => {
              setFailedMedia((current) => new Set(current).add(preview.deliverable_id));
              if (approvalTarget && approvalPreviewKey) onApprovalMediaReady?.(approvalPreviewKey, false);
            }}
            onLoad={() => {
              setLoadedMedia((current) => new Set(current).add(preview.deliverable_id));
              if (approvalTarget && approvalPreviewKey) onApprovalMediaReady?.(approvalPreviewKey, true);
            }}
            src={preview.download_path}
            width="640"
          /></>}
    </div>)}
    {draft.cta_type && draft.cta_type !== "NONE" ? <small>CTA：{draft.cta_type}{draft.cta_url ? ` · ${draft.cta_url}` : ""}</small> : null}</>;
  return <section aria-label="当前决策" className="task-decision-hero">
    <div className="task-decision-context"><span className="eyebrow"><span>{task.merchant_name}</span>{task.location_name ? <> · <span>{task.location_name}</span></> : null}</span><h1>{task.title}</h1></div>
    <div className="task-decision-main"><span className="eyebrow">CURRENT HUMAN DECISION</span><h2>{decision.heading}</h2><p>{decision.consequence}</p></div>
    <section aria-label="当前内容" className="task-current-content"><span className="eyebrow">当前内容 / 成品</span>
      {displayedDraft ? renderDraft(displayedDraft, task.task_type === "GBP_POST" ? "当前批准对象" : "当前稿件", task.task_type === "GBP_POST")
        : workingDraft ? renderDraft(workingDraft, "当前草稿")
        : latestArtifact ? <><strong>当前产物</strong><p>{latestArtifact.title}</p><small>{latestArtifact.summary}</small></>
          : task.task_type === "GBP_POST" ? <p className="boundary-note">没有与当前定稿快照完全一致的可批准稿件。</p> : <pre>{task.execution_spec}</pre>}
    </section>
    {displayedDraft && candidateDraft ? <section aria-label="未定稿候选" className="task-current-content task-candidate-content">
      <span className="eyebrow">CANDIDATE / NOT FINALIZED</span>
      {renderDraft(candidateDraft, "未定稿候选")}
    </section> : null}
    <div className="task-decision-action">{children ?? (decision.actionLabel ? <button className="primary-button" type="button">{decision.actionLabel}</button> : <p className="quiet-copy">当前账号可查看该决定，但没有执行权限。</p>)}</div>
  </section>;
}
