import { CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import type { CycleConfigWire } from "../../api/types";
import { seoOpsApi } from "../../api/seoOpsApi";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function CadencePanel({ canManage, merchantId }: { canManage: boolean; merchantId?: string }) {
  return <section aria-labelledby="cadence-heading" className="settings-section data-panel">
    <PanelHeading />
    <CadenceOverview />
    {!merchantId
      ? <div className="settings-evidence-gap">没有可用商户范围，周期配置不可用。</div>
      : <CadenceResource canManage={canManage} merchantId={merchantId} />}
  </section>;
}

/** Nested read-only region above the per-merchant form. It only registers
 * under its "周期总览" accessible name once both the merchant scope and the
 * cycle-config list have loaded, so a caller reading the region never
 * observes it half-settled. */
function CadenceOverview() {
  const workspace = useWorkspace();
  const resource = useResource((signal) => seoOpsApi.cycleConfigs(signal), []);

  if (workspace.loading || resource.loading) {
    return <div className="page-state compact" role="status">读取周期总览…</div>;
  }

  const byMerchant = new Map<string, CycleConfigWire>((resource.data?.items ?? []).map((cfg) => [cfg.merchant_id, cfg]));

  return <section aria-label="周期总览" className="cadence-overview">
    {resource.error ? <div className="page-state compact is-error" role="alert">周期总览读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {!resource.error && !workspace.merchants.length ? <div className="settings-evidence-gap">没有可用商户范围，周期总览不可用。</div> : null}
    {!resource.error && workspace.merchants.length ? <div className="table-wrap"><table><thead><tr>
      <th>商户</th><th>月度快照</th><th>Post 节奏</th><th>复盘窗口</th><th>审计间隔</th><th>启用</th>
    </tr></thead><tbody>
      {workspace.merchants.map((merchant) => {
        const cfg = byMerchant.get(merchant.id);
        const postRhythm = cfg?.post_weekday != null ? `每${WEEKDAYS[cfg.post_weekday]} ×${cfg.post_per_week}` : "暂停";
        return <tr aria-label={merchant.display_name} key={merchant.id}>
          <td>{merchant.display_name}</td>
          <td>{cfg?.snapshot_day != null ? `每月 ${cfg.snapshot_day} 日` : "关闭"}</td>
          <td>{postRhythm}</td>
          <td>{cfg ? `${cfg.review_window_days} 天` : "—"}</td>
          <td>{cfg?.audit_interval_days != null ? `${cfg.audit_interval_days} 天` : "关闭"}</td>
          <td><span className={`status-pill ${cfg?.enabled ? "is-stable" : "is-blocked"}`}>{cfg?.enabled ? "启用" : "未启用"}</span></td>
        </tr>;
      })}
    </tbody></table></div> : null}
  </section>;
}

function CadenceResource({ canManage, merchantId }: { canManage: boolean; merchantId: string }) {
  const resource = useResource((signal) => seoOpsApi.cycleConfig(merchantId, signal), [merchantId]);
  const [form, setForm] = useState<CycleConfigWire>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (resource.loading || resource.error) return;
    setForm(resource.data ?? {
      merchant_id: merchantId,
      snapshot_day: 1,
      post_weekday: 3,
      post_per_week: 1,
      review_window_days: 7,
      audit_interval_days: 30,
      enabled: false,
      updated_by: null,
      updated_at: "",
    });
  }, [resource.data, resource.error, resource.loading, merchantId]);

  const save = async () => {
    if (!canManage || !form) return;
    setSaving(true);
    setMessage(undefined);
    try {
      await seoOpsApi.upsertCycleConfig(merchantId, {
        snapshot_day: form.snapshot_day,
        post_weekday: form.post_weekday,
        post_per_week: form.post_per_week,
        review_window_days: form.review_window_days,
        audit_interval_days: form.audit_interval_days,
        enabled: form.enabled,
      });
      setMessage("已保存 — 下一轮调度生效");
      resource.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const numberOrNull = (value: string): number | null => value === "" ? null : Number(value);
  return <>
    {!canManage ? <p className="settings-readonly">当前账号可查看周期，但没有修改权限。</p> : null}
    {resource.error ? <div className="page-state compact is-error" role="alert">周期配置读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {resource.loading || !form ? <div className="page-state compact" role="status">读取周期配置…</div> : null}
    {!resource.loading && !resource.error && form ? <>
      <div className="cycle-authority"><label className="cycle-enable"><input checked={form.enabled} disabled={!canManage} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} type="checkbox" /> 启用自动周期</label><span>更新人：{form.updated_by ?? "尚无记录"}</span><span>版本时间：{form.updated_at || "尚未保存"}</span></div>
      <div className="cycle-grid">
        <label>月度快照日（1–28，空=关）<input disabled={!canManage} max={28} min={1} onChange={(event) => setForm({ ...form, snapshot_day: numberOrNull(event.target.value) })} type="number" value={form.snapshot_day ?? ""} /></label>
        <label>每周 Post 日<select disabled={!canManage} onChange={(event) => setForm({ ...form, post_weekday: event.target.value === "" ? null : Number(event.target.value) })} value={form.post_weekday ?? ""}><option value="">暂停</option>{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
        <label>每周 Post 篇数<input disabled={!canManage} max={7} min={0} onChange={(event) => setForm({ ...form, post_per_week: Number(event.target.value) || 0 })} type="number" value={form.post_per_week} /></label>
        <label>复盘窗口（天）· 到窗自动出 REVIEW 建议<input disabled={!canManage} max={90} min={1} onChange={(event) => setForm({ ...form, review_window_days: Number(event.target.value) || 7 })} type="number" value={form.review_window_days} /></label>
        <label>审计间隔（天，空=关）<input disabled={!canManage} max={365} min={1} onChange={(event) => setForm({ ...form, audit_interval_days: numberOrNull(event.target.value) })} type="number" value={form.audit_interval_days ?? ""} /></label>
        <div className="cycle-actions"><button className="primary-button" disabled={!canManage || saving} onClick={() => void save()} type="button">{saving ? "保存中…" : "保存周期"}</button>{message ? <span className="quiet-copy">{message}</span> : null}</div>
      </div>
    </> : null}
  </>;
}

function PanelHeading() {
  return <div className="panel-heading"><div><span className="eyebrow">CADENCE / PRE-AUTHORIZED WINDOWS</span><h2 id="cadence-heading"><CalendarClock size={15} /> 周期配置</h2><p className="quiet-copy">只读例行工作按周期生成；写入与成品仍停在对应的人类判断门前。</p></div></div>;
}
