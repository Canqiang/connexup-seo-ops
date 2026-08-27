import { Link } from "react-router-dom";
import type { SpecialistArtifactWire } from "../../api/types";
import { formatDateOnly } from "../../app/format";
import { tierLabel } from "../reviews/reviewCopy";

export function ReviewSignalPanel({ merchantId, artifacts, loading }: { merchantId: string; artifacts: SpecialistArtifactWire[]; loading: boolean }) {
  const latest = artifacts.filter((a) => a.artifact_type === "EFFECT_REVIEW").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const tier = typeof latest?.payload.conclusion_tier === "string" ? latest.payload.conclusion_tier : "INSUFFICIENT_EVIDENCE";
  return <section aria-label="复盘信号" className="data-panel review-signal-panel">
    <div className="panel-heading"><div><span className="eyebrow">OUTCOME REVIEW</span><h2>复盘信号</h2></div></div>
    {loading ? <div className="page-state compact" role="status">读取复盘…</div> : latest ? <>
      <p><strong>{latest.title}</strong> · {formatDateOnly(latest.created_at)}</p>
      <p><span className="status-pill is-stable">{tierLabel(tier)}</span></p>
      <p className="quiet-copy">{String(latest.payload.conclusion ?? latest.summary)}</p>
      <Link className="text-button" to={`/reviews?merchant_id=${encodeURIComponent(merchantId)}`}>打开复盘 ›</Link>
    </> : <p className="quiet-copy">首轮执行完成并到达复盘窗口后开启：基线 → 动作 → 可比复测 → 证据强度结论（上限 ASSOCIATIONAL）。</p>}
  </section>;
}
