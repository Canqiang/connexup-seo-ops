export function hasPermission(permissions: string[] | undefined, code: string): boolean {
  if (!permissions) return false;
  if (permissions.includes("*") || permissions.includes(code)) return true;
  if (code.endsWith(".view")) {
    return permissions.includes(`${code.slice(0, -5)}.manage`);
  }
  return false;
}
