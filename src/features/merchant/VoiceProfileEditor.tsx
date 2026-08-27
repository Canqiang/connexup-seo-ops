import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { StyleProfileWire } from "../../api/types";

const FIELDS: Array<{ key: "tone" | "address" | "banned" | "example" | "source"; label: string; multi?: boolean }> = [
  { key: "tone", label: "语气" }, { key: "address", label: "称呼" }, { key: "banned", label: "禁用", multi: true }, { key: "example", label: "范例" }, { key: "source", label: "来源" },
];

function asText(value: unknown): string { return Array.isArray(value) ? value.join("、") : typeof value === "string" ? value : ""; }

/** 风格档案编辑器：编辑生成新版本（POST），从不改写既有版本或已批准稿件。 */
export function VoiceProfileEditor({ merchantId, profile, canManage, onSaved }: { merchantId: string; profile: StyleProfileWire | null; canManage: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, asText(profile?.voice[f.key])])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const nextVersion = (profile?.version ?? 0) + 1;
  const save = async () => {
    setBusy(true); setMessage(undefined);
    try {
      const voice: Record<string, unknown> = { ...(profile?.voice ?? {}) };
      for (const f of FIELDS) voice[f.key] = f.multi ? form[f.key]!.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : form[f.key];
      await seoOpsApi.saveStyleProfile(merchantId, { voice });
      setEditing(false); setMessage(`已保存 v${nextVersion}`); onSaved();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  };
  return <section aria-label="风格档案" className="data-panel voice-panel">
    <div className="panel-heading"><div><span className="eyebrow">VOICE PROFILE</span><h2>风格档案 · v{profile?.version ?? 0}</h2></div>{canManage && !editing ? <button className="secondary-button" onClick={() => setEditing(true)} type="button">编辑（记版本）</button> : null}</div>
    {editing ? <div className="voice-form">{FIELDS.map((f) => <label key={f.key}>{f.label}<input aria-label={f.label} onChange={(e) => setForm((cur) => ({ ...cur, [f.key]: e.target.value }))} value={form[f.key]} /></label>)}
      <div><button className="primary-button" disabled={busy} onClick={() => void save()} type="button">{busy ? "保存中…" : `保存为 v${nextVersion}`}</button><button className="secondary-button" onClick={() => setEditing(false)} type="button">取消</button></div></div>
      : profile ? <dl className="identity-ledger">{FIELDS.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{asText(profile.voice[f.key]) || "—"}</dd></div>)}</dl> : <p className="quiet-copy">尚无风格档案；首个版本可由品牌档案 voice 派生后人工校订。</p>}
    <p className="quiet-copy">生成与重写按稿件引用固定版本，档案更新不追溯已批准稿。</p>
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </section>;
}
