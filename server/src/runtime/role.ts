export type RuntimeRole = "api" | "worker" | "scheduler" | "all";

export interface RuntimePolicy {
  http: boolean;
  workers: boolean;
  scheduler: boolean;
}

export function resolveRuntimeRole(
  raw: string | undefined,
  nodeEnv: string | undefined,
): RuntimeRole {
  const value = raw ?? (nodeEnv === "production" ? "" : "all");
  if (value === "api" || value === "worker" || value === "scheduler") return value;
  if (value === "all" && nodeEnv !== "production") return value;
  if (nodeEnv === "production") {
    throw new Error("SEO_OPS_RUNTIME_ROLE must be api, worker, or scheduler in production");
  }
  throw new Error("SEO_OPS_RUNTIME_ROLE must be api, worker, scheduler, or all");
}

export function runtimePolicy(role: RuntimeRole): RuntimePolicy {
  return {
    http: role === "api" || role === "all",
    workers: role === "worker" || role === "all",
    scheduler: role === "scheduler" || role === "all",
  };
}
