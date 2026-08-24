import { requestJson } from "./client";
import type { AuthenticatedUser } from "./types";

export const authApi = {
  me: (signal?: AbortSignal) => requestJson<AuthenticatedUser>("/api/auth/me", { signal }),
  probeSession: (signal?: AbortSignal) => requestJson<AuthenticatedUser>(
    "/api/auth/me",
    { signal },
    { redirectOn401: false },
  ),
  login: (email: string, password: string) => requestJson<AuthenticatedUser>(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) },
    { redirectOn401: false },
  ),
  logout: () => requestJson<void>("/api/auth/logout", { method: "POST" }, { redirectOn401: false }),
};
