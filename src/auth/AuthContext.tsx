import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authApi } from "../api/authApi";
import type { AuthenticatedUser } from "../api/types";
import { navigateTo } from "./redirect";
import { clearAuthStorage } from "./storage";

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
  const refresh = useCallback(async (signal?: AbortSignal, isCurrent: () => boolean = () => true) => {
    const canCommit = () => !signal?.aborted && isCurrent();
    setLoading(true);
    setError(undefined);
    try {
      const next = await authApi.me(signal);
      if (!canCommit()) return;
      setUser(next);
    } catch (reason) {
      if (!canCommit()) return;
      setUser(undefined);
      setError(reason);
    } finally {
      if (!canCommit()) return;
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // The browser must leave the protected workspace even if the network cannot confirm logout.
    } finally {
      clearAuthStorage();
      setUser(undefined);
      navigateTo("/seo-ops/login");
    }
  }, []);
  useEffect(() => {
    clearAuthStorage();
    const controller = new AbortController();
    let ignore = false;
    void refresh(controller.signal, () => !ignore);
    return () => { ignore = true; controller.abort(); };
  }, [refresh]);
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
