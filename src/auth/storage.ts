const LEGACY_IDENTITY_KEYS = ["apiKey", "userId", "userName", "userRole", "userPermissions"] as const;
const FAVORITE_KEY_PREFIX = "seoops.favorite_merchants.";
const MAX_STORAGE_KEYS_TO_SCAN = 256;

export function clearAuthStorage(storage?: Storage): void {
  try {
    const target = storage ?? localStorage;
    LEGACY_IDENTITY_KEYS.forEach((key) => target.removeItem(key));
    const keys = Array.from(
      { length: Math.min(target.length, MAX_STORAGE_KEYS_TO_SCAN) },
      (_, index) => target.key(index),
    );
    keys.forEach((key) => {
      if (key?.startsWith(FAVORITE_KEY_PREFIX)) target.removeItem(key);
    });
  } catch {
    // Browser privacy modes can deny storage access; session safety must not depend on cleanup succeeding.
  }
}
