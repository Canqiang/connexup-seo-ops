import { GaugeCircle, LayoutGrid, ListChecks, LogOut, PlayCircle, Scale, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { seoOpsApi } from "../api/seoOpsApi";
import { useAuth } from "../auth/AuthContext";
import { MerchantSwitcher } from "../features/merchant/MerchantSwitcher";
import { useResource } from "../hooks/useResource";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { resolveViewMode, type ViewMode, writeViewMode } from "./viewMode";

type NavigationItem = {
  to: string;
  label: string;
  icon: typeof GaugeCircle;
  end?: boolean;
  badge: "none" | "proposals" | "unknown";
};

const operatorNavigation: NavigationItem[] = [
  { to: "/", label: "工作台", icon: GaugeCircle, end: true, badge: "none" },
  { to: "/merchants", label: "商户", icon: LayoutGrid, badge: "none" },
  { to: "/reviews", label: "复盘", icon: Scale, badge: "none" },
  { to: "/settings", label: "设置", icon: Settings2, badge: "none" },
];

const auditNavigation: NavigationItem[] = [
  { to: "/", label: "总览", icon: GaugeCircle, end: true, badge: "none" as const },
  { to: "/merchants", label: "商户", icon: LayoutGrid, badge: "none" as const },
  { to: "/inbox", label: "任务", icon: ListChecks, badge: "proposals" as const },
  { to: "/runs", label: "运行", icon: PlayCircle, badge: "unknown" as const },
  { to: "/reviews", label: "复盘", icon: Scale, badge: "none" as const },
  { to: "/settings", label: "设置", icon: Settings2, badge: "none" as const }
];

function ViewModeSwitch({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  return <div aria-label="视角" className="view-mode-switch" role="group">
    <button aria-pressed={value === "operator"} onClick={() => onChange("operator")} type="button">操作员</button>
    <button aria-pressed={value === "audit"} onClick={() => onChange("audit")} type="button">管理审计</button>
  </div>;
}

function OperatorIdentity({ name, onLogout }: { name?: string; onLogout: () => void }) {
  return <div className="topbar-actions"><div className="operator-label"><small>当前操作员</small><strong>{name}</strong></div><button aria-label="退出登录" className="logout-button" onClick={onLogout} type="button"><LogOut size={15} /> 退出登录</button></div>;
}

export function AppShell() {
  const { user, logout } = useAuth();
  const workspace = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<ViewMode>(() => resolveViewMode(location.search, window.localStorage.getItem("seo-ops:view-mode")));
  const summary = useResource((signal) => seoOpsApi.inboxSummary(signal), [location.pathname]);
  const navigation = mode === "operator" ? operatorNavigation : auditNavigation;

  useEffect(() => {
    setMode(resolveViewMode(location.search, window.localStorage.getItem("seo-ops:view-mode")));
  }, [location.search]);

  useEffect(() => {
    const timer = setInterval(() => summary.reload(), 30_000);
    return () => clearInterval(timer);
  }, [summary.reload]);
  const changeMode = (nextMode: ViewMode) => {
    writeViewMode(nextMode, window.localStorage);
    const search = new URLSearchParams(location.search);
    search.set("view", nextMode);
    setMode(nextMode);
    navigate({ pathname: location.pathname, search: `?${search.toString()}` }, { replace: true });
  };
  const badgeCount = (kind: NavigationItem["badge"]): number => {
    if (!summary.data) return 0;
    if (kind === "proposals") return summary.data.pending_proposals;
    if (kind === "unknown") return summary.data.outcome_unknown;
    return 0;
  };
  return <div className={`app-shell view-${mode}`}><aside className="sidebar"><div aria-label="Connexup SEO Ops" className="brand-mark">CX</div><nav aria-label="主导航">{navigation.map(({ to, label, icon: Icon, end, badge }) => {
    const count = badgeCount(badge);
    const destination = mode === "audit" ? `${to}?view=audit` : to;
    return <NavLink aria-label={label} end={end} key={to} title={label} to={destination}><Icon size={18} /><span>{label}</span>{count > 0 ? <em className={`nav-badge${badge === "unknown" ? " is-danger" : ""}`}>{count > 99 ? "99+" : count}</em> : null}</NavLink>;
  })}</nav><div className="operator-avatar" title={user?.name}>{(user?.name ?? "OP").slice(0, 2).toLocaleUpperCase()}</div></aside>
    <div className="workspace"><header className="topbar"><MerchantSwitcher currentId={workspace.merchantId} merchants={workspace.merchants} onPortfolio={workspace.selectPortfolio} onSelect={workspace.selectMerchant} /><ViewModeSwitch onChange={changeMode} value={mode} /><OperatorIdentity name={user?.name} onLogout={() => { void logout(); }} /></header><main className="main-content"><Outlet context={{ mode }} /></main></div>
  </div>;
}
