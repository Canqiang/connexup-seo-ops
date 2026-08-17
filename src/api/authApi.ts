import { requestJson } from "./client";
import type { AuthenticatedUser } from "./types";

export const authApi = {
  me: (signal?: AbortSignal) => requestJson<AuthenticatedUser>("/api/auth/me", { signal })
};
