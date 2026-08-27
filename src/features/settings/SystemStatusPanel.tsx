import { Activity, ArrowRight, PauseCircle, Play, RefreshCw, ServerCog } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { RuntimeControlsView } from "../../api/types";
import { useResource } from "../../hooks/useResource";

const UNSUPPORTED_FIELDS = ["Scheduler 心跳", "Worker 心跳", "Run 容量", "Core AI 配额", "近期失败数"];

const EMPTY_RUNTIME_CONTROLS: RuntimeControlsView = {
  global: null,
  merchant: null,
  effective_paused: false,
  effective_source: null,
  effective_reason: null,
};

function ControlMeta({ control }: { control: RuntimeControlsView["global"] }) {
  if (!control) return <>尚无操作记录</>;
  return <><span>{control.reason}</span> · {control.changed_by} · {new Date(control.created_at).toLocaleString("zh-CN")}</>;
}

export function SystemStatusPanel({ canSchedule, merchantId }: { canSchedule: boolean; merchantId?: string }) {
  const config = useResource((signal) => seoOpsApi.config(signal), []);
  const inbox = useResource((signal) => seoOpsApi.inboxSummary(signal), []);
  const controls = useResource(
    (signal) => merchantId ? seoOpsApi.runtimeControls(merchantId, signal) : Promise.resolve(EMPTY_RUNTIME_CONTROLS),
    [merchantId],
  );
  const [busy, setBusy] = useState<"scheduler" | "worker">();
  const [controlBusy, setControlBusy] = useState<"GLOBAL" | "MERCHANT">();
  const [last, setLast] = useState<string>();
  const [controlMessage, setControlMessage] = useState<string>();
  const [reason, setReason] = useState("");

  const changePause = async (scope: "GLOBAL" | "MERCHANT") => {
    if (!canSchedule || !reason.trim() || (scope === "MERCHANT" && !merchantId)) return;
    const current = scope === "GLOBAL" ? controls.data?.global : controls.data?.merchant;
    setControlBusy(scope);
    setControlMessage(undefined);
    try {
      await seoOpsApi.setRuntimeControl({
        scope,
        merchant_id: scope === "MERCHANT" ? merchantId! : null,
        paused: !(current?.paused ?? false),
        reason: reason.trim(),
      });
      setReason("");
      setControlMessage(current?.paused ? "已恢复新工作" : "已暂停新工作");
      controls.reload();
    } catch (error) {
      setControlMessage(error instanceof Error ? error.message : "状态更新失败");
    } finally {
      setControlBusy(undefined);
    }
  };

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
      <div className="heading-actions"><button aria-label="刷新系统状态" className="icon-button" onClick={() => { config.reload(); inbox.reload(); controls.reload(); }} type="button"><RefreshCw size={15} /></button></div></div>
    <div className="system-truth-grid">
      <div aria-label="Agent Run 接口" className={`system-truth-card${!config.loading && !config.error && config.data?.agent_run_enabled === undefined ? " is-evidence-gap" : ""}`}><span>Agent Run 接口</span>{config.loading ? <strong>读取中…</strong> : config.error ? <strong className="danger-text">读取失败</strong> : config.data?.agent_run_enabled === true ? <strong className="truth-available">已启用</strong> : config.data?.agent_run_enabled === false ? <strong className="truth-unavailable">未启用</strong> : <><strong className="truth-unavailable">不可用</strong><small>当前 API 未提供证据</small></>}<small>来源：/api/seo-ops/config</small></div>
      <div className="system-truth-card"><span>结果待查</span>{inbox.loading ? <strong>读取中…</strong> : inbox.error ? <strong className="danger-text">读取失败</strong> : <strong className={inbox.data?.outcome_unknown ? "truth-attention" : "truth-available"}>{inbox.data?.outcome_unknown ?? "不可用"}</strong>}<small>来源：/api/seo-ops/inbox-summary</small></div>
      {UNSUPPORTED_FIELDS.map((label) => <div aria-label={label} className="system-truth-card is-evidence-gap" key={label}><span>{label}</span><strong>不可用</strong><small>当前 API 未提供证据</small></div>)}
    </div>
    <div className="pause-controls">
      <div className="pause-control-heading"><PauseCircle size={16} /><div><strong>新工作暂停开关</strong><p>暂停后不再创建、派发或领取新工作；已经进入回读阶段的执行仍会继续收敛结果。</p></div></div>
      <div className="pause-status-grid">
        <div className={`pause-status-card${controls.data?.global?.paused ? " is-paused" : ""}`}>
          <span>全局</span><strong>{controls.loading ? "读取中…" : controls.error ? "读取失败" : controls.data?.global?.paused ? "全局已暂停" : "全局运行中"}</strong>
          <small><ControlMeta control={controls.data?.global ?? null} /></small>
        </div>
        <div className={`pause-status-card${controls.data?.merchant?.paused ? " is-paused" : ""}`}>
          <span>当前商户</span><strong>{controls.loading ? "读取中…" : controls.error ? "读取失败" : controls.data?.merchant?.paused ? "当前商户已暂停" : "当前商户运行中"}</strong>
          <small><ControlMeta control={controls.data?.merchant ?? null} /></small>
        </div>
      </div>
      <div className="pause-actions">
        <label>暂停或恢复原因<input aria-label="暂停或恢复原因" onChange={(event) => setReason(event.target.value)} placeholder="例如：UAT 故障排查" value={reason} /></label>
        <button className="secondary-button" disabled={!canSchedule || !reason.trim() || controlBusy !== undefined || controls.loading} onClick={() => void changePause("GLOBAL")} type="button">{controls.data?.global?.paused ? "恢复全部新工作" : "暂停全部新工作"}</button>
        <button className="secondary-button" disabled={!canSchedule || !merchantId || !reason.trim() || controlBusy !== undefined || controls.loading} onClick={() => void changePause("MERCHANT")} type="button">{controls.data?.merchant?.paused ? "恢复当前商户新工作" : "暂停当前商户新工作"}</button>
        {controlMessage ? <span aria-live="polite" className="quiet-copy">{controlMessage}</span> : null}
      </div>
    </div>
    <div className="runtime-controls"><div><Activity size={16} /><div><strong>人工运行控制</strong><p>仅触发一次现有 scheduler/worker 管理入口，不把触发结果当作心跳或完成证明。</p></div></div><div className="runtime-actions">
      {last ? <span aria-live="polite" className="quiet-copy">{last}</span> : null}
      <button className="secondary-button" disabled={!canSchedule || busy !== undefined} onClick={() => void run("scheduler")} type="button"><Play size={13} /> 调度一轮</button>
      <button className="secondary-button" disabled={!canSchedule || busy !== undefined} onClick={() => void run("worker")} type="button"><Play size={13} /> 执行一轮</button>
      <Link className="audit-ledger-link" to="/runs?view=audit">查看完整运行账本 <ArrowRight size={13} /></Link>
    </div></div>
  </section>;
}
