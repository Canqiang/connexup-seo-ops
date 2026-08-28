import { KeyRound } from "lucide-react";
import { useRef, useState } from "react";
import type { CapabilityWire } from "../../api/types";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateOnly } from "../../app/format";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";

/** Only GBP_WRITE / WEBSITE_WRITE feed Gate 2 (`requiredCapabilityFor`); the
 * other three only affect proposal validation / onboarding reminders — the
 * matrix must say so honestly instead of implying they block execution. */
const CAPABILITY_ROWS = [
  { capability: "GBP_WRITE", asset: "GBP", label: "GBP 写入（Post / 资料修改）", gate2: true },
  { capability: "REVIEW_REPLY", asset: "GBP", label: "GBP 评论回复", gate2: false },
  { capability: "WEBSITE_WRITE", asset: "WEBSITE", label: "官网写入", gate2: true },
  { capability: "WEBSITE_APPLY", asset: "WEBSITE", label: "官网成品人工应用", gate2: false },
  { capability: "XHS_PUBLISH", asset: "XHS", label: "小红书发布", gate2: false },
];

export function impactCopy(status: string, capability: string): string {
  if (status === "ACTIVE") {
    return capability === "GBP_WRITE" || capability === "WEBSITE_WRITE"
      ? "可进双门执行（仍需门 1+2）"
      : "建议校验可通过";
  }
  if (status === "BLOCKED") {
    const scope = capability.startsWith("GBP") ? "GBP" : capability.startsWith("WEBSITE") ? "官网" : "该资产";
    return `${scope} 写入类建议一律校验失败`;
  }
  return "未连接 · 相关建议校验失败的数据源";
}

/** The matrix is cross-merchant: every scoped merchant × every capability row
 * always renders, even where no capability record was ever persisted (shown
 * as MISSING). The section only registers under its "能力矩阵" accessible
 * name once both the merchant scope and the capability list have loaded for
 * the very first time — mounting it earlier (with a still-empty merchant
 * list) would let consumers observe a region that has not yet settled.
 *
 * That initial-load gate is a one-way latch (`hasLoadedOnce`), not a raw
 * `loading` check: every toggle calls `resource.reload()` (in both the
 * success and the failure branch) to refresh the row it just touched, which
 * flips `resource.loading` back to `true` for the duration of the refetch.
 * If the whole section unmounted on every such reload, it would take the
 * panel heading, the `canManage` notice, and — worst of all — the
 * `toggleError` alert it had just set with it, hiding the very failure the
 * operator needs to see. Once the matrix has loaded once, only the
 * rows/table region is replaced by a status placeholder during a reload;
 * everything else (heading, notices, error banner) stays mounted. */
