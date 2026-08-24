const TRUSTED_RETURN_ORIGIN = "https://seo-ops.invalid";
const SEO_OPS_PATH_PREFIX = "/seo-ops/";
const MAX_DECODE_PASSES = 8;

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
  if (typeof path !== "string" || !path.startsWith(SEO_OPS_PATH_PREFIX)) return SEO_OPS_PATH_PREFIX;
  if (hasControlCharacter(path)) return SEO_OPS_PATH_PREFIX;

  const decoded = decodeReturnPath(path);
  if (!decoded) return SEO_OPS_PATH_PREFIX;
  const decodedPathname = decoded.split(/[?#]/, 1)[0];

  if (
    !decoded.startsWith(SEO_OPS_PATH_PREFIX)
    || hasControlCharacter(decoded)
    || decoded.includes("//")
    || decoded.includes("\\")
    || decoded.includes("://")
    || hasDotSegment(decodedPathname)
    || /^\/seo-ops\/login(?:[/?#]|$)/.test(decoded)
  ) return SEO_OPS_PATH_PREFIX;

  let normalized: URL;
  try {
    normalized = new URL(decoded, TRUSTED_RETURN_ORIGIN);
  } catch {
    return SEO_OPS_PATH_PREFIX;
  }
  if (normalized.origin !== TRUSTED_RETURN_ORIGIN || !normalized.pathname.startsWith(SEO_OPS_PATH_PREFIX)) {
    return SEO_OPS_PATH_PREFIX;
  }
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function decodeReturnPath(path: string): string | undefined {
  let decoded = path;
  try {
    for (let index = 0; index < MAX_DECODE_PASSES; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function hasDotSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment === "." || segment === "..");
}
