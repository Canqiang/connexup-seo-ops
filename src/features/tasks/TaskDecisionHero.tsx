import { useState, type ReactNode } from "react";
import type { DraftWire, SeoTask, SpecialistArtifactWire } from "../../api/types";
import type { TaskDecisionDescriptor } from "../../app/statusCopy";

/** 首屏只呈现一个人需要作出的决定；版本、哈希和运行轨迹留给审计详情。 */
export function TaskDecisionHero({ task, decision, drafts = [], artifacts = [], children }: {
  task: SeoTask;
  decision: TaskDecisionDescriptor;
  drafts?: DraftWire[];
  artifacts?: SpecialistArtifactWire[];
  children?: ReactNode;
}) {
  const [failedMedia, setFailedMedia] = useState<Set<string>>(() => new Set());
  const [loadedMedia, setLoadedMedia] = useState<Set<string>>(() => new Set());
  const latestDraft = drafts.at(-1);
  // Task artifact API is newest-first (created_at DESC), unlike drafts.
  const latestArtifact = artifacts[0];
  return <section aria-label="当前决策" className="task-decision-hero">
    <div className="task-decision-context"><span className="eyebrow"><span>{task.merchant_name}</span>{task.location_name ? <> · <span>{task.location_name}</span></> : null}</span><h1>{task.title}</h1></div>
    <div className="task-decision-main"><span className="eyebrow">CURRENT HUMAN DECISION</span><h2>{decision.heading}</h2><p>{decision.consequence}</p></div>
    <section aria-label="当前内容" className="task-current-content"><span className="eyebrow">当前内容 / 成品</span>
      {latestDraft ? <><strong>当前稿件 v{latestDraft.version}</strong><p>{latestDraft.body}</p>
        {(latestDraft.media_previews ?? []).map((preview) => <div className="task-media-preview" key={preview.deliverable_id}>
          {failedMedia.has(preview.deliverable_id)
            ? <span className="task-media-fallback" role="status">图片预览暂不可用；批准前请刷新重试。</span>
            : <>{!loadedMedia.has(preview.deliverable_id)
                ? <span className="task-media-fallback" role="status">图片加载中…</span>
                : null}<img
                alt={preview.alt_text}
                height="640"
                loading="lazy"
                onError={() => setFailedMedia((current) => new Set(current).add(preview.deliverable_id))}
                onLoad={() => setLoadedMedia((current) => new Set(current).add(preview.deliverable_id))}
                src={preview.download_path}
                width="640"
              /></>}
        </div>)}
        {latestDraft.cta_type ? <small>CTA：{latestDraft.cta_type}{latestDraft.cta_url ? ` · ${latestDraft.cta_url}` : ""}</small> : null}</>
        : latestArtifact ? <><strong>当前产物</strong><p>{latestArtifact.title}</p><small>{latestArtifact.summary}</small></>
          : <pre>{task.execution_spec}</pre>}
    </section>
    <div className="task-decision-action">{children ?? (decision.actionLabel ? <button className="primary-button" type="button">{decision.actionLabel}</button> : <p className="quiet-copy">当前账号可查看该决定，但没有执行权限。</p>)}</div>
  </section>;
}
