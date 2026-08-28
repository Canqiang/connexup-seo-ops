import { Link } from "react-router-dom";
import type { PostProgramView } from "../../api/types";
import { safeHref } from "../../app/format";

export function PostProgramPanel({ data, loading, error, onRetry, merchantId }: { data: PostProgramView | null; loading: boolean; error?: unknown; onRetry: () => void; merchantId: string }) {
  const message = error instanceof Error ? error.message : "未知错误";
  return <section aria-label="Post 计划" className="data-panel post-program-panel"><div className="panel-heading"><div><span className="eyebrow">POST PROGRAM · PERSISTED SIGNALS</span><h2>Post 计划</h2></div><Link className="text-button" to={`/merchants/${encodeURIComponent(merchantId)}/post-plan`}>打开 Post 周计划 ›</Link></div>{error ? <div aria-label="Post 计划读取失败" className="page-state is-error" role="alert"><strong>evidence_gaps</strong> · {message}<button onClick={onRetry} type="button">重试</button></div> : null}{loading && !data && !error ? <div className="page-state" role="status">读取 Post 计划…</div> : null}{data?.voice_profile && !error ? <div className="program-meta"><strong>语气版本 v{data.voice_profile.version}</strong><ul>{data.voice_profile.summary.map((field) => <li key={field.key}>{field.label}：{field.value}</li>)}</ul><small>建立于 {formatDate(data.voice_profile.created_at)}</small></div> : null}{data?.cluster_signals.length && !error ? <ul className="program-list">{data.cluster_signals.map((signal) => <SignalRow key={signal.artifact_id} signal={signal} />)}</ul> : null}{data?.history.length && !error ? <ul className="program-list">{data.history.map((entry) => <HistoryRow key={entry.task_id} entry={entry} />)}</ul> : null}{data && !error && !data.voice_profile && !data.cluster_signals.length && !data.history.length && !data.evidence_gaps.length ? <p className="unavailable">暂无已持久化的 Post 计划证据。</p> : null}{data?.evidence_gaps.length && !error ? <div className="evidence-gaps"><strong>evidence_gaps</strong><ul>{data.evidence_gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul><Link className="text-button" to={`/inbox?merchant_id=${encodeURIComponent(merchantId)}&tab=proposals`}>查看相关判定</Link></div> : null}</section>;
}

function SignalRow({ signal }: { signal: PostProgramView["cluster_signals"][number] }) {
  const evidenceHref = safeHref(signal.evidence_ref);
  return <li><span>目标簇：{signal.cluster}</span><span>证据信号：{signal.signal}</span><small>观察于 {formatDate(signal.observed_at)} · {evidenceHref ? <a href={evidenceHref} rel="noreferrer" target="_blank">证据来源 ↗</a> : signal.evidence_ref ? "证据链接不安全" : "证据链接未提供"}</small></li>;
}

function HistoryRow({ entry }: { entry: PostProgramView["history"][number] }) {
  const publishedHref = safeHref(entry.published_ref);
  return <li><strong>{entry.title}</strong><span>发布：{formatDate(entry.published_at)}</span><span>核验：{formatDate(entry.verified_at)}{entry.verified_by ? ` · ${entry.verified_by}` : ""}</span>{publishedHref ? <a className="text-button" href={publishedHref} rel="noreferrer" target="_blank">打开发布记录 ↗</a> : <span className="quiet-copy">发布链接不安全</span>}</li>;
}

function formatDate(value: string) { return new Date(value).toLocaleString("zh-CN"); }
