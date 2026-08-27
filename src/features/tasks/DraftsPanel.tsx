import { Bot, FileCheck2, ImageUp, PenLine, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateTime } from "../../app/format";
import type { SeoTask, StageRunView } from "../../api/types";
import { useResource } from "../../hooks/useResource";

const CONTENT_RUN_POLL_INTERVAL_MS = 1_500;
const CONTENT_AGENT_EDITABLE_STATUSES = new Set([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "REVISION_REQUIRED", "APPROVAL_REVOKED",
]);

type GenerationState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "running"; runId: string }
  | { phase: "completed"; runId: string }
  | { phase: "failed"; message: string; runId?: string };

function terminalRun(run: StageRunView): boolean {
  return run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED";
}

function userSafeGenerationFailure(run: StageRunView): string {
  if (run.status === "CANCELLED") return "生成已取消；系统没有保存或发布内容。";
  if (run.error_code === "OUTPUT_INVALID") {
    return "Agent 返回的门店或内容信息不一致，系统已阻止保存。请重新生成。";
  }
  if (run.error_code === "GBP_POST_IMAGE_MISSING") {
    return "图片没有完整生成，系统已阻止保存。请重新生成。";
  }
  return "图文生成暂未完成，请重新生成；系统不会发布任何内容。";
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, CONTENT_RUN_POLL_INTERVAL_MS);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 内容稿面板（Ⓑ/Ⓒ 内容类任务）：每版一行留痕；「定稿」把该版哈希挂进证据链，
 * 审批哈希因此锁定这份稿 —— 批过再改一个字都得重批。 */
