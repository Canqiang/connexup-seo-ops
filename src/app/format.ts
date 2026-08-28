/** 全局展示格式：时间一律本地时区（wire 是 UTC ISO —— 直接 slice 会把 UTC
 * 当本地时间显示，晚上发布的日期还会差一天）；外链一律过 http(s) 白名单。 */

const DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const DATE_ONLY = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
});

export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "—" : DATE_TIME.format(new Date(ms));
}

export function formatDateOnly(value?: string | null): string {
  if (!value) return "—";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "—" : DATE_ONLY.format(new Date(ms));
}

/** 只允许 http(s) 的外链；其他（javascript: 等）返回 null，调用方降级为纯文本。 */
export function safeHref(value?: string | null): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
}

/** 商家公开问卷链接：SPA 挂在 /seo-ops base 下，链接必须带上。 */
export function publicFormUrl(shareSlug: string): string {
  return `${window.location.origin}/seo-ops/q/${shareSlug}`;
}

/** 运营者本地时区相对 UTC 的分钟偏移（UTC+8 → 480）。 */
export function localTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}
