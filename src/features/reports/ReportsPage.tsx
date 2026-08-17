import { ExternalLink, FileBarChart } from "lucide-react";
import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";

export function ReportsPage() {
  const workspace = useWorkspace();
  const [freshness, setFreshness] = useState("");
  const [reportType, setReportType] = useState("");
  const [locationId, setLocationId] = useState("");
  const resource = useResource((signal) => seoOpsApi.reports({
    merchant_id: workspace.merchantId, location_id: locationId || undefined,
    freshness: freshness || undefined, report_type: reportType || undefined, limit: 50
  }, signal), [workspace.merchantId, locationId, freshness, reportType]);
  return <>
    <header className="page-heading"><div><span className="eyebrow">DATA PRODUCTS / SOURCE LABELLED</span><h1>数据与报告</h1><p>每份报告都保留来源、采集时间、哈希与新鲜度。</p></div><span className="scope-chip"><FileBarChart size={14} /> {workspace.merchant?.display_name ?? "全部商户"}</span></header>
    <section className="data-panel"><div className="panel-heading"><div className="filters">
      {workspace.merchant ? <label>地点<select value={locationId} onChange={(event) => setLocationId(event.target.value)}><option value="">全部地点</option>{workspace.merchant.locations.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label> : null}
      <label>类型<input onChange={(event) => setReportType(event.target.value)} placeholder="例如 MONTHLY_REPORT" value={reportType} /></label>
      <label>新鲜度<select value={freshness} onChange={(event) => setFreshness(event.target.value)}><option value="">全部</option><option value="FRESH">FRESH</option><option value="AGING">AGING</option><option value="STALE">STALE</option></select></label>
    </div><span className="result-count">{resource.data?.total ?? "—"} 份</span></div>
    {resource.loading ? <div className="page-state" role="status">正在读取报告索引…</div> : null}
    {resource.error ? <div className="page-state is-error" role="alert">报告读取失败。<button onClick={resource.reload}>重试</button></div> : null}
    {resource.data ? <div className="table-wrap"><table><thead><tr><th>报告类型</th><th>商户 / 地点</th><th>采集时间</th><th>新鲜度</th><th>来源</th><th>校验</th><th /></tr></thead><tbody>
      {resource.data.items.map((item) => <tr key={item.evidence_id}><td><strong>{item.report_type}</strong><small>{item.evidence_id}</small></td><td>{item.merchant_id}<small>{item.location_id ?? "商户级"}</small></td><td>{formatDate(item.captured_at)}</td><td><span className={`freshness is-${item.freshness.toLocaleLowerCase()}`}>{item.freshness}</span></td><td>{item.artifact_id ?? item.file_id ?? item.source_ref ?? "不可用"}</td><td><code>{item.sha256?.slice(0, 12) ?? "—"}</code></td><td>{item.source_ref ? <a aria-label={`打开报告 ${item.report_type}`} className="row-arrow" href={item.source_ref} rel="noreferrer" target="_blank"><ExternalLink size={14} /></a> : null}</td></tr>)}
    </tbody></table>{!resource.data.items.length ? <div className="empty-state"><h2>没有匹配的报告</h2><p>报告证据必须以 <code>_REPORT</code> 结尾并绑定当前任务版本。</p></div> : null}</div> : null}</section>
  </>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
