import { KeyRound, MapPinned, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { GbpLocationBindingWire, LocationSummary } from "../../api/types";
import { useResource } from "../../hooks/useResource";

const fields = [
  "account_resource", "location_resource", "timezone", "core_api_user_id",
  "core_api_user_external_id", "write_secret_ref", "readback_secret_ref",
  "write_agent_id", "write_agent_published_ref", "readback_agent_id",
  "readback_agent_published_ref",
] as const;
type Field = (typeof fields)[number];
type Form = Record<Field, string> & { status: "DISABLED" | "READY" | "BLOCKED" };
const emptyForm = (): Form => Object.assign(
  Object.fromEntries(fields.map((field) => [field, ""])) as Record<Field, string>,
  { status: "DISABLED" as const },
);

export function GbpLocationBindingPanel({ merchantId, locations, canManage }: {
  merchantId?: string;
  locations: LocationSummary[];
  canManage: boolean;
}) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  useEffect(() => {
    if (!locations.some((location) => location.id === locationId)) setLocationId(locations[0]?.id ?? "");
  }, [locations, locationId]);
  const resource = useResource(
    (signal) => merchantId && locationId
      ? seoOpsApi.gbpLocationBinding(merchantId, locationId, signal)
      : Promise.resolve(undefined),
    [merchantId, locationId],
  );
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    const binding = resource.data;
    if (!binding) { setForm(emptyForm()); return; }
    setForm(Object.assign(
      Object.fromEntries(fields.map((field) => [field, binding[field] ?? ""])) as Record<Field, string>,
      { status: binding.status === "MISSING" ? "DISABLED" : binding.status },
    ));
  }, [resource.data]);
  const selected = locations.find((location) => location.id === locationId);

  const save = async () => {
    if (!merchantId || !locationId || !canManage) return;
    setSaving(true); setMessage(undefined);
    try {
      await seoOpsApi.putGbpLocationBinding(merchantId, locationId, {
        ...form, expected_state_version: resource.data?.state_version ?? 0,
      });
      setMessage("精确地点绑定已回读。");
      resource.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "绑定保存失败");
    } finally { setSaving(false); }
  };

  const binding = resource.data as GbpLocationBindingWire | undefined;
  return <section aria-labelledby="gbp-location-binding-heading" className="settings-section data-panel">
    <div className="panel-heading"><div><span className="eyebrow">EXACT LOCATION / SECRET REFS ONLY</span><h2 id="gbp-location-binding-heading"><MapPinned size={15} /> GBP 地点执行绑定</h2><p className="quiet-copy">一组商户+地点+account/location+写入/回读 Agent 的精确坐标；仅保存逻辑 secret ref。</p></div>
      <button aria-label="刷新 GBP 地点绑定" className="icon-button" onClick={resource.reload} type="button"><RefreshCw size={15} /></button></div>
    <label>地点<select aria-label="GBP 绑定地点" onChange={(event) => setLocationId(event.target.value)} value={locationId}>{locations.map((location) => <option key={location.id} value={location.id}>{location.display_name}</option>)}</select></label>
    {!selected ? <p className="quiet-copy">当前商户没有可绑定地点。</p> : null}
    {resource.loading ? <div className="page-state compact" role="status">读取精确地点绑定…</div> : null}
    {resource.error ? <div className="page-state compact is-error" role="alert">绑定读取失败。</div> : null}
    {binding ? <><p><span className={`status-pill ${binding.ready_for_gate2 ? "is-stable" : "is-warning"}`}>{binding.ready_for_gate2 ? "Gate2 READY" : "Gate2 已禁用"}</span> · state v{binding.state_version}</p>
      {binding.missing_fields.length ? <div><strong>缺失字段</strong><ul>{binding.missing_fields.map((field) => <li key={field}><code>{field}</code></li>)}</ul></div> : <p className="quiet-copy">精确绑定字段齐全；是否启用仍受 UAT stop rules 约束。</p>}
      <div className="form-grid">{fields.map((field) => <label key={field}>{field.includes("secret_ref") ? <KeyRound size={12} /> : null}{field}<input aria-label={`GBP ${field}`} disabled={!canManage} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} type={field.includes("secret_ref") ? "text" : "text"} value={form[field]} /></label>)}
        <label>status<select aria-label="GBP binding status" disabled={!canManage} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as Form["status"] }))} value={form.status}><option value="DISABLED">DISABLED</option><option value="BLOCKED">BLOCKED</option><option value="READY">READY</option></select></label></div>
      <button className="primary-button" disabled={!canManage || saving} onClick={() => void save()} type="button">{saving ? "保存中…" : "CAS 保存绑定"}</button>
      {message ? <p role="status">{message}</p> : null}</> : null}
  </section>;
}
