import { redirectToLogin } from "../auth/redirect";

export class ApiError extends Error {
  status: number;
  code?: string;
  body?: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  options: { redirectOn401?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.delete("Authorization");
  const response = await fetch(path, { ...init, credentials: "same-origin", headers });
  const text = await response.text();
  const body = text ? parseBody(text) : undefined;
  if (!response.ok) {
    if (response.status === 401 && options.redirectOn401 !== false) {
      redirectToLogin();
    }
    const errorBody = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    throw new ApiError(
      response.status,
      typeof errorBody.message === "string" ? errorBody.message : response.statusText || "Request failed",
      typeof errorBody.error_code === "string" ? errorBody.error_code : undefined,
      body
    );
  }
  return body as T;
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
