import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authApi } from "../api/authApi";
import type { AuthenticatedUser } from "../api/types";
import { navigateTo } from "./redirect";

type AuthContextValue = {
  user?: AuthenticatedUser;
  loading: boolean;
  error?: unknown;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthenticatedUser>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await authApi.me();
      setUser(next);
    } catch (reason) {
      setUser(undefined);
      setError(reason);
    } finally {
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(undefined);
      navigateTo("/seo-ops/login");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const value = useMemo(() => ({ user, loading, error, refresh, logout }), [user, loading, error, refresh, logout]);
  if (loading) return <div className="app-state" role="status">正在确认 SEO Ops 身份…</div>;
  if (error || !user) return <div className="app-state is-error" role="alert">无法确认身份，请重新登录。</div>;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
