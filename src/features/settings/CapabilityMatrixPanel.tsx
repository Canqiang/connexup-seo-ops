import { KeyRound } from "lucide-react";
import { useState } from "react";
import type { CapabilityWire } from "../../api/types";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateOnly } from "../../app/format";
import { useResource } from "../../hooks/useResource";

const CAPABILITY_ROWS = [
  { capability: "GBP_WRITE", asset: "GBP", label: "GBP 写入（Post / 资料修改）" },
  { capability: "WEBSITE_WRITE", asset: "WEBSITE", label: "官网写入（Webflow 内容）" },
];

export function CapabilityMatrixPanel({ canManage, merchantId }: { canManage: boolean; merchantId?: string }) {
  if (!merchantId) return <section aria-labelledby="capability-heading" className="settings-section data-panel">
    <PanelHeading />
    <div className="settings-evidence-gap">没有可用商户范围，能力状态不可用。</div>
  </section>;
  return <CapabilityMatrixResource canManage={canManage} merchantId={merchantId} />;
}

function CapabilityMatrixResource({ canManage, merchantId }: { canManage: boolean; merchantId: string }) {
  const resource = useResource((signal) => seoOpsApi.capabilities(merchantId, signal), [merchantId]);
  const [saving, setSaving] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const byKey = new Map<string, CapabilityWire>((resource.data?.items ?? []).map((capability) => [capability.capability, capability]));

  const toggle = async (capability: string, asset: string, patch: { tech?: boolean; auth?: boolean }) => {
    if (!canManage) return;
    const current = byKey.get(capability);
    setSaving(capability);
    setToggleError(undefined);
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
      setToggleError(`${capability} 保存失败：${reason instanceof Error ? reason.message : "请求失败"}`);
      resource.reload();
    } finally {
      setSaving(undefined);
    }
  };

  return <section aria-labelledby="capability-heading" className="settings-section data-panel">
    <PanelHeading />
    {!canManage ? <p className="settings-readonly">当前账号可查看能力状态，但没有修改权限。</p> : null}
    {toggleError ? <p className="form-error" role="alert">{toggleError}</p> : null}
    {resource.error ? <div className="page-state compact is-error" role="alert">能力矩阵读取失败。<button onClick={resource.reload} type="button">重试</button></div> : null}
    {resource.loading ? <div className="page-state compact" role="status">读取能力…</div> : null}
    {!resource.loading && !resource.error ? <div className="table-wrap"><table><thead><tr><th>能力</th><th>技术接入</th><th>商户授权</th><th>状态</th><th>核验时间</th></tr></thead><tbody>
      {CAPABILITY_ROWS.map(({ capability, asset, label }) => {
        const row = byKey.get(capability);
        const status = row?.status ?? "MISSING";
        return <tr key={capability}>
          <td><strong>{label}</strong><small>{capability}</small></td>
          <td><input aria-label={`${label} 技术接入`} checked={row?.tech_connected ?? false} disabled={!canManage || saving === capability} onChange={(event) => void toggle(capability, asset, { tech: event.target.checked })} type="checkbox" /></td>
          <td><input aria-label={`${label} 商户授权`} checked={row?.merchant_authorized ?? false} disabled={!canManage || saving === capability} onChange={(event) => void toggle(capability, asset, { auth: event.target.checked })} type="checkbox" /></td>
          <td><span className={`status-pill ${status === "ACTIVE" ? "is-stable" : status === "BLOCKED" ? "is-attention" : "is-blocked"}`}>{status}</span></td>
          <td>{formatDateOnly(row?.verified_at)}</td>
        </tr>;
      })}
    </tbody></table></div> : null}
  </section>;
}

function PanelHeading() {
  return <div className="panel-heading"><div><span className="eyebrow">CAPABILITY MATRIX</span><h2 id="capability-heading"><KeyRound size={15} /> 能力矩阵</h2><p className="quiet-copy">技术接入与商户授权均有后端记录，写入任务才具备继续过门条件。</p></div></div>;
}
