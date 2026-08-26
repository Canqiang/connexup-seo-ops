import { Activity, ArrowRight, Play, RefreshCw, ServerCog } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { useResource } from "../../hooks/useResource";

const UNSUPPORTED_FIELDS = ["Scheduler 心跳", "Worker 心跳", "Run 容量", "Core AI 配额", "近期失败数"];

export function SystemStatusPanel({ canSchedule }: { canSchedule: boolean }) {
  const config = useResource((signal) => seoOpsApi.config(signal), []);
  const inbox = useResource((signal) => seoOpsApi.inboxSummary(signal), []);
  const [busy, setBusy] = useState<"scheduler" | "worker">();
  const [last, setLast] = useState<string>();

  const run = async (kind: "scheduler" | "worker") => {
    if (!canSchedule) return;
    setBusy(kind);
    setLast(undefined);
    try {
      if (kind === "scheduler") {
        const result = await seoOpsApi.schedulerTick();
        setLast(`调度完成：新建 ${result.created.length} · 派发 ${result.dispatched}`);
      } else {
        await seoOpsApi.executionTick();
        setLast("执行 Worker 已跑一轮");
      }
      inbox.reload();
    } catch (reason) {
      setLast(reason instanceof Error ? reason.message : "触发失败");
    } finally {
      setBusy(undefined);
    }
  };

  return <section aria-labelledby="system-status-heading" className="settings-section system-status-panel data-panel" id="system-status">
    <div className="panel-heading"><div><span className="eyebrow">SYSTEM STATUS / EVIDENCE BOUNDARY</span><h2 id="system-status-heading"><ServerCog size={15} /> 系统状态</h2><p className="quiet-copy">只展示现有 API 可以回读的状态；没有信号的运行指标明确标记为不可用。</p></div>
      <div className="heading-actions"><button aria-label="刷新系统状态" className="icon-button" onClick={() => { config.reload(); inbox.reload(); }} type="button"><RefreshCw size={15} /></button></div></div>
    <div className="system-truth-grid">
      <div aria-label="Agent Run 接口" className={`system-truth-card${!config.loading && !config.error && config.data?.agent_run_enabled === undefined ? " is-evidence-gap" : ""}`}><span>Agent Run 接口</span>{config.loading ? <strong>读取中…</strong> : config.error ? <strong className="danger-text">读取失败</strong> : config.data?.agent_run_enabled === true ? <strong className="truth-available">已启用</strong> : config.data?.agent_run_enabled === false ? <strong className="truth-unavailable">未启用</strong> : <><strong className="truth-unavailable">不可用</strong><small>当前 API 未提供证据</small></>}<small>来源：/api/seo-ops/config</small></div>
      <div className="system-truth-card"><span>结果待查</span>{inbox.loading ? <strong>读取中…</strong> : inbox.error ? <strong className="danger-text">读取失败</strong> : <strong className={inbox.data?.outcome_unknown ? "truth-attention" : "truth-available"}>{inbox.data?.outcome_unknown ?? "不可用"}</strong>}<small>来源：/api/seo-ops/inbox-summary</small></div>
      {UNSUPPORTED_FIELDS.map((label) => <div aria-label={label} className="system-truth-card is-evidence-gap" key={label}><span>{label}</span><strong>不可用</strong><small>当前 API 未提供证据</small></div>)}
    </div>
    <div className="runtime-controls"><div><Activity size={16} /><div><strong>人工运行控制</strong><p>仅触发一次现有 scheduler/worker 管理入口，不把触发结果当作心跳或完成证明。</p></div></div><div className="runtime-actions">
      {last ? <span aria-live="polite" className="quiet-copy">{last}</span> : null}
      <button className="secondary-button" disabled={!canSchedule || busy !== undefined} onClick={() => void run("scheduler")} type="button"><Play size={13} /> 调度一轮</button>
      <button className="secondary-button" disabled={!canSchedule || busy !== undefined} onClick={() => void run("worker")} type="button"><Play size={13} /> 执行一轮</button>
      <Link className="audit-ledger-link" to="/runs?view=audit">查看完整运行账本 <ArrowRight size={13} /></Link>
    </div></div>
  </section>;
}
