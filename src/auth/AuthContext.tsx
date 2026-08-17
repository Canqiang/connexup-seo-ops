import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { authApi } from "../api/authApi";
import type { AuthenticatedUser } from "../api/types";

type AuthContextValue = {
  user?: AuthenticatedUser;
  loading: boolean;
  error?: unknown;
  refresh: () => Promise<void>;
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
      localStorage.setItem("userId", next.user_id);
      localStorage.setItem("userName", next.name);
      localStorage.setItem("userRole", next.role);
      localStorage.setItem("userPermissions", JSON.stringify(next.permissions));
    } catch (reason) {
      setUser(undefined);
      setError(reason);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const value = useMemo(() => ({ user, loading, error, refresh }), [user, loading, error, refresh]);
  if (loading) return <div className="app-state" role="status">正在确认 Core AI 身份…</div>;
  if (error || !user) return <div className="app-state is-error" role="alert">无法确认身份，请重新登录。</div>;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
