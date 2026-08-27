import { CalendarClock, Image as ImageIcon, MapPin, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { GbpExecutionWire, SeoTask } from "../../api/types";
import { safeHref } from "../../app/format";
import { useResource } from "../../hooks/useResource";

function Hashes({ hashes }: { hashes: NonNullable<GbpExecutionWire["hashes"]> }) {
  return <dl className="identity-ledger">
    {Object.entries(hashes).map(([label, value]) => value ? <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div> : null)}
  </dl>;
}

function ApprovedPost({ view }: { view: GbpExecutionWire }) {
  if (!view.approved) return null;
  const cta = view.approved.cta;
  const ctaHref = safeHref(cta.url);
  return <div className="execution-body">
    <p>{view.approved.body}</p>
    <p><strong>CTA：</strong>{ctaHref
      ? <a href={ctaHref} rel="noreferrer" target="_blank">{cta.type} · {cta.url}</a>
      : <span>{cta.type}</span>}</p>
    <figure className="task-draft-preview">
      <img alt={view.approved.image.alt_text} loading="lazy" src={view.approved.image.download_path} />
      <figcaption><ImageIcon size={13} /> 本地鉴权图片 · <code>{view.approved.image.sha256}</code></figcaption>
    </figure>
    {view.hashes ? <Hashes hashes={view.hashes} /> : null}
  </div>;
}

export function GbpExecutionPanel({ task, onReadback, canExecute }: {
  task: SeoTask;
  onReadback: (next: SeoTask) => void;
  canExecute: boolean;
}) {
  const resource = useResource((signal) => seoOpsApi.gbpExecution(task.id, signal), [task.id, task.state_version]);
  const [scheduleUtc, setScheduleUtc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const view = resource.data;
  const bindingReady = view?.binding?.ready_for_gate2 ?? view?.available === true;
  const scheduledIso = useMemo(() => {
    if (!scheduleUtc) return null;
    const parsed = new Date(`${scheduleUtc}:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }, [scheduleUtc]);
  const locationLocal = useMemo(() => {
    const timezone = view?.store?.timezone;
    if (!scheduledIso || !timezone) return null;
    try { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium", timeZone: timezone }).format(new Date(scheduledIso)); }
    catch { return null; }
  }, [scheduledIso, view?.store?.timezone]);

  const confirm = async () => {
    if (!scheduledIso || !bindingReady || !canExecute) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await seoOpsApi.confirmExecution(task.id, {
        expected_state_version: task.state_version,
        expected_task_revision: task.task_revision,
        expected_execution_spec_hash: task.execution_spec_hash,
        scheduled_for: scheduledIso,
        idempotency_key: `gbp-gate2-${task.id}-rev${task.task_revision}-${scheduledIso}`,
      });
      onReadback(next);
      resource.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "GBP 执行确认失败");
    } finally { setBusy(false); }
  };

  return <section aria-labelledby="gbp-execution-heading" className="data-panel execution-panel">
    <div className="panel-heading"><div><span className="eyebrow">DEDICATED CREATE_POST</span><h2 id="gbp-execution-heading"><ShieldCheck size={15} /> GBP 执行</h2><p className="quiet-copy">仅冻结当前审批版本；本面板不会触发 Core 或 Google 写入。</p></div>
      <span className={`status-pill ${view?.available ? "is-stable" : "is-warning"}`}>{view?.command_state?.status ?? (bindingReady ? "待确认" : "Gate2 已禁用")}</span></div>
    {resource.loading ? <div className="page-state compact" role="status">读取精确 GBP 执行快照…</div> : null}
    {resource.error ? <div className="page-state compact is-error" role="alert">GBP 执行快照读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {view?.store ? <dl className="identity-ledger">
      <div><dt>商户</dt><dd>{view.store.merchant_name}</dd></div>
      <div><dt>门店</dt><dd><MapPin size={13} /> {view.store.location_name}</dd></div>
      <div><dt>GBP account</dt><dd><code>{view.store.account_resource ?? "未绑定"}</code></dd></div>
      <div><dt>GBP location</dt><dd><code>{view.store.location_resource ?? "未绑定"}</code></dd></div>
      <div><dt>时区</dt><dd><code>{view.store.timezone ?? "未绑定"}</code></dd></div>
    </dl> : null}
    {view?.schedule ? <dl className="identity-ledger">
      <div><dt>UTC</dt><dd><CalendarClock size={13} /> {view.schedule.utc}</dd></div>
      <div><dt>门店本地</dt><dd>{view.schedule.local}</dd></div>
    </dl> : null}
    {view ? <ApprovedPost view={view} /> : null}
    {view && !view.available ? <div className="execution-body">
      {!bindingReady ? <><p className="form-error">Gate2 已禁用：精确地点绑定不完整。</p><p className="quiet-copy">旧 GBP_WRITE / 全局 GBP_EXECUTION 不能替代精确地点绑定。</p>
        <ul>{(view.binding?.missing_fields ?? []).map((field) => <li key={field}><code>{field}</code></li>)}</ul></> : null}
      <label>发布时间（UTC）<input aria-label="发布时间（UTC）" disabled={!bindingReady || !canExecute} onChange={(event) => setScheduleUtc(event.target.value)} type="datetime-local" value={scheduleUtc} /></label>
      {scheduledIso ? <p className="quiet-copy">UTC：{scheduledIso}{locationLocal ? ` · 门店本地：${locationLocal}` : ""}</p> : null}
      <button className="primary-button" disabled={!bindingReady || !canExecute || !scheduledIso || busy} onClick={() => void confirm()} type="button">{busy ? "冻结中…" : "确认并冻结 GBP 命令"}</button>
    </div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}
