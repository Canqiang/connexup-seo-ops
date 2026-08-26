export type ViewMode = "operator" | "audit";

const STORAGE_KEY = "seo-ops:view-mode";

export function resolveViewMode(search: string, stored: string | null): ViewMode {
  const query = new URLSearchParams(search).get("view");
  if (query === "operator" || query === "audit") return query;
  return stored === "audit" ? "audit" : "operator";
}

export function writeViewMode(mode: ViewMode, storage: Pick<Storage, "setItem">): void {
  storage.setItem(STORAGE_KEY, mode);
}
