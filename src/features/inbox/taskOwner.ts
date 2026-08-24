export function formatTaskOwner(ownerId: string | null | undefined): string {
  return ownerId && ownerId !== "unassigned" ? ownerId : "未分配";
}
