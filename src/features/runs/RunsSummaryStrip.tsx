import type { RunsLedgerView } from "../../api/types";

export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function RunsSummaryStrip({ summary, loading }: { summary?: RunsLedgerView["summary"]; loading: boolean }) {
  const cell = (label: string, value: string, hint: string, danger = false) =>
    <div className={`runs-summary-cell${danger ? " is-danger" : ""}`} key={label}><span>{label}</span><strong>{loading || !summary ? "—" : value}</strong><small>{hint}</small></div>;
  const s = summary;
  return <section aria-label="运行汇总" className="runs-summary">
    {cell("进行中", String(s?.in_flight ?? 0), "RUNNING · Core AI 已认领")}
    {cell("排队", String(s?.queued ?? 0), "TRIGGERING · 等 worker 认领")}
    {cell("今日完成", String(s?.completed_today ?? 0), `内容重写 ${s?.content_runs_today ?? 0} 条不计`)}
    {cell("今日失败", String(s?.failed_today ?? 0), "限次自动重试后升级人工")}
    {cell("结果待查", String(s?.outcome_unknown ?? 0), "未决 attempt · 含 GBP 专用回读", (s?.outcome_unknown ?? 0) > 0)}
    {cell("今日 Token", formatTokens(s?.token_total_today ?? 0), "按 Core AI token_usage 汇总")}
  </section>;
}
