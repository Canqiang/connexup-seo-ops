import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { seoOpsApi } from "../api/seoOpsApi";
import type { MerchantSummary, PortfolioResponse } from "../api/types";
import { useResource } from "../hooks/useResource";

type WorkspaceContextValue = {
  mode: "portfolio" | "merchant";
  merchantId?: string;
  merchant?: MerchantSummary;
  merchants: MerchantSummary[];
  portfolio?: PortfolioResponse;
  loading: boolean;
  error?: unknown;
  reload: () => void;
  selectPortfolio: () => void;
  selectMerchant: (id: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const resource = useResource((signal) => seoOpsApi.portfolio(signal), []);
  const match = location.pathname.match(/^\/merchants\/([^/]+)/);
  const merchantId = match ? decodeURIComponent(match[1]) : undefined;
  const merchants = resource.data?.merchants ?? [];
  const merchant = merchants.find((item) => item.id === merchantId);
  const value = useMemo<WorkspaceContextValue>(() => ({
    mode: merchantId ? "merchant" : "portfolio",
    merchantId,
    merchant,
    merchants,
    portfolio: resource.data,
    loading: resource.loading,
    error: resource.error,
    reload: resource.reload,
    selectPortfolio: () => navigate("/"),
    selectMerchant: (id) => navigate(`/merchants/${encodeURIComponent(id)}`)
  }), [merchantId, merchant, merchants, resource.data, resource.loading, resource.error, resource.reload, navigate]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
