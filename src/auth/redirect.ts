export function buildLoginUrl(path: string): string {
  return `/seo-ops/login?return_to=${encodeURIComponent(safeReturnTo(path))}`;
}

export function redirectToLogin(path = window.location.pathname + window.location.search): void {
  navigateTo(buildLoginUrl(path));
}

export function navigateTo(path: string): void {
  window.location.assign(path);
}

export function isLoginPath(path: string): boolean {
  return path === "/seo-ops/login" || path === "/seo-ops/login/";
}

export function safeReturnTo(path: string | null | undefined): string {
  if (typeof path !== "string" || !path.startsWith("/seo-ops/")) return "/seo-ops/";
  if (hasControlCharacter(path)) return "/seo-ops/";

  let decoded = path;
  try {
    for (let index = 0; index < 4; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return "/seo-ops/";
  }

  if (
    !decoded.startsWith("/seo-ops/")
    || hasControlCharacter(decoded)
    || decoded.includes("//")
    || decoded.includes("\\")
    || decoded.includes("://")
    || /^\/seo-ops\/login(?:[/?#]|$)/.test(decoded)
  ) return "/seo-ops/";
  return path;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}