export function DraftsPanel({ task, onReadback, canReopen = true }: {
  task: SeoTask; onReadback: (next: SeoTask) => void; canReopen?: boolean;
}) {
  const drafts = useResource((signal) => seoOpsApi.drafts(task.id, signal), [task.id, task.state_version]);
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [altText, setAltText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenMessage, setReopenMessage] = useState("");
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState<GenerationState>({ phase: "idle" });
  const generationController = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    setGeneration({ phase: "idle" });
    return () => generationController.current?.abort();
  }, [task.id]);

  const needsDraft = task.required_evidence_types.includes("CONTENT_DRAFT");
  const canGenerate = task.task_type === "GBP_POST"
    && task.execution_mode === "AUTO_WRITE"
    && CONTENT_AGENT_EDITABLE_STATUSES.has(task.status);
  if (!needsDraft && !(drafts.data?.items.length) && !canGenerate) return null;

  const finalizedVersions = new Set(
    task.evidence_refs
      .filter((e) => e.requirement_key === "CONTENT_DRAFT" && e.task_revision === task.task_revision && e.source_ref)
      .map((e) => Number(/:v(\d+)$/.exec(e.source_ref ?? "")?.[1] ?? 0)),
  );
  const canEdit = ["DRAFT", "NEEDS_INPUT", "BLOCKED", "REVISION_REQUIRED", "APPROVAL_REVOKED"].includes(task.status);
  const canReopenFinal = task.task_type === "GBP_POST"
    && canReopen
    && (task.status === "READY_FOR_APPROVAL" || task.status === "APPROVED");
  const draftItems = drafts.data?.items ?? [];
  const latestDraft = draftItems.at(-1);

  const toggleEditor = () => {
    setAdding((open) => {
      const next = !open;
      if (next) {
        setBody(latestDraft?.body ?? "");
        setAltText(latestDraft?.media_previews?.[0]?.alt_text ?? `${task.merchant_name} GBP Post image`);
        setSelectedFile(undefined);
      }
      return next;
    });
  };

  const reopenFinal = async () => {
    if (!canReopenFinal || reopening) return;
    const wasApproved = task.status === "APPROVED";
    setReopening(true);
    setReopenMessage("");
    try {
      let current = task;
      if (current.status === "APPROVED") {
        current = await seoOpsApi.approvalDecision(current.id, {
          decision: "REVOKE",
          reason: "操作员撤销已批准稿件，以继续修改或重新生成 GBP Post。",
          task_revision: current.task_revision,
          execution_spec_hash: current.execution_spec_hash,
          expected_state_version: current.state_version,
          idempotency_key: crypto.randomUUID(),
        });
      }
      const executionSpec = JSON.parse(current.execution_spec) as Record<string, unknown>;
      delete executionSpec.content_draft;
      delete executionSpec.regeneration_request;
      const next = await seoOpsApi.createRevision(current.id, {
        definition: {
          title: current.title,
          task_type: current.task_type,
          source: current.source,
          priority: current.priority,
          impact: current.impact,
          ...(current.owner_id ? { owner_id: current.owner_id } : {}),
          ...(current.due_at ? { due_at: current.due_at } : {}),
          execution_spec: JSON.stringify(executionSpec),
          required_evidence_types: current.required_evidence_types,
          execution_mode: current.execution_mode,
        },
        expected_state_version: current.state_version,
        idempotency_key: crypto.randomUUID(),
      });
      setGeneration({ phase: "idle" });
      setReopenMessage(wasApproved
        ? "已撤销批准并打开新版本；原定稿和审批记录已保留，可以继续修改或重新生成。"
        : "已撤销定稿并打开新版本；原定稿已保留，可以继续修改或重新生成。");
      onReadback(next);
    } catch {
      setReopenMessage("撤销没有完整保存，请刷新任务后重试；现有稿件不会被覆盖。");
    } finally {
      setReopening(false);
    }
  };

  const generateDraft = async () => {
    if (!canGenerate || drafts.loading || drafts.error
      || generation.phase === "submitting" || generation.phase === "running") return;
    const retryRunId = generation.phase === "failed" ? generation.runId : undefined;
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    setGeneration({ phase: "submitting" });
    setError(undefined);
    try {
      let priorRunId = retryRunId;
      let retryMode: "RETRY" | "REGENERATE" | undefined = retryRunId ? "RETRY" : undefined;
      let run: StageRunView | undefined;
      const history = await seoOpsApi.stageRuns(
        task.merchant_id,
        { stage: "GBP_POST_CONTENT", limit: 50 },
        controller.signal,
      );
      const latestForTask = history.items.find((item) => item.task_id === task.id);
      if (latestForTask && !terminalRun(latestForTask)) run = latestForTask;
      const visibleDraftRunIds = new Set(draftItems.flatMap((draft) => [
        draft.agent_run_id,
        draft.media_source_agent_run_id,
      ].filter((id): id is string => Boolean(id))));
      if (!run && latestForTask?.status === "COMPLETED" && !visibleDraftRunIds.has(latestForTask.id)) {
        drafts.reload();
        setGeneration({ phase: "completed", runId: latestForTask.id });
        return;
      }
      if (!run && !priorRunId && (latestForTask?.status === "FAILED" || latestForTask?.status === "CANCELLED")) {
        priorRunId = latestForTask.id;
        retryMode = "RETRY";
      }
      if (!run && !priorRunId && draftItems.length > 0) {
        priorRunId = latestForTask?.status === "COMPLETED"
          ? latestForTask.id
          : (latestDraft?.agent_run_id ?? latestDraft?.media_source_agent_run_id ?? undefined);
        retryMode = priorRunId ? "REGENERATE" : undefined;
      }
      if (!run) {
        const request = {
          idempotency_key: crypto.randomUUID(),
          ...(priorRunId ? {
            retry: {
              prior_run_id: priorRunId,
              reason: retryMode === "REGENERATE"
                ? "操作员明确要求在保留现有草稿的前提下重新生成一版全新的 GBP Post 图文。"
                : "上次生成未通过门店、内容或附件校验，操作员请求沿同一任务安全重试。",
              mode: retryMode,
            },
          } : {}),
        };
        try {
          run = await seoOpsApi.triggerGbpPostContent(task.id, request);
        } catch (reason) {
          // A changed Task/style/Agent fingerprint is a new business input, not
          // a retry branch. Start its first generation without discarding old drafts.
          if (!(reason instanceof ApiError)
            || reason.code !== "CONTENT_RUN_RETRY_LINEAGE_MISMATCH"
            || retryMode !== "REGENERATE") throw reason;
          run = await seoOpsApi.triggerGbpPostContent(task.id, {
            idempotency_key: crypto.randomUUID(),
          });
        }
      }
      if (controller.signal.aborted) return;
      if (!terminalRun(run)) setGeneration({ phase: "running", runId: run.id });
      while (!terminalRun(run)) {
        await waitForNextPoll(controller.signal);
        run = await seoOpsApi.stageRun(run.id, controller.signal);
        if (controller.signal.aborted) return;
        if (!terminalRun(run)) setGeneration({ phase: "running", runId: run.id });
      }
      if (run.status !== "COMPLETED") {
        setGeneration({
          phase: "failed",
          runId: run.id,
          message: userSafeGenerationFailure(run),
        });
        return;
      }

      // Core run 完成只代表图文已落为本地草稿，不代表 GBP 已发布。
      drafts.reload();
      setGeneration({ phase: "completed", runId: run.id });
      try {
        const next = await seoOpsApi.task(task.id, controller.signal);
        if (!controller.signal.aborted) onReadback(next);
      } catch {
        // 稿件已独立刷新；任务聚合仍可由页面刷新按钮再次读取。
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      setGeneration({
        phase: "failed",
        message: "生成请求暂时不可用，请稍后重试；系统不会发布任何内容。",
      });
    } finally {
      if (generationController.current === controller) generationController.current = undefined;
    }
  };

  const addHumanDraft = async () => {
    if (!body.trim()) return;
    setBusy(true); setError(undefined);
    try {
      let media = latestDraft?.media ?? [];
      if (task.task_type === "GBP_POST") {
        const runId = latestDraft?.agent_run_id ?? latestDraft?.media_source_agent_run_id;
        if (!latestDraft || !runId) throw new Error("请先用 Core AI 生成一版图文草稿，再进行人工修改。");
        if (selectedFile) {
          if (!['image/png', 'image/jpeg'].includes(selectedFile.type)) throw new Error("图片只支持 PNG 或 JPEG。");
          if (selectedFile.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10MB。");
          if (!altText.trim()) throw new Error("请填写图片说明。");
          const contentBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("图片读取失败。"));
            reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
            reader.readAsDataURL(selectedFile);
          });
          const uploaded = await seoOpsApi.uploadManualDeliverable(runId, {
            file_name: selectedFile.name,
            content_type: selectedFile.type,
            content_base64: contentBase64,
          });
          if (!uploaded.sha256) throw new Error("图片上传后缺少校验值。");
          media = [JSON.stringify({
            alt_text: altText.trim(),
            deliverable_id: uploaded.id,
            schema_version: "seo_ops.media_ref.v1",
            sha256: uploaded.sha256,
          })];
        }
      }
      const next = await seoOpsApi.addDraftRevision(task.id, {
        body: body.trim(),
        cta_type: latestDraft?.cta_type ?? undefined,
        cta_url: latestDraft?.cta_url ?? undefined,
        media,
        source: "HUMAN_EDIT", expected_state_version: task.state_version,
        idempotency_key: crypto.randomUUID(),
      });
      setBody(""); setAltText(""); setSelectedFile(undefined); setAdding(false); drafts.reload(); onReadback(next);
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

  const generationLocked = generation.phase === "submitting"
    || generation.phase === "running"
    || drafts.loading
    || Boolean(drafts.error);
  const hasGeneratedDraft = draftItems.length > 0 || generation.phase === "completed";
  const generationButtonLabel = generation.phase === "submitting" ? "正在提交…"
    : generation.phase === "running" ? "正在生成图文…"
      : generation.phase === "failed" ? "重试生成图文"
        : drafts.loading ? "读取草稿…"
          : drafts.error ? "草稿读取失败"
        : hasGeneratedDraft ? "重新生成"
          : "Core AI 生成图文草稿";

  return <section aria-label="内容稿" className="data-panel drafts-panel" id="gbp-drafts-panel">
    <div className="panel-heading"><div><span className="eyebrow">GBP POST / 图文草稿</span><h2><PenLine size={15} /> 生成与修改</h2><p className="quiet-copy">沿用本店历史 Post 风格；优先使用商户菜品实拍，AI 图片会明确标注。</p></div>
      <div className="heading-actions">
        {canGenerate ? <button className="primary-button" disabled={generationLocked} onClick={() => void generateDraft()} type="button"><Bot size={13} /> {generationButtonLabel}</button> : null}
        {canReopenFinal ? <button className="secondary-button" disabled={reopening} onClick={() => void reopenFinal()} type="button">{reopening ? "正在撤销…" : task.status === "APPROVED" ? "撤销批准并继续修改" : "撤销定稿并继续修改"}</button> : null}
        {canEdit && (task.task_type !== "GBP_POST" || latestDraft) ? <button className="secondary-button" onClick={toggleEditor} type="button"><Plus size={13} /> {task.task_type === "GBP_POST" ? "修改文案 / 换商户实拍" : "人工新稿"}</button> : null}
      </div></div>
    {reopenMessage ? <p className="form-message" role="status">{reopenMessage}</p> : null}
    {canGenerate ? <p className="quiet-copy">生成英文文案与 1 张图片；也可上传商户实拍替换，批准前都不会发布。</p> : null}
    {generation.phase === "submitting" ? <p className="page-state compact" role="status">正在提交生成请求…</p> : null}
    {generation.phase === "running" ? <p className="page-state compact" role="status">Core AI 正在生成英文 Post 文案与图片…</p> : null}
    {generation.phase === "completed" ? <p className="page-state compact" role="status">图文草稿和图片已生成，尚未发布。</p> : null}
    {generation.phase === "failed" ? <p className="form-error" role="alert">图文草稿生成失败：{generation.message}</p> : null}
    {adding ? <div className="draft-editor">
      <label>Post 正文<textarea aria-label="Post 正文" onChange={(e) => setBody(e.target.value)} placeholder="Post 正文（商户口吻，避开违禁词）…" rows={5} value={body} /></label>
      {task.task_type === "GBP_POST" ? <div className="draft-media-editor">
        <label><ImageUp size={14} /> 替换图片<input accept="image/png,image/jpeg" aria-label="替换图片" onChange={(event) => setSelectedFile(event.target.files?.[0])} type="file" /></label>
        <label>图片说明<input aria-label="图片说明" onChange={(event) => setAltText(event.target.value)} value={altText} /></label>
        <small>{selectedFile ? `${selectedFile.name} · ${(selectedFile.size / 1024 / 1024).toFixed(2)}MB` : "不选择文件则保留当前图片"}</small>
      </div> : null}
      <div><button className="primary-button" disabled={busy || !body.trim()} onClick={() => void addHumanDraft()} type="button">{busy ? "正在保存…" : "保存新版本"}</button></div>
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
          {d.media_previews?.map((preview) => <figure className="draft-media-preview" key={preview.deliverable_id}>
            <img alt={preview.alt_text} loading="lazy" src={preview.download_path} />
            <figcaption><span className={`media-origin is-${(preview.origin ?? "AI_GENERATED").toLocaleLowerCase()}`}>{preview.origin === "OPERATOR_UPLOAD" ? "人工上传商户素材" : "AI 生成图"}</span>{preview.alt_text}</figcaption>
          </figure>)}
          {d.cta_url ? <small className="quiet-copy">CTA：{d.cta_type ?? "LINK"} → {d.cta_url}</small> : null}
        </li>)}
      </ul>}
  </section>;
}
