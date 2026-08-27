import type { LifecycleView, ReportItem, SpecialistArtifactWire } from "../../api/types";
import { safeHref } from "../../app/format";

export function ReportsDataPanel({ reports, artifacts, loading, error, onRetry, questionnaire }: { reports: ReportItem[]; artifacts: SpecialistArtifactWire[]; loading: boolean; error?: unknown; onRetry: () => void; questionnaire?: LifecycleView["questionnaire"] }) {
  const message = error instanceof Error ? error.message : "未知错误";
  return <section aria-label="报告与数据" className="data-panel reports-data-panel"><div className="panel-heading"><div><span className="eyebrow">PERSISTED REPORTS / ARTIFACTS</span><h2>报告与数据</h2></div></div>
    <ul className="evidence-list"><li><strong>品牌档案 · 来自问卷</strong><small>{questionnaire?.status === "FILLED" ? `${formatDate(questionnaire.filled_at!)} 回收 · 已落库` : questionnaire?.status === "SENT" ? "等问卷回收（已发出）" : "未生成问卷"}</small></li></ul>
    {error ? <div aria-label="报告与数据读取失败" className="page-state is-error" role="alert"><strong>evidence_gaps</strong> · {message}<button onClick={onRetry} type="button">重试</button></div> : null}{loading && !error ? <div className="page-state" role="status">读取报告与数据…</div> : null}{!loading && !error && !reports.length && !artifacts.length ? <p className="unavailable">暂无持久化报告或数据产物。</p> : null}{!error && reports.length ? <ul className="evidence-list">{reports.map((report) => <li key={report.report_id}><strong>{report.title ?? report.report_type}</strong><small>新鲜度 {report.freshness} · 来源 {report.source_type} · 捕获 {formatDate(report.captured_at)}</small>{safeHref(report.source_ref) ? <a className="text-button" href={safeHref(report.source_ref)!} rel="noreferrer" target="_blank">打开来源 ↗</a> : null}</li>)}</ul> : null}{!error && artifacts.length ? <ul className="evidence-list">{artifacts.map((artifact) => <li key={artifact.id}><strong>{artifact.title}</strong><small>类型 {artifact.artifact_type} · 版本 {artifact.schema_version} · 生成 {formatDate(artifact.created_at)}</small></li>)}</ul> : null}</section>;
}

function formatDate(value: string) { return new Date(value).toLocaleString("zh-CN"); }
