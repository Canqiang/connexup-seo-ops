export interface PageSlice {
  items: readonly unknown[];
  offset: number;
  limit: number;
  total: number;
}

export interface CanonicalOffset {
  value: number;
  needsNormalization: boolean;
}

const canonicalNonnegativeDecimal = /^(0|[1-9]\d*)$/;

export function canonicalOffset(params: URLSearchParams, key = "offset"): CanonicalOffset {
  const values = params.getAll(key);
  if (values.length === 0) return { value: 0, needsNormalization: false };
  if (values.length !== 1 || !canonicalNonnegativeDecimal.test(values[0])) {
    return { value: 0, needsNormalization: true };
  }
  const value = Number(values[0]);
  return Number.isSafeInteger(value)
    ? { value, needsNormalization: false }
    : { value: 0, needsNormalization: true };
}

export function pageRecoveryOffset(page: PageSlice): number | null {
  if (page.items.length > 0 || page.offset === 0) return null;
  if (page.total <= 0) return 0;
  if (page.offset < page.total || page.limit <= 0) return null;
  return Math.floor((page.total - 1) / page.limit) * page.limit;
}

export function visiblePageRange(page: PageSlice): { start: number; end: number } | null {
  if (page.items.length === 0) return null;
  return {
    start: page.offset + 1,
    end: Math.min(page.offset + page.items.length, page.total),
  };
}
