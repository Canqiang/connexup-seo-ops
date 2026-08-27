import { CalendarClock, Image as ImageIcon, MapPin, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../api/client";
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

function storeLocalToUtc(value: string, timeZone: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match || !timeZone) return null;
  const wanted = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let guess = wanted;
  try {
    for (let index = 0; index < 3; index += 1) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
      const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
      guess += wanted - observed;
    }
    return new Date(guess).toISOString();
  } catch { return null; }
}

export function GbpExecutionPanel({ task, onReadback, canExecute, compact = false }: {
  task: SeoTask;
  onReadback: (next: SeoTask) => void;
  canExecute: boolean;
  compact?: boolean;
}) {
  const resource = useResource((signal) => seoOpsApi.gbpExecution(task.id, signal), [task.id, task.state_version]);
  const [scheduleUtc, setScheduleUtc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [holding, setHolding] = useState(true);
  const immediateAtRef = useRef<string | null>(null);
  const view = resource.data;
  const notReadyForExecution = resource.error instanceof ApiError && resource.error.status === 404;
  const bindingReady = view?.binding?.ready_for_gate2 ?? view?.available === true;
  const badge = view?.command_state?.status
    ?? (view ? (bindingReady ? "待确认" : "Gate2 已禁用")
      : notReadyForExecution ? "待定稿与审批" : resource.error ? "读取失败" : "载入中");
  const scheduledIso = useMemo(() => {
    return storeLocalToUtc(scheduleUtc, view?.store?.timezone);
  }, [scheduleUtc, view?.store?.timezone]);
  const locationLocal = useMemo(() => {
    const timezone = view?.store?.timezone;
    if (!scheduledIso || !timezone) return null;
    try { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium", timeZone: timezone }).format(new Date(scheduledIso)); }
    catch { return null; }
  }, [scheduledIso, view?.store?.timezone]);

  useEffect(() => {
    immediateAtRef.current = null;
  }, [task.task_revision]);

  const confirm = async (explicitScheduledIso?: string) => {
    const executionTime = explicitScheduledIso ?? scheduledIso;
    if (!executionTime || !bindingReady || !canExecute) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await seoOpsApi.confirmExecution(task.id, {
        expected_state_version: task.state_version,
        expected_task_revision: task.task_revision,
        expected_execution_spec_hash: task.execution_spec_hash,
        scheduled_for: executionTime,
        idempotency_key: `gbp-gate2-${task.id}-rev${task.task_revision}-${executionTime}`,
      });
      onReadback(next);
      resource.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "GBP 执行确认失败");
    } finally { setBusy(false); }
  };

  const confirmImmediate = () => {
    immediateAtRef.current ??= new Date().toISOString();
    return confirm(immediateAtRef.current);
  };

  if (compact) return <section aria-label="发布方式" className="publish-choice-panel">
    <div><span className="eyebrow">PUBLISHING / 发布方式</span><h3>这篇 Post 何时发布？</h3><p>批准后仍由你决定发布时间；不选择时间就不会发布。</p></div>
    <div className="publish-choice-actions">
      <button aria-pressed={holding} className={holding ? "choice-button is-selected" : "choice-button"} onClick={() => { setHolding(true); setError(undefined); }} type="button">先不发布<small>保留已批准稿</small></button>
      <button className="choice-button is-immediate" disabled={!bindingReady || !canExecute || busy} onClick={() => void confirmImmediate()} type="button">确认立即发布<small>通过 Gate2 后马上执行</small></button>
      <label className={!holding ? "schedule-choice is-selected" : "schedule-choice"}><span>定时发布（门店当地时间）</span><input aria-label="定时发布时间" disabled={!bindingReady || !canExecute} onChange={(event) => { setScheduleUtc(event.target.value); setHolding(false); }} type="datetime-local" value={scheduleUtc} /></label>
      <button className="primary-button" disabled={holding || !scheduledIso || !bindingReady || !canExecute || busy} onClick={() => void confirm()} type="button">{busy ? "正在安排…" : "确认定时发布"}</button>
    </div>
    {scheduledIso && !holding ? <p className="publish-time-note">门店本地时间：{locationLocal ?? "正在换算…"}</p> : null}
    {holding ? <p className="publish-time-note">当前选择：先不发布。</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;

  return <section aria-labelledby="gbp-execution-heading" className="data-panel execution-panel">
    <div className="panel-heading"><div><span className="eyebrow">DEDICATED CREATE_POST</span><h2 id="gbp-execution-heading"><ShieldCheck size={15} /> GBP 执行</h2><p className="quiet-copy">仅冻结当前审批版本；本面板不会触发 Core 或 Google 写入。</p></div>
      <span className={`status-pill ${view?.available ? "is-stable" : "is-warning"}`}>{badge}</span></div>
    {resource.loading ? <div className="page-state compact" role="status">读取精确 GBP 执行快照…</div> : null}
    {notReadyForExecution ? <div className="page-state compact">Post 尚未定稿或批准；完成内容生成、定稿和门 1 审批后，这里才会生成精确 GBP 执行快照。</div> : null}
    {resource.error && !notReadyForExecution ? <div className="page-state compact is-error" role="alert">GBP 执行快照读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {view?.store ? <dl className="identity-ledger">
      <div><dt>商户</dt><dd>{view.store.merchant_name}</dd></div>
      <div><dt>门店</dt><dd><MapPin size={13} /> {view.store.location_name}</dd></div>
      {view.store.account_resource !== undefined ? <div><dt>GBP account</dt><dd><code>{view.store.account_resource ?? "未绑定"}</code></dd></div> : null}
      {view.store.location_resource !== undefined ? <div><dt>GBP location</dt><dd><code>{view.store.location_resource ?? "未绑定"}</code></dd></div> : null}
      <div><dt>时区</dt><dd><code>{view.store.timezone ?? "未绑定"}</code></dd></div>
    </dl> : null}
    {view?.schedule ? <dl className="identity-ledger">
      <div><dt>UTC</dt><dd><CalendarClock size={13} /> {view.schedule.utc}</dd></div>
      <div><dt>门店本地</dt><dd>{view.schedule.local}</dd></div>
    </dl> : null}
    {view ? <ApprovedPost view={view} /> : null}
    {view?.command_state ? <div className="execution-body">
      <h3>命令状态</h3>
      <dl className="identity-ledger">
        <div><dt>状态</dt><dd>{view.command_state.status}</dd></div>
        <div><dt>版本</dt><dd>state v{view.command_state.state_version}</dd></div>
        <div><dt>安全错误</dt><dd><code>{view.command_state.safe_error_code ?? "—"}</code></dd></div>
        <div><dt>触发标记</dt><dd>{view.command_state.trigger_started_at ?? "尚未触发"}</dd></div>
        <div><dt>更新时间</dt><dd>{view.command_state.updated_at}</dd></div>
      </dl>
    </div> : null}
    {view?.receipt ? <div className="execution-body">
      <h3>不可变回执</h3>
      <p><strong>{view.receipt.status}</strong> · mutation {view.receipt.provider_mutation_count} · {view.receipt.created_at}</p>
    </div> : null}
    {view?.readbacks?.length ? <div className="execution-body">
      <h3>独立回读</h3>
      <ul>{view.readbacks.map((readback) => <li key={readback.id}>
        <code>{readback.diff_codes.length ? readback.diff_codes.join(" · ") : "EXACT_MATCH"}</code>
        {readback.safe_error_code ? <> · <code>{readback.safe_error_code}</code></> : null}
        <> · {readback.created_at}</>
      </li>)}</ul>
    </div> : null}
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
