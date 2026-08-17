import { BarChart3, Bot, FileBarChart, Inbox, LayoutGrid, ListChecks, Settings2, Sparkles } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { seoOpsApi } from "../api/seoOpsApi";
import { useAuth } from "../auth/AuthContext";
import { hasPermission } from "../auth/permissions";
import { CopilotPanel } from "../features/copilot/CopilotPanel";
import { MerchantSwitcher } from "../features/merchant/MerchantSwitcher";
import { useResource } from "../hooks/useResource";
import { useWorkspace } from "../workspace/WorkspaceContext";

const navigation = [
  { to: "/", label: "商户组合", icon: LayoutGrid, end: true },
  { to: "/inbox", label: "行动收件箱", icon: Inbox },
  { to: "/inbox?view=all", label: "执行任务", icon: ListChecks },
  { to: "/reviews", label: "复盘与因果", icon: BarChart3 },
  { to: "/reports", label: "数据与报告", icon: FileBarChart }
];

export function AppShell() {
  const { user } = useAuth();
  const workspace = useWorkspace();
  const config = useResource((signal) => seoOpsApi.config(signal), []);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const copilotAvailable = hasPermission(user?.permissions, "chat.use") && config.data?.copilot_enabled;
  return <div className="app-shell"><aside className="sidebar"><div className="brand-mark" aria-label="Connexup SEO Ops">CX</div><nav aria-label="主导航">{navigation.map(({ to, label, icon: Icon, end }) => <NavLink aria-label={label} end={end} key={to} title={label} to={to}><Icon size={18} /><span>{label}</span></NavLink>)}<a aria-label="Core AI 设置" href="/settings" title="Core AI 设置"><Settings2 size={18} /><span>设置</span></a></nav><div className="operator-avatar" title={user?.name}>{(user?.name ?? "OP").slice(0, 2).toLocaleUpperCase()}</div></aside>
    <div className="workspace"><header className="topbar"><MerchantSwitcher currentId={workspace.merchantId} merchants={workspace.merchants} onPortfolio={workspace.selectPortfolio} onSelect={workspace.selectMerchant} userId={user?.user_id ?? "unknown"} /><div className="topbar-actions"><div className="operator-label"><small>当前操作员</small><strong>{user?.name}</strong></div>{copilotAvailable ? <button aria-label="打开 SEO Ops Copilot" className="copilot-trigger" onClick={() => setCopilotOpen(true)} type="button"><Sparkles size={15} /> Copilot</button> : <span className="copilot-disabled"><Bot size={14} /> Copilot 未配置</span>}</div></header><main className="main-content"><Outlet /></main></div>
    {copilotOpen && config.data ? <CopilotPanel config={config.data} onClose={() => setCopilotOpen(false)} /> : null}
  </div>;
}
