import { GaugeCircle, LayoutGrid, ListChecks, LogOut, PlayCircle, Scale, Settings2 } from "lucide-react";
import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { seoOpsApi } from "../api/seoOpsApi";
import { useAuth } from "../auth/AuthContext";
import { MerchantSwitcher } from "../features/merchant/MerchantSwitcher";
import { useResource } from "../hooks/useResource";
import { useWorkspace } from "../workspace/WorkspaceContext";

/** 账本视角 6 导航：总览 / 商户 / 任务（含待判定建议）/ 运行（查证工作台）/ 复盘 / 设置。 */
const navigation = [
  { to: "/", label: "总览", icon: GaugeCircle, end: true, badge: "none" as const },
  { to: "/merchants", label: "商户", icon: LayoutGrid, badge: "none" as const },
  { to: "/inbox", label: "任务", icon: ListChecks, badge: "proposals" as const },
  { to: "/runs", label: "运行", icon: PlayCircle, badge: "unknown" as const },
  { to: "/reviews", label: "复盘", icon: Scale, badge: "none" as const },
  { to: "/settings", label: "设置", icon: Settings2, badge: "none" as const }
];

export function AppShell() {
  const { user, logout } = useAuth();
  const workspace = useWorkspace();
  const { pathname } = useLocation();
  // 徽标随路由切换刷新（页面上的动作大多伴随跳转），再加 30s 兜底轮询防走神。
  const summary = useResource((signal) => seoOpsApi.inboxSummary(signal), [pathname]);
  useEffect(() => {
    const timer = setInterval(() => summary.reload(), 30_000);
    return () => clearInterval(timer);
  }, [summary.reload]);
  const badgeCount = (kind: "none" | "proposals" | "unknown"): number => {
    if (!summary.data) return 0;
    if (kind === "proposals") return summary.data.pending_proposals;
    if (kind === "unknown") return summary.data.outcome_unknown;
    return 0;
  };
  return <div className="app-shell"><aside className="sidebar"><div className="brand-mark" aria-label="Connexup SEO Ops">CX</div><nav aria-label="主导航">{navigation.map(({ to, label, icon: Icon, end, badge }) => {
    const count = badgeCount(badge);
    return <NavLink aria-label={label} end={end} key={to} title={label} to={to}><Icon size={18} /><span>{label}</span>{count > 0 ? <em className={`nav-badge${badge === "unknown" ? " is-danger" : ""}`}>{count > 99 ? "99+" : count}</em> : null}</NavLink>;
  })}</nav><div className="operator-avatar" title={user?.name}>{(user?.name ?? "OP").slice(0, 2).toLocaleUpperCase()}</div></aside>
    <div className="workspace"><header className="topbar"><MerchantSwitcher currentId={workspace.merchantId} merchants={workspace.merchants} onPortfolio={workspace.selectPortfolio} onSelect={workspace.selectMerchant} /><div className="topbar-actions"><div className="operator-label"><small>当前操作员</small><strong>{user?.name}</strong></div><button aria-label="退出登录" className="logout-button" onClick={() => { void logout(); }} type="button"><LogOut size={15} /> 退出登录</button></div></header><main className="main-content"><Outlet /></main></div>
  </div>;
}