export function CapabilityMatrixPanel({ canManage, merchantId }: { canManage: boolean; merchantId?: string }) {
  const workspace = useWorkspace();
  const resource = useResource((signal) => seoOpsApi.allCapabilities(signal), []);
  const [saving, setSaving] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [noteDrafts, setNoteDrafts] = useState<Record<string, { note: string; external_ref: string }>>({});

  const dataReady = !workspace.loading && !resource.loading;
  const hasLoadedOnceRef = useRef(false);
  if (dataReady) hasLoadedOnceRef.current = true;

  if (!hasLoadedOnceRef.current) {
    return <div className="page-state compact" role="status">读取能力矩阵…</div>;
  }

  const byKey = new Map<string, CapabilityWire>(
    (resource.data?.items ?? []).map((c) => [`${c.merchant_id}:${c.capability}`, c]),
  );

  const toggle = async (targetMerchantId: string, capability: string, asset: string, patch: { tech?: boolean; auth?: boolean }) => {
    if (!canManage) return;
    const key = `${targetMerchantId}:${capability}`;
    const current = byKey.get(key);
    setSaving(key);
    setToggleError(undefined);
    try {
      await seoOpsApi.upsertCapability(targetMerchantId, capability, {
        asset,
        external_ref: current?.external_ref ?? null,
        tech_connected: patch.tech ?? current?.tech_connected ?? false,
        merchant_authorized: patch.auth ?? current?.merchant_authorized ?? false,
        note: current?.note ?? null,
      });
      resource.reload();
    } catch (reason) {
      setToggleError(`${capability} 保存失败：${reason instanceof Error ? reason.message : "请求失败"}`);
      resource.reload();
    } finally {
      setSaving(undefined);
    }
  };

  const saveNote = async (targetMerchantId: string, capability: string, asset: string) => {
    if (!canManage) return;
    const key = `${targetMerchantId}:${capability}`;
    const current = byKey.get(key);
    const draft = noteDrafts[key];
    setSaving(key);
    setToggleError(undefined);
    try {
      await seoOpsApi.upsertCapability(targetMerchantId, capability, {
        asset,
        external_ref: draft?.external_ref.trim() || null,
        tech_connected: current?.tech_connected ?? false,
        merchant_authorized: current?.merchant_authorized ?? false,
        note: draft?.note.trim() || null,
      });
      setExpanded(undefined);
      resource.reload();
    } catch (reason) {
      setToggleError(`${capability} 保存失败：${reason instanceof Error ? reason.message : "请求失败"}`);
    } finally {
      setSaving(undefined);
    }
  };

  return <section aria-labelledby="capability-heading" className="settings-section data-panel">
    <PanelHeading />
    {!canManage ? <p className="settings-readonly">当前账号可查看能力状态，但没有修改权限。</p> : null}
    {toggleError ? <p className="form-error" role="alert">{toggleError}</p> : null}
    {resource.error ? <div className="page-state compact is-error" role="alert">能力矩阵读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {workspace.loading || resource.loading ? <div className="page-state compact" role="status">读取能力矩阵…</div> : null}
    {!workspace.loading && !resource.loading && !resource.error && !workspace.merchants.length ? <div className="settings-evidence-gap">没有可用商户范围，能力状态不可用。</div> : null}
    {!workspace.loading && !resource.loading && !resource.error && workspace.merchants.length ? <div className="table-wrap"><table><thead><tr>
      <th>商户 · 资产</th><th>能力</th><th>技术连接</th><th>商户授权</th><th>状态</th><th>最近核验</th><th>影响</th><th>备注</th>
    </tr></thead><tbody>
      {workspace.merchants.flatMap((merchant) => CAPABILITY_ROWS.map(({ capability, asset, label }) => {
        const key = `${merchant.id}:${capability}`;
        const row = byKey.get(key);
        const status = row?.status ?? "MISSING";
        const isExpanded = expanded === key;
        const draft = noteDrafts[key] ?? { note: row?.note ?? "", external_ref: row?.external_ref ?? "" };
        return <tr
          aria-label={`${merchant.display_name} ${capability}`}
          className={merchant.id === merchantId ? "is-selected" : undefined}
          key={key}
        >
          <td><strong>{merchant.display_name}</strong><small>{asset}</small></td>
          <td><strong>{label}</strong><small>{capability}</small></td>
          <td><input
            aria-label={`${merchant.display_name} ${label} 技术连接`}
            checked={row?.tech_connected ?? false}
            disabled={!canManage || saving === key}
            onChange={(event) => void toggle(merchant.id, capability, asset, { tech: event.target.checked })}
            type="checkbox"
          /></td>
          <td><input
            aria-label={`${merchant.display_name} ${label} 商户授权`}
            checked={row?.merchant_authorized ?? false}
            disabled={!canManage || saving === key}
            onChange={(event) => void toggle(merchant.id, capability, asset, { auth: event.target.checked })}
            type="checkbox"
          /></td>
          <td><span className={`status-pill ${status === "ACTIVE" ? "is-stable" : status === "BLOCKED" ? "is-attention" : "is-blocked"}`}>{status}</span></td>
          <td>{formatDateOnly(row?.verified_at)}</td>
          <td className="capability-impact">{impactCopy(status, capability)}</td>
          <td>
            {isExpanded ? <div className="capability-note-editor">
              <input
                aria-label={`${merchant.display_name} ${capability} 备注`}
                className="inline-input"
                onChange={(event) => setNoteDrafts((current) => ({ ...current, [key]: { ...draft, note: event.target.value } }))}
                placeholder="备注"
                value={draft.note}
              />
              <input
                aria-label={`${merchant.display_name} ${capability} 外部标识`}
                className="inline-input"
                onChange={(event) => setNoteDrafts((current) => ({ ...current, [key]: { ...draft, external_ref: event.target.value } }))}
                placeholder="external_ref"
                value={draft.external_ref}
              />
              <div className="capability-note-actions">
                <button className="primary-button" disabled={!canManage || saving === key} onClick={() => void saveNote(merchant.id, capability, asset)} type="button">保存</button>
                <button className="secondary-button" onClick={() => setExpanded(undefined)} type="button">取消</button>
              </div>
            </div> : <button
              className="capability-note-toggle"
              disabled={!canManage}
              onClick={() => { setExpanded(key); setNoteDrafts((current) => ({ ...current, [key]: draft })); }}
              type="button"
            >{row?.note || "添加备注"}</button>}
          </td>
        </tr>;
      }))}
    </tbody></table></div> : null}
  </section>;
}

function PanelHeading() {
  return <div className="panel-heading"><div><span className="eyebrow">CAPABILITY MATRIX</span><h2 id="capability-heading"><KeyRound size={15} /> 能力矩阵</h2><p className="quiet-copy">三层缺一即挡：技术连接 → 商户授权 → 单次仍需门 1 + 门 2</p></div></div>;
}
