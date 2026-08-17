export function buildLoginUrl(path: string): string {
  const safePath = path.startsWith("/seo-ops") ? path : "/seo-ops/";
  return `/login?return_to=${encodeURIComponent(safePath)}`;
}

export function redirectToLogin(path = window.location.pathname + window.location.search): void {
  window.location.assign(buildLoginUrl(path));
}
