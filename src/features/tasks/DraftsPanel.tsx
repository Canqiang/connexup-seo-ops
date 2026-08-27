import { Bot, FileCheck2, PenLine, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
export function DraftsPanel({ task, onReadback }: {
  task: SeoTask; onReadback: (next: SeoTask) => void;
}) {
  const drafts = useResource((signal) => seoOpsApi.drafts(task.id, signal), [task.id, task.state_version]);
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
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
  const canEdit = ["DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL", "APPROVED"].includes(task.status);

  const generateDraft = async () => {
    if (!canGenerate || generation.phase !== "idle") return;
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    setGeneration({ phase: "submitting" });
    setError(undefined);
    try {
      let run = await seoOpsApi.triggerGbpPostContent(task.id, {
        idempotency_key: crypto.randomUUID(),
      });
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
          message: run.error || run.error_code || (run.status === "CANCELLED" ? "生成已取消" : "Core AI 运行失败"),
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
        message: reason instanceof Error ? reason.message : "生成请求失败",
      });
    } finally {
      if (generationController.current === controller) generationController.current = undefined;
    }
  };

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

  const generationLocked = generation.phase !== "idle";
  const generationButtonLabel = generation.phase === "submitting" ? "正在提交…"
    : generation.phase === "running" ? "正在生成图文…"
      : generation.phase === "completed" ? "图文草稿已生成"
        : generation.phase === "failed" ? "图文生成失败"
          : "Core AI 生成图文草稿";

  return <section aria-label="内容稿" className="data-panel drafts-panel">
    <div className="panel-heading"><div><span className="eyebrow">CONTENT DRAFTS / 内容稿</span><h2><PenLine size={15} /> 稿件迭代</h2><p className="quiet-copy">agent 初稿 → 反馈重写 / 人工改 → 定稿进证据链。没有定稿，任务到不了审批。</p></div>
      <div className="heading-actions">
        {canGenerate ? <button className="primary-button" disabled={generationLocked} onClick={() => void generateDraft()} type="button"><Bot size={13} /> {generationButtonLabel}</button> : null}
        {canEdit ? <button className="secondary-button" onClick={() => setAdding((v) => !v)} type="button"><Plus size={13} /> 人工新稿</button> : null}
      </div></div>
    {canGenerate ? <p className="quiet-copy">生成英文 GBP Post 文案与 1 张图片；只保存为草稿，不会发布到 Google。</p> : null}
    {generation.phase === "submitting" ? <p className="page-state compact" role="status">正在提交生成请求…</p> : null}
    {generation.phase === "running" ? <p className="page-state compact" role="status">Core AI 正在生成英文 Post 文案与图片…</p> : null}
    {generation.phase === "completed" ? <p className="page-state compact" role="status">图文草稿和图片已生成，尚未发布。</p> : null}
    {generation.phase === "failed" ? <p className="form-error" role="alert">图文草稿生成失败：{generation.message}</p> : null}
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
