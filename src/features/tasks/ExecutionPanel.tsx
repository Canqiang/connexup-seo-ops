import { CheckCircle2, ExternalLink, PlayCircle, RefreshCw, RotateCcw, SearchCheck, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { SeoTask } from "../../api/types";
import { formatDateOnly } from "../../app/format";
import { safeHref } from "../../app/format";
import { useResource } from "../../hooks/useResource";
import { ReconciliationDialog } from "./ReconciliationDialog";
import { ModeTag } from "../runs/RunsPage";

/** 执行面板（门 2 → attempt → 查证/核验）。门 1 批的是「能不能做」，这里管
 * 「做没做、做成没成」。所有校验都在服务端复核，这里只是预览与入口。 */
export function ExecutionPanel({ task, onReadback, compact = false, audit = false, canExecute }: {
  task: SeoTask; onReadback: (next: SeoTask) => void; compact?: boolean; audit?: boolean; canExecute: boolean;
}) {
  const mode = task.execution_mode;
  const attempts = useResource((signal) => seoOpsApi.attempts(task.id, signal), [task.id, task.state_version]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const [verifyNote, setVerifyNote] = useState("");
  const unknownAttempt = (attempts.data?.items ?? []).find((item) => item.status === "OUTCOME_UNKNOWN");

  if (mode === "MANUAL") {
    return <section className="data-panel execution-panel"><div className="panel-heading"><div><span className="eyebrow">EXECUTION</span><h2>执行</h2></div><ModeTag mode={mode} /></div>
      <div className="execution-body"><p className="quiet-copy">人工任务：完成后附加证据并走审批归档，无系统派发。</p></div></section>;
  }

  /** 统一的失败处理：409 = 任务已被别人/worker 推进 → 拉最新回读并说人话。 */
  const failedWith = async (reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 409) {
      try {
        onReadback(await seoOpsApi.task(task.id));
      } catch { /* 回读失败就保留原状态 */ }
      setError("任务状态已变化（可能已被处理），已刷新 —— 请按最新状态操作。");
      return;
    }
    setError(reason instanceof Error ? reason.message : fallback);
  };

  const confirm = async () => {
    setBusy(true); setError(undefined);
    try {
      // 每次点击一个新键：CAS（expected_state_version）负责挡重复，
      // 确定性键会把「过期客户端的真点击」错误地重放成 2xx 无操作。
      const next = await seoOpsApi.confirmExecution(task.id, {
        expected_state_version: task.state_version,
        idempotency_key: crypto.randomUUID(),
      });
      onReadback(next);
    } catch (reason) {
      await failedWith(reason, "执行确认失败");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true); setError(undefined);
    try {
      const next = await seoOpsApi.verifyTask(task.id, {
        ...(verifyNote.trim() ? { note: verifyNote.trim() } : {}),
        expected_state_version: task.state_version,
        idempotency_key: crypto.randomUUID(),
      });
      onReadback(next);
    } catch (reason) {
      await failedWith(reason, "核验失败");
    } finally {
      setBusy(false);
    }
  };

  const resetFailed = async () => {
    setBusy(true); setError(undefined);
    try {
      const next = await seoOpsApi.resetFailedTask(task.id, {
        expected_state_version: task.state_version,
        idempotency_key: crypto.randomUUID(),
      });
      onReadback(next);
    } catch (reason) {
      await failedWith(reason, "重置失败");
    } finally {
      setBusy(false);
    }
  };

  const publishedHref = safeHref(task.published_ref);

  const executionBody = <div className="execution-body">
      {mode === "READ_ONLY" ? <p className="quiet-copy">Ⓐ级只读：周期配置即预授权，scheduler 自动派发；失败自动重试至多 3 次后升级人工。</p> : null}

      {task.status === "APPROVED" && mode !== "READ_ONLY" ? canExecute
        ? <Gate2Block audit={audit} busy={busy} onConfirm={() => void confirm()} task={task} />
        : <p className="quiet-copy">当前账号可查看门 2 状态，但没有执行权限。</p> : null}

      {task.status === "DISPATCHING" ? <p className="exec-state"><PlayCircle size={14} /> attempt #{task.attempt_count} 派发在途，等待 core-ai 终态；worker 会自动结算。</p> : null}

      {task.status === "OUTCOME_UNKNOWN" ? <div className="exec-unknown">
        <p className="exec-state danger-text"><ShieldAlert size={14} /> 结果待查：动作发生没有无法确认。该商户执行链已冻结，查证是唯一出口。</p>
        {canExecute ? <button className="danger-button" disabled={!unknownAttempt} onClick={() => setResolving(true)} type="button">开始查证</button> : <p className="quiet-copy">当前账号没有执行权限，不能提交查证结论。</p>}
      </div> : null}

      {task.status === "PENDING_VERIFY" ? <div className="exec-verify">
        <p className="exec-state"><SearchCheck size={14} /> 已发布，待核验（{task.verify_due_at ? `${formatDateOnly(task.verify_due_at)} 到期` : "7 天窗口"}）。</p>
        {task.published_ref ? <p className="published-ref">发布引用：{publishedHref ? <a href={publishedHref} rel="noreferrer" target="_blank">{task.published_ref} <ExternalLink size={11} /></a> : <code>{task.published_ref}</code>}</p> : null}
        {canExecute ? <><label>核验说明（前台看到什么）
          <input onChange={(e) => setVerifyNote(e.target.value)} placeholder="例：GBP 前台可见 8/26 帖" value={verifyNote} /></label>
        <button className="primary-button" disabled={busy} onClick={() => void verify()} type="button"><CheckCircle2 size={14} /> 核验通过 → 归档</button></> : <p className="quiet-copy">当前账号没有执行权限，不能提交核验。</p>}
      </div> : null}

      {task.status === "DONE" ? <p className="exec-state"><CheckCircle2 size={14} /> 已完成{task.verified_at ? ` · ${formatDateOnly(task.verified_at)} 核验` : ""}{task.published_ref ? ` · ${task.published_ref}` : ""}</p> : null}
      {task.status === "FAILED" ? <div className="exec-unknown">
        <p className="exec-state danger-text"><XCircle size={14} /> 自动重试次数用尽，已升级人工处理。请先检查 agent 绑定与外部依赖，排障后可重置回「已批准」重新派发。</p>
        {canExecute ? <button className="secondary-button" disabled={busy} onClick={() => void resetFailed()} type="button"><RotateCcw size={13} /> {busy ? "重置中…" : "排障完成，重置回已批准"}</button> : <p className="quiet-copy">当前账号没有执行权限，不能重置失败任务。</p>}
      </div> : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}

    </div>;

  if (compact) return <div className="execution-panel is-compact">{executionBody}{resolving && unknownAttempt && canExecute ? <ReconciliationDialog attempt={unknownAttempt} onClose={() => setResolving(false)} onResolved={() => { setResolving(false); void seoOpsApi.task(task.id).then(onReadback); }} /> : null}</div>;

  return <section className="data-panel execution-panel">
    <div className="panel-heading"><div><span className="eyebrow">EXECUTION / 门 2 之后</span><h2>执行</h2></div><ModeTag mode={mode} /></div>
    {executionBody}
    <div className="attempt-list">
      <div className="attempt-head"><span className="eyebrow">ATTEMPTS / 一次派发一行</span>
        <button aria-label="刷新 attempts" className="icon-button" onClick={attempts.reload} type="button"><RefreshCw size={13} /></button></div>
      {(attempts.data?.items ?? []).length ? <table><thead><tr><th>#</th><th>门</th><th>状态</th><th>线索号</th><th>裁决</th></tr></thead><tbody>
        {(attempts.data?.items ?? []).map((a) => <tr key={a.id}>
          <td>{a.attempt_no}</td><td>{a.gate === "G2" ? "门2" : "自动"}</td>
          <td><span className={`status-pill ${a.status === "SUCCEEDED" ? "is-stable" : a.status === "DISPATCHING" ? "is-correlational" : a.status === "OUTCOME_UNKNOWN" ? "is-attention" : "is-blocked"}`}>{attemptLabel(a.status)}</span>{a.error ? <small title={a.error}>{a.error.slice(0, 40)}…</small> : null}</td>
          <td><code>{a.probe_ref}</code></td>
          <td>{a.resolution ? `${a.resolution === "HAPPENED" ? "发生了" : "没发生"} · ${a.resolved_by ?? ""}` : "—"}</td>
        </tr>)}
      </tbody></table> : <p className="quiet-copy">还没有派发记录。</p>}
    </div>
    {resolving && unknownAttempt && canExecute ? <ReconciliationDialog attempt={unknownAttempt} onClose={() => setResolving(false)} onResolved={() => { setResolving(false); void seoOpsApi.task(task.id).then(onReadback); }} /> : null}
  </section>;
}

function attemptLabel(status: string): string {
  return status === "DISPATCHING" ? "在途" : status === "SUCCEEDED" ? "成功"
    : status === "FAILED_CONFIRMED" ? "确认失败" : "结果待查";
}

/** 门 2 预览块：六项服务端校验逐条亮灯，全过才放行确认按钮。 */
function Gate2Block({ task, busy, onConfirm, audit }: { task: SeoTask; busy: boolean; onConfirm: () => void; audit: boolean }) {
  const preview = useResource((signal) => seoOpsApi.executionPreview(task.id, signal), [task.id, task.state_version]);
  const checks = preview.data?.checks ?? [];
  const firstFailure = checks.find((check) => !check.passed);
  const visibleChecks = audit ? checks : firstFailure ? [firstFailure] : preview.data?.confirmable
    ? [{ key: "operator-pass", label: "校验通过", detail: "服务端校验通过，可确认发布。", passed: true }]
    : [];
  return <div className="gate2-block">
    <p className="exec-state">门 2 · 执行确认（独立于门 1 审批的第二道人工动作）</p>
    {preview.loading ? <p className="quiet-copy">校验中…</p> : <ul className="gate-checks">
      {visibleChecks.map((c) => <li className={c.passed ? "is-pass" : "is-fail"} key={c.key}>
        {c.passed ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        <span>{c.label}</span><small>{c.detail}</small>
      </li>)}
    </ul>}
    <button className="primary-button" disabled={busy || !preview.data?.confirmable} onClick={onConfirm} type="button">
      <PlayCircle size={14} /> {busy ? "确认中…" : "确认现在发布"}
    </button>
    {preview.data && !preview.data.confirmable ? <p className="quiet-copy">有校验未通过：修复能力矩阵 / 等查证完成后重试。</p> : null}
  </div>;
}
