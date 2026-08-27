import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { StyleProfileWire } from "../../api/types";

const FIELDS: Array<{ key: "tone" | "address" | "banned" | "example" | "source"; label: string; multi?: boolean }> = [
  { key: "tone", label: "语气" }, { key: "address", label: "称呼" }, { key: "banned", label: "禁用", multi: true }, { key: "example", label: "范例" }, { key: "source", label: "来源" },
];

function asText(value: unknown): string { return Array.isArray(value) ? value.join("、") : typeof value === "string" ? value : ""; }
function formFromProfile(profile: StyleProfileWire | null): Record<string, string> {
  return Object.fromEntries(FIELDS.map((f) => [f.key, asText(profile?.voice[f.key])]));
}

/** 风格档案编辑器：编辑生成新版本（POST），从不改写既有版本或已批准稿件。
 * `form` 只在点击「编辑」时从最新 `profile` 取值——mount 时 profile 常常还是 null（GET 未回），
 * 若在 useState 初始值里取一次快照，保存时会用空字符串覆盖掉尚未加载出来的字段。 */
export function VoiceProfileEditor({ merchantId, profile, canManage, onSaved, error, onRetry }: { merchantId: string; profile: StyleProfileWire | null; canManage: boolean; onSaved: () => void; error?: unknown; onRetry: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(() => formFromProfile(profile));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const nextVersion = (profile?.version ?? 0) + 1;
  const startEditing = () => { setForm(formFromProfile(profile)); setEditing(true); };
  const save = async () => {
    setBusy(true); setMessage(undefined);
    try {
      const voice: Record<string, unknown> = { ...(profile?.voice ?? {}) };
      // 仅按表意顿号/中文逗号拆分多值字段；英文逗号是短语的一部分（如 "best, cheapest"），不能当分隔符。
      for (const f of FIELDS) voice[f.key] = f.multi ? form[f.key]!.split(/[、，]/).map((s) => s.trim()).filter(Boolean) : form[f.key];
      await seoOpsApi.saveStyleProfile(merchantId, { voice });
      setEditing(false); setMessage(`已保存 v${nextVersion}`); onSaved();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  };
  return <section aria-label="风格档案" className="data-panel voice-panel">
    <div className="panel-heading"><div><span className="eyebrow">VOICE PROFILE</span><h2>风格档案 · v{profile?.version ?? 0}</h2></div>{canManage && !editing && !error ? <button className="secondary-button" onClick={startEditing} type="button">编辑（记版本）</button> : null}</div>
    {error
      ? <div className="page-state compact is-error" role="alert">风格档案读取失败。<button onClick={onRetry} type="button">重试</button></div>
      : editing
        ? <div className="voice-form">{FIELDS.map((f) => <label key={f.key}>{f.label}<input aria-label={f.label} onChange={(e) => setForm((cur) => ({ ...cur, [f.key]: e.target.value }))} placeholder={f.multi ? "多个用「、」分隔" : undefined} value={form[f.key]} /></label>)}
            <div><button className="primary-button" disabled={busy} onClick={() => void save()} type="button">{busy ? "保存中…" : `保存为 v${nextVersion}`}</button><button className="secondary-button" onClick={() => setEditing(false)} type="button">取消</button></div></div>
        : profile
          ? <dl className="identity-ledger">{FIELDS.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{asText(profile.voice[f.key]) || "—"}</dd></div>)}</dl>
          : <p className="quiet-copy">尚无风格档案；首个版本可由品牌档案 voice 派生后人工校订。</p>}
    {!error ? <p className="quiet-copy">生成与重写按稿件引用固定版本，档案更新不追溯已批准稿。</p> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </section>;
}
