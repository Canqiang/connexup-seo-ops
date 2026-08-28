import type { RankingOverviewView } from "../../api/types";
import { formatDateOnly } from "../../app/format";

function delta(value: number | null): string { return value === null ? "—" : value > 0 ? `↑${value}` : value < 0 ? `↓${Math.abs(value)}` : "→0"; }

export function RankingSnapshotPanel({ data, loading, error, onRetry }: { data?: RankingOverviewView; loading: boolean; error?: unknown; onRetry: () => void }) {
  const latest = data?.latest;
  return <section aria-label="排名快照" className="data-panel ranking-panel">
    <div className="panel-heading"><div><span className="eyebrow">RANKING · LOCAL / ORGANIC</span><h2>排名快照</h2><p className="quiet-copy">{data?.round_count ? `第 ${data.round_count} 轮 · 最近 ${formatDateOnly(latest?.captured_at)}${data.previous ? ` · 对比 ${formatDateOnly(data.previous.captured_at)}` : " · 首个快照"}` : "排名基线未建立 · 基线任务判定并执行后生成首个快照"}</p></div></div>
    {error ? <div className="page-state compact is-error" role="alert">排名读取失败。<button onClick={onRetry} type="button">重试</button></div> : null}
    {loading && !data ? <div className="page-state compact" role="status">读取排名…</div> : null}
    {data?.comparison ? <div className="ranking-compare"><span>Local 平均 {data.comparison.local_avg.current ?? "—"}（{delta(data.comparison.local_avg.delta)}）</span><span>Organic 前 10：{data.comparison.organic_top10.current} / {data.comparison.organic_top10.total}（上期 {data.comparison.organic_top10.previous}）</span><span>新词 {data.comparison.new_keyword_count}</span></div> : null}
    {latest ? <div className="table-wrap"><table><thead><tr><th>关键词</th><th>Local</th><th>Organic</th><th /></tr></thead><tbody>
      {latest.rows.slice(0, 12).map((row) => <tr aria-label={row.keyword} key={row.keyword}><td>{row.keyword}</td><td>{row.local_rank ?? "出包"} <small>{delta(row.local_delta)}</small></td><td>{row.organic_rank ?? "出包"} <small>{delta(row.organic_delta)}</small></td><td>{row.is_new ? <span className="status-pill is-attention">新词</span> : null}</td></tr>)}
    </tbody></table>{latest.rows.length > 12 ? <p className="quiet-copy">仅显示前 12 / {latest.keyword_count} 词</p> : null}</div> : null}
  </section>;
}
