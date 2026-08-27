import { ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { hasPermission } from "../../auth/permissions";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { AgentBindingsPanel } from "./AgentBindingsPanel";
import { CadencePanel } from "./CadencePanel";
import { CapabilityMatrixPanel } from "./CapabilityMatrixPanel";
import { SystemStatusPanel } from "./SystemStatusPanel";
import { GbpLocationBindingPanel } from "./GbpLocationBindingPanel";

export function SettingsPage() {
  const { user } = useAuth();
  const workspace = useWorkspace();
  usePageTitle("设置");
  const [merchantId, setMerchantId] = useState("");
  useEffect(() => {
    if (!merchantId && workspace.merchants.length) setMerchantId(workspace.merchants[0]!.id);
    if (merchantId && !workspace.merchants.some((merchant) => merchant.id === merchantId)) setMerchantId(workspace.merchants[0]?.id ?? "");
  }, [workspace.merchants, merchantId]);
  const canManageCapabilities = hasPermission(user?.permissions, "seoops.capability.manage");
  const canSchedule = hasPermission(user?.permissions, "seoops.schedule.manage");
  const selectedMerchant = workspace.merchants.find((merchant) => merchant.id === merchantId);

  return <>
    <header className="page-heading settings-heading"><div><span className="eyebrow">OPERATOR GOVERNANCE / 可回读治理</span><h1>设置</h1><p>配置商户节奏与执行能力，同时把没有后端证据的系统状态留白标明。</p></div><span className="scope-chip"><ShieldCheck size={14} /> 已登录身份回读</span></header>
    <div className="settings-scope-bar"><div><span className="eyebrow">MERCHANT SCOPE</span><strong>以下配置按商户生效</strong></div><label className="merchant-select">商户<select aria-label="设置商户范围" onChange={(event) => setMerchantId(event.target.value)} value={merchantId}>{workspace.merchants.map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.display_name}</option>)}</select></label></div>
    <div className="settings-ledger">
      <CapabilityMatrixPanel canManage={canManageCapabilities} merchantId={merchantId || undefined} />
      <CadencePanel canManage={canSchedule} merchantId={merchantId || undefined} />
      <GbpLocationBindingPanel canManage={canSchedule} locations={selectedMerchant?.locations ?? []} merchantId={merchantId || undefined} />
      <AgentBindingsPanel canManage={canSchedule} />
      <UserPermissionsPanel />
      <SystemStatusPanel canSchedule={canSchedule} />
    </div>
  </>;
}

function UserPermissionsPanel() {
  const { user } = useAuth();
  return <section aria-labelledby="permissions-heading" className="settings-section permissions-panel data-panel">
    <div className="panel-heading"><div><span className="eyebrow">AUTHENTICATED ACTOR / READ ONLY</span><h2 id="permissions-heading"><UserRound size={15} /> 用户与权限</h2><p className="quiet-copy">来自 /api/auth/me 的当前身份与原始权限代码；本页不提供账号管理能力。</p></div><span className="status-pill is-stable">只读</span></div>
    <dl className="identity-ledger">
      <div><dt>操作员</dt><dd>{user?.name ?? "不可用"}</dd></div>
      <div><dt>用户 ID</dt><dd><code>{user?.user_id ?? "不可用"}</code></dd></div>
      <div><dt>角色</dt><dd><code>{user?.role ?? "不可用"}</code></dd></div>
      <div className="permission-codes"><dt>权限代码</dt><dd>{user?.permissions.length ? user.permissions.map((permission) => <code key={permission}>{permission}</code>) : <span>当前身份未返回权限代码</span>}</dd></div>
    </dl>
  </section>;
}
