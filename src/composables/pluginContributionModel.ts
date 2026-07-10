/** Remove a lifecycle-confirmed inactive plugin without mutating last-good data. */
export function withoutPlugin<T extends { id: string }>(plugins: readonly T[], pluginId: string): T[] {
  return plugins.filter((plugin) => plugin.id !== pluginId);
}

/** Monotonic guard that lets callers ignore responses from superseded requests. */
export function createLatestRequestEpoch() {
  let current = 0;
  return {
    next: () => ++current,
    invalidate: () => ++current,
    isCurrent: (epoch: number) => epoch === current,
  };
}

/** Stable identity for data that is already filtered to one authorization set. */
export function pluginCacheIdentity(
  actorId: string | undefined,
  scopes: readonly string[],
  serverAllowlist: readonly string[],
): string {
  return JSON.stringify([
    actorId ?? "anonymous",
    [...scopes].sort(),
    [...serverAllowlist].sort(),
  ]);
}
