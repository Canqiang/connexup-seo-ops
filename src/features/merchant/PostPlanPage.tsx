import { Link, useParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { BackButton } from "../../app/BackButton";
import { formatDateOnly } from "../../app/format";
import { taskStatusLabel } from "../../app/statusCopy";
import { useAuth } from "../../auth/AuthContext";
import { hasPermission } from "../../auth/permissions";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { VoiceProfileEditor } from "./VoiceProfileEditor";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const POST_TYPES = [
  { key: "OFFER", label: "Offer", note: "促销转化 · 促销期 1–2/周 · CTA 直达" },
  { key: "STANDARD", label: "What's New", note: "新鲜度 + 关键词露出 · 默认档 ≥1/周" },
  { key: "EVENT", label: "Event", note: "活动发现流量 · 事件触发，不排固定档" },
];
const SIGNAL_LABEL: Record<string, string> = { IMPROVED: "↑ improved", FLAT: "→ flat", DECLINED: "↓ declined", INCONCLUSIVE: "？inconclusive" };

/** Post 周计划（商户子页）：选题由每周关键词分析驱动；类型与目标簇随稿件固定；
 * 建议未判定不落库。所有数据来自持久化投影，不展示推测值。 */
export function PostPlanPage() {
  const { merchantId = "" } = useParams<{ merchantId: string }>();
  const workspace = useWorkspace();
  const { user } = useAuth();
  usePageTitle("Post 周计划");
  const program = useResource((signal) => seoOpsApi.postProgram(merchantId, signal), [merchantId]);
  const cycle = useResource((signal) => seoOpsApi.cycleConfig(merchantId, signal), [merchantId]);
  const profile = useResource((signal) => seoOpsApi.styleProfile(merchantId, signal), [merchantId]);
  const ledger = useResource((signal) => seoOpsApi.cycleLedger(merchantId, signal), [merchantId]);
  const canManage = hasPermission(user?.permissions, "seoops.manage");
  const cfg = cycle.data;
  const cadence = cfg?.post_weekday !== null && cfg?.post_weekday !== undefined ? `每${WEEKDAYS[cfg.post_weekday]} ×${cfg.post_per_week}` : "暂停";
  const slots = (ledger.data?.items ?? []).filter((item) => item.record_kind === "TASK" && item.task_type === "GBP_POST");

  return <>
    <header className="page-heading"><div><BackButton fallback={`/merchants/${merchantId}`} label="返回商户" /><span className="eyebrow">MERCHANT · {workspace.merchant?.display_name ?? merchantId} · GBP POST</span><h1>Post 内容 · 周计划</h1>
      <p>周期 <strong>{cycle.loading ? "…" : cadence}</strong>（<Link to="/settings">设置 · 周期配置</Link>）· 选题由每周关键词分析驱动，类型与目标簇随稿件固定</p></div></header>

    <section aria-label="类型规约" className="post-types">{POST_TYPES.map((t) => <div key={t.key}><strong>{t.label}</strong><code>{t.key}</code><small>{t.note}</small></div>)}<p className="quiet-copy">类型不可合并为泛任务；类型 × 目标簇由选题建议给出，采纳后随 rev 固定。</p></section>

    <div className="post-plan-grid">
      <section aria-label="本周关键词表现" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">KEYWORD WEEKLY</span><h2>本周关键词表现</h2><p className="quiet-copy">按簇 · 周环比 · 关联信号（单店样本）</p></div></div>
        {program.loading ? <div className="page-state compact" role="status">读取周报…</div> : null}
        {program.data?.cluster_signals.length ? <div className="table-wrap"><table><thead><tr><th>关键词簇</th><th>表现</th><th>观察于</th></tr></thead><tbody>{program.data.cluster_signals.map((s) => <tr key={s.artifact_id + s.cluster}><td>{s.cluster}</td><td><span className={`status-pill is-${s.signal.toLowerCase()}`}>{SIGNAL_LABEL[s.signal]}</span></td><td>{formatDateOnly(s.observed_at)}</td></tr>)}</tbody></table></div> : program.data ? <p className="quiet-copy">本周尚无关键词周报信号。</p> : null}
        <p className="quiet-copy">表现分级为周环比关联信号；「处置」是 Planner 建议，判定采纳后才创建任务。</p>
      </section>

      <VoiceProfileEditor canManage={canManage} merchantId={merchantId} onSaved={profile.reload} profile={profile.data ?? null} />

      <section aria-label="本周档期" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">THIS WEEK</span><h2>本周档期</h2><p className="quiet-copy">采纳后即任务 · 双门与查证同 Task 页</p></div></div>
        {slots.length ? <ul className="program-list">{slots.map((s) => <li key={s.task_id}><strong>{s.title}</strong><span>{s.due_at ? formatDateOnly(s.due_at) : "未定时"} · {taskStatusLabel(s.status)}</span>{s.task_id ? <Link className="text-button" to={`/tasks/${s.task_id}`}>打开任务</Link> : null}</li>)}</ul> : <p className="quiet-copy">本周期没有 GBP Post 任务。</p>}
      </section>

      <section aria-label="下周候选" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">CANDIDATES · 建议未判定 · 不落库</span><h2>下周候选</h2></div></div>
        {program.data?.proposals.length ? <ul className="program-list">{program.data.proposals.map((p) => <li key={p.proposal_id}><strong>{p.title}</strong><span>{p.due_at ? formatDateOnly(p.due_at) : "—"} · {p.status === "VALIDATION_FAILED" ? `校验失败：${p.validation_failures.join("、")}` : "建议"}</span><Link className="text-button" to={`/inbox?tab=proposals&merchant_id=${encodeURIComponent(merchantId)}`}>去判定</Link></li>)}</ul> : <p className="quiet-copy">没有待判定的 Post 建议。</p>}
      </section>

      <section aria-label="历史发布" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">HISTORY · 发布 → 核验</span><h2>历史发布</h2><p className="quiet-copy">回读结论上限 ASSOCIATIONAL（单店样本）</p></div></div>
        {program.data?.history.length ? <ul className="program-list">{program.data.history.map((h) => <li key={h.task_id}><strong>{h.title}</strong><span>发布 {formatDateOnly(h.published_at)} · 核验 {formatDateOnly(h.verified_at)}</span><Link className="text-button" to={`/tasks/${h.task_id}`}>打开任务</Link></li>)}</ul> : <p className="quiet-copy">尚无已核验的发布。</p>}
      </section>
    </div>
    {program.data?.evidence_gaps.length ? <p className="quiet-copy">evidence_gaps：{program.data.evidence_gaps.join(" · ")}</p> : null}
  </>;
}
