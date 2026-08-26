import { Bot, CalendarClock, KeyRound, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateOnly } from "../../app/format";
import { usePageTitle } from "../../hooks/usePageTitle";
import type { AgentBindingWire, CapabilityWire, CycleConfigWire } from "../../api/types";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 设置：三块治理面 —— Agent 绑定（任务类型→执行 agent）、商户能力矩阵
 * （写入类采纳/派发的硬门槛）、周期配置（Ⓐ级预授权本体）。 */
export function SettingsPage() {
  const workspace = useWorkspace();
  usePageTitle("设置");
  const [merchantId, setMerchantId] = useState<string>("");
  useEffect(() => {
    if (!merchantId && workspace.merchants.length) setMerchantId(workspace.merchants[0]!.id);
  }, [workspace.merchants, merchantId]);

  return <>
    <header className="page-heading"><div><span className="eyebrow">GOVERNANCE / 治理面</span><h1>设置</h1><p>绑定是「谁来执行」，能力矩阵是「许不许写」，周期配置是「Ⓐ级自动跑的授权书」。</p></div>
      <AdminTicks />
    </header>
    <BindingsPanel />
    <div className="settings-merchant-row">
      <label className="merchant-select">商户
        <select onChange={(e) => setMerchantId(e.target.value)} value={merchantId}>
          {workspace.merchants.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </select>
      </label>
    </div>
    {merchantId ? <CapabilitiesPanel merchantId={merchantId} /> : null}
    {merchantId ? <CyclePanel merchantId={merchantId} /> : null}
  </>;
}

function AdminTicks() {
  const [busy, setBusy] = useState<string>();
  const [last, setLast] = useState<string>();
  const run = async (kind: "scheduler" | "worker") => {
    setBusy(kind);
    try {
      if (kind === "scheduler") {
        const result = await seoOpsApi.schedulerTick();
        setLast(`调度完成：新建 ${result.created.length} · 派发 ${result.dispatched}`);
      } else {
        await seoOpsApi.executionTick();
        setLast("执行 worker 已跑一轮");
      }
    } catch (reason) {
      setLast(reason instanceof Error ? reason.message : "触发失败");
    } finally {
      setBusy(undefined);
    }
  };
  return <div className="heading-actions">
    {last ? <span className="quiet-copy">{last}</span> : null}
    <button className="secondary-button" disabled={busy !== undefined} onClick={() => void run("scheduler")} type="button"><Play size={13} /> 调度一轮</button>
    <button className="secondary-button" disabled={busy !== undefined} onClick={() => void run("worker")} type="button"><Play size={13} /> 执行一轮</button>
  </div>;
}

function BindingsPanel() {
  const resource = useResource((signal) => seoOpsApi.agentBindings(signal), []);
  const [edits, setEdits] = useState<Record<string, { agent_id: string; agent_label: string }>>({});
  const [saving, setSaving] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const bindings = new Map<string, AgentBindingWire>((resource.data?.items ?? []).map((b) => [b.task_type, b]));
  const keys = resource.data?.binding_keys ?? [];

  const save = async (key: string) => {
    const edit = edits[key];
    if (!edit?.agent_id.trim()) return;
    setSaving(key); setSaveError(undefined);
    try {
      await seoOpsApi.upsertAgentBinding(key, {
        agent_id: edit.agent_id.trim(),
        agent_label: edit.agent_label.trim() || null,
      });
      setEdits((prev) => { const next = { ...prev }; delete next[key]; return next; });
      resource.reload();
    } catch (reason) {
      setSaveError(`${key} 保存失败：${reason instanceof Error ? reason.message : "请求失败"}`);
    } finally {
      setSaving(undefined);
    }
  };

  return <section className="data-panel">
    <div className="panel-heading"><div><span className="eyebrow">AGENT BINDINGS</span><h2><Bot size={15} /> Agent 绑定</h2><p className="quiet-copy">任务派发时按类型找 agent；GBP_POST / GBP_UPDATE 的执行绑在 GBP_EXECUTION。未绑定的类型无法采纳非人工建议。</p></div>
      <button className="icon-button" aria-label="刷新绑定" onClick={resource.reload} type="button"><RefreshCw size={15} /></button></div>
    {saveError ? <p className="form-error" role="alert">{saveError}</p> : null}
    {resource.loading ? <div className="page-state" role="status">读取绑定…</div> : <div className="table-wrap"><table><thead><tr><th>绑定键</th><th>Agent ID（core-ai published）</th><th>备注</th><th>更新</th><th /></tr></thead><tbody>
      {keys.map((key) => {
        const bound = bindings.get(key);
        const edit = edits[key] ?? { agent_id: bound?.agent_id ?? "", agent_label: bound?.agent_label ?? "" };
        const dirty = edit.agent_id !== (bound?.agent_id ?? "") || edit.agent_label !== (bound?.agent_label ?? "");
        return <tr key={key}>
          <td><code>{key}</code>{bound ? null : <small className="danger-text">未绑定</small>}</td>
          <td><input className="inline-input" onChange={(e) => setEdits((prev) => ({ ...prev, [key]: { ...edit, agent_id: e.target.value } }))} placeholder="agent uuid" value={edit.agent_id} /></td>
          <td><input className="inline-input" onChange={(e) => setEdits((prev) => ({ ...prev, [key]: { ...edit, agent_label: e.target.value } }))} placeholder="标签" value={edit.agent_label} /></td>
          <td>{bound ? formatDateOnly(bound.updated_at) : "—"}</td>
          <td><button className="secondary-button" disabled={!dirty || saving === key} onClick={() => void save(key)} type="button">{saving === key ? "…" : "保存"}</button></td>
        </tr>;
      })}
    </tbody></table></div>}
  </section>;
}

const CAPABILITY_ROWS = [
  { capability: "GBP_WRITE", asset: "GBP", label: "GBP 写入（Post / 资料修改）" },
  { capability: "WEBSITE_WRITE", asset: "WEBSITE", label: "官网写入（Webflow 内容）" },
];

function CapabilitiesPanel({ merchantId }: { merchantId: string }) {
  const resource = useResource((signal) => seoOpsApi.capabilities(merchantId, signal), [merchantId]);
  const [saving, setSaving] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const byKey = new Map<string, CapabilityWire>((resource.data?.items ?? []).map((c) => [c.capability, c]));

  const toggle = async (capability: string, asset: string, patch: { tech?: boolean; auth?: boolean }) => {
    const current = byKey.get(capability);
    setSaving(capability); setToggleError(undefined);
    try {
      await seoOpsApi.upsertCapability(merchantId, capability, {
        asset,
        external_ref: current?.external_ref ?? null,
        tech_connected: patch.tech ?? current?.tech_connected ?? false,
        merchant_authorized: patch.auth ?? current?.merchant_authorized ?? false,
        note: current?.note ?? null,
      });
      resource.reload();
    } catch (reason) {
      // 静默失败最危险：AM 以为已授权，门 2 却会一直亮红灯。
      setToggleError(`${capability} 保存失败：${reason instanceof Error ? reason.message : "请求失败"}`);
      resource.reload();
    } finally {
      setSaving(undefined);
    }
  };

  return <section className="data-panel">
    <div className="panel-heading"><div><span className="eyebrow">CAPABILITY MATRIX</span><h2><KeyRound size={15} /> 能力矩阵</h2><p className="quiet-copy">三层推导：未接入 MISSING → 已接入未授权 BLOCKED → 都齐 ACTIVE。写入类任务只有 ACTIVE 才能过门 2。</p></div></div>
    {toggleError ? <p className="form-error" role="alert">{toggleError}</p> : null}
    {resource.loading ? <div className="page-state" role="status">读取能力…</div> : <div className="table-wrap"><table><thead><tr><th>能力</th><th>技术接入</th><th>商户授权</th><th>状态</th><th>核验时间</th></tr></thead><tbody>
      {CAPABILITY_ROWS.map(({ capability, asset, label }) => {
        const row = byKey.get(capability);
        const status = row?.status ?? "MISSING";
        return <tr key={capability}>
          <td><strong>{label}</strong><small>{capability}</small></td>
          <td><input checked={row?.tech_connected ?? false} disabled={saving === capability} onChange={(e) => void toggle(capability, asset, { tech: e.target.checked })} type="checkbox" /></td>
          <td><input checked={row?.merchant_authorized ?? false} disabled={saving === capability} onChange={(e) => void toggle(capability, asset, { auth: e.target.checked })} type="checkbox" /></td>
          <td><span className={`status-pill ${status === "ACTIVE" ? "is-stable" : status === "BLOCKED" ? "is-attention" : "is-blocked"}`}>{status}</span></td>
          <td>{formatDateOnly(row?.verified_at)}</td>
        </tr>;
      })}
    </tbody></table></div>}
  </section>;
}

function CyclePanel({ merchantId }: { merchantId: string }) {
  const resource = useResource((signal) => seoOpsApi.cycleConfig(merchantId, signal), [merchantId]);
  const [form, setForm] = useState<CycleConfigWire>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (resource.loading) return;
    setForm(resource.data ?? {
      merchant_id: merchantId, snapshot_day: 1, post_weekday: 3, post_per_week: 1,
      review_window_days: 7, audit_interval_days: 30, enabled: false, updated_by: null, updated_at: "",
    });
  }, [resource.data, resource.loading, merchantId]);

  if (!form) return <section className="data-panel"><div className="page-state" role="status">读取周期配置…</div></section>;

  const save = async () => {
    setSaving(true); setMessage(undefined);
    try {
      await seoOpsApi.upsertCycleConfig(merchantId, {
        snapshot_day: form.snapshot_day, post_weekday: form.post_weekday,
        post_per_week: form.post_per_week, review_window_days: form.review_window_days,
        audit_interval_days: form.audit_interval_days, enabled: form.enabled,
      });
      setMessage("已保存 — 下一轮调度生效");
      resource.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const num = (value: string): number | null => value === "" ? null : Number(value);

  return <section className="data-panel">
    <div className="panel-heading"><div><span className="eyebrow">CYCLE CONFIG / Ⓐ级预授权</span><h2><CalendarClock size={15} /> 周期配置</h2><p className="quiet-copy">启用后 scheduler 按此生成任务：只读类（报告/关键词周分析/审计/评论巡检）自动授权自动跑；每周 Post 生成后停在双门前等人批。</p></div>
      <label className="cycle-enable"><input checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} type="checkbox" /> 启用自动周期</label></div>
    <div className="cycle-grid">
      <label>月度快照日（1–28，空=关）
        <input max={28} min={1} onChange={(e) => setForm({ ...form, snapshot_day: num(e.target.value) })} type="number" value={form.snapshot_day ?? ""} /></label>
      <label>每周 Post 日
        <select onChange={(e) => setForm({ ...form, post_weekday: e.target.value === "" ? null : Number(e.target.value) })} value={form.post_weekday ?? ""}>
          <option value="">暂停</option>
          {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select></label>
      <label>每周 Post 篇数
        <input max={7} min={0} onChange={(e) => setForm({ ...form, post_per_week: Number(e.target.value) || 0 })} type="number" value={form.post_per_week} /></label>
      <label>评论巡检窗口（天）
        <input max={90} min={1} onChange={(e) => setForm({ ...form, review_window_days: Number(e.target.value) || 7 })} type="number" value={form.review_window_days} /></label>
      <label>审计间隔（天，空=关）
        <input max={365} min={1} onChange={(e) => setForm({ ...form, audit_interval_days: num(e.target.value) })} type="number" value={form.audit_interval_days ?? ""} /></label>
      <div className="cycle-actions">
        <button className="primary-button" disabled={saving} onClick={() => void save()} type="button">{saving ? "保存中…" : "保存周期"}</button>
        {message ? <span className="quiet-copy">{message}</span> : null}
      </div>
    </div>
  </section>;
}
