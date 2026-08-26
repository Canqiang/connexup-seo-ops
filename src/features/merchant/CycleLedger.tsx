import { Link } from "react-router-dom";
import type { CycleLedgerItem, CycleLedgerView } from "../../api/types";

export function CycleLedger({ data, loading, merchantId }: { data: CycleLedgerView | null; loading: boolean; merchantId: string }) {
  return <section aria-label="本周期账本" className="data-panel cycle-ledger"><div className="panel-heading"><div><span className="eyebrow">ACTIVE CYCLE · DATED LEDGER</span><h2>本周期账本</h2></div><span className="result-count">任务与建议按记录类型分列</span></div>{loading && !data ? <div className="page-state" role="status">读取周期账本…</div> : null}{data && data.items.length === 0 ? <p className="unavailable">活跃周期暂无持久化任务或建议。</p> : null}{data?.items.length ? <div className="cycle-ledger-scroll"><table><thead><tr><th>时间</th><th>事项</th><th>依赖 / 波次</th><th>负责人 / 模式</th><th>状态</th><th>动作</th></tr></thead><tbody>{data.items.map((item) => <LedgerRow item={item} key={`${item.record_kind}-${item.task_id ?? item.proposal_id}`} merchantId={merchantId} />)}</tbody></table></div> : null}</section>;
}

function LedgerRow({ item, merchantId }: { item: CycleLedgerItem; merchantId: string }) {
  const isProposal = item.record_kind === "PROPOSAL";
  const date = item.due_at ?? item.created_at;
  return <tr className={isProposal ? "is-proposal" : undefined} data-record-kind={item.record_kind}><td data-label="时间"><time dateTime={date}>{new Date(date).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}</time></td><td data-label="事项"><strong>{item.title}</strong><small>{isProposal ? "建议待判定" : item.task_type}</small></td><td data-label="依赖 / 波次">{item.dependency_labels.length ? item.dependency_labels.join(" · ") : "无已记录依赖"}</td><td data-label="负责人 / 模式">{item.owner_id ?? "未指派"} · {item.execution_mode}</td><td data-label="状态"><span className={`status-pill is-${item.status.toLowerCase()}`}>{item.status}</span>{item.validation_failures.length ? <small>{item.validation_failures.join("；")}</small> : null}</td><td data-label="动作">{isProposal ? <Link className="text-button" to={`/inbox?merchant_id=${encodeURIComponent(merchantId)}&tab=proposals`}>去判定</Link> : item.task_id ? <Link className="text-button" to={`/tasks/${encodeURIComponent(item.task_id)}`}>查看任务</Link> : <span className="quiet-copy">记录缺少任务标识</span>}</td></tr>;
}
