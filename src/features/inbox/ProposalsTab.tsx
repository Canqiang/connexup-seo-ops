import { ArrowRight, Check, CornerUpLeft, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateTime } from "../../app/format";
import type { ProposalWire } from "../../api/types";
import { useResource } from "../../hooks/useResource";

/** 待判定：建议批次 → 逐条采纳（成任务）/ 退回（必填理由）。
 * 校验失败的条目只能退回 —— 坏建议不落库是红线，不给「强行采纳」入口。 */
export function ProposalsTab({ merchantId }: { merchantId?: string }) {
  const navigate = useNavigate();
  const resource = useResource((signal) => seoOpsApi.proposalBatches(merchantId, signal), [merchantId]);
  const [busy, setBusy] = useState<string>();
  const [returning, setReturning] = useState<ProposalWire>();
  const [error, setError] = useState<string>();

  const adopt = async (proposal: ProposalWire) => {
    setBusy(proposal.id); setError(undefined);
    try {
      const result = await seoOpsApi.decideProposal(proposal.id, { action: "ADOPT" });
      resource.reload();
      if (result.task_id) navigate(`/tasks/${result.task_id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "采纳失败");
    } finally {
      setBusy(undefined);
    }
  };

  const batches = resource.data?.items ?? [];
  const open = batches.filter((b) => b.status === "OPEN");
  const closed = batches.filter((b) => b.status === "CLOSED");

  return <>
    <div className="panel-heading"><div><span className="eyebrow">PENDING JUDGEMENT / 建议批次</span><p className="quiet-copy">采纳 = 以「建议」为来源建任务并回链；退回必须给理由，留给 Planner 学习。</p></div>
      <button aria-label="刷新建议" className="icon-button" onClick={resource.reload} type="button"><RefreshCw size={15} /></button></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {resource.loading ? <div className="page-state" role="status">读取建议批次…</div> : null}
    {!resource.loading && !open.length ? <div className="empty-state slim"><p>没有待判定的建议。Planner 出批次后会在这里排队。</p></div> : null}
    {open.map((batch) => <section className="batch-card" key={batch.id}>
      <header><div><strong>{batch.merchant_name ?? batch.merchant_id}</strong>
        <small>{originLabel(batch.origin)} · {batch.trigger_reason ?? "无触发说明"} · {formatDateTime(batch.created_at)}</small></div>
        <span className="result-count">{batch.proposals.filter((p) => p.status === "PENDING" || p.status === "VALIDATION_FAILED").length} 条待判定</span></header>
      <div className="table-wrap"><table><thead><tr><th>#</th><th>建议</th><th>类型 / 模式</th><th>优先级</th><th>校验</th><th>判定</th></tr></thead><tbody>
        {batch.proposals.map((p) => <tr className={p.status === "VALIDATION_FAILED" ? "is-invalid-row" : undefined} key={p.id}>
          <td>{p.seq}{p.depends_on.length ? <small>依赖 {p.depends_on.join(",")}</small> : null}</td>
          <td><strong>{p.title}</strong>{p.acceptance_criteria ? <small>{p.acceptance_criteria}</small> : null}</td>
          <td>{p.task_type}<small>{modeLabel(p.execution_mode)}</small></td>
          <td><span className={`priority-tag is-${p.priority.toLocaleLowerCase()}`}>{p.priority}</span></td>
          <td>{p.validation_failures.length
            ? <span className="status-pill is-blocked" title={p.validation_failures.join("\n")}>失败 ×{p.validation_failures.length}</span>
            : <span className="status-pill is-stable">通过</span>}</td>
          <td className="decision-cell">{decisionCell(p)}</td>
        </tr>)}
      </tbody></table></div>
    </section>)}
    {closed.length ? <details className="closed-batches"><summary>已关闭批次（{closed.length}）</summary>
      {closed.map((batch) => <section className="batch-card is-closed" key={batch.id}>
        <header><div><strong>{batch.merchant_name ?? batch.merchant_id}</strong><small>{originLabel(batch.origin)} · {formatDateTime(batch.created_at)}</small></div>
          <span className="result-count">{batch.proposals.filter((p) => p.status === "ADOPTED").length} 采纳 / {batch.proposals.filter((p) => p.status === "RETURNED").length} 退回</span></header>
      </section>)}
    </details> : null}
    {returning ? <ReturnDialog proposal={returning} onClose={() => setReturning(undefined)} onDone={() => { setReturning(undefined); resource.reload(); }} /> : null}
  </>;

  function decisionCell(p: ProposalWire) {
    if (p.status === "ADOPTED") return <span className="quiet-copy">已采纳{p.task_id ? <button className="text-button" onClick={() => navigate(`/tasks/${p.task_id}`)} type="button">任务 <ArrowRight size={11} /></button> : null}</span>;
    if (p.status === "RETURNED") return <span className="quiet-copy" title={p.return_reason ?? undefined}>已退回</span>;
    return <div className="decision-actions">
      {p.status === "PENDING" ? <button className="primary-button" disabled={busy === p.id} onClick={() => void adopt(p)} type="button"><Check size={13} /> 采纳</button> : null}
      <button className="secondary-button" disabled={busy === p.id} onClick={() => setReturning(p)} type="button"><CornerUpLeft size={13} /> 退回</button>
    </div>;
  }
}

function originLabel(origin: string): string {
  return origin === "PLANNER" ? "Planner 建议" : origin === "PLAN_CONVERT" ? "Plan 拆解" : "人工提报";
}

function modeLabel(mode: string): string {
  return mode === "READ_ONLY" ? "Ⓐ 只读" : mode === "ARTIFACT" ? "Ⓑ 成品" : mode === "AUTO_WRITE" ? "Ⓒ 写入" : "人工";
}

function ReturnDialog({ proposal, onClose, onDone }: {
  proposal: ProposalWire; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!reason.trim()) { setError("退回必须给理由。"); return; }
    setBusy(true); setError(undefined);
    try {
      await seoOpsApi.decideProposal(proposal.id, { action: "RETURN", return_reason: reason.trim() });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "退回失败");
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="退回建议">
    <div className="modal-card slim">
      <header className="modal-head"><div><span className="eyebrow">RETURN / 退回建议</span><h2>#{proposal.seq} {proposal.title}</h2></div></header>
      <div className="modal-body">
        {proposal.validation_failures.length ? <p className="quiet-copy">校验失败：{proposal.validation_failures.join("、")}</p> : null}
        <label>退回理由（写给 Planner 的反馈，必填）
          <textarea onChange={(e) => setReason(e.target.value)} rows={3} value={reason} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="modal-foot"><span />
        <div><button className="secondary-button" onClick={onClose} type="button">取消</button>
          <button className="danger-button" disabled={busy} onClick={() => void submit()} type="button">{busy ? "提交中…" : "退回"}</button></div></footer>
    </div>
  </div>;
}
