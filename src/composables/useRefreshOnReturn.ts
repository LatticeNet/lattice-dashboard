import { onScopeDispose } from "vue";

import { onReferenceChange, returnRefreshDue, type ReferenceKind } from "@/lib/referenceChanges";

/**
 * Reads again when the operator comes back to the page (window focus, or the
 * tab becoming visible) and after this session's own write to an object of
 * one of `kinds` (design 32 S3b). No timer: a view that uses it reads when it
 * opens, when the operator returns, and after their change, never on a poll.
 * `active` says whether the view is showing anything to refresh (a sheet that
 * is closed reads nothing).
 */
export function useRefreshOnReturn(refresh: () => void, options: { kinds?: readonly ReferenceKind[]; active?: () => boolean } = {}): void {
  const active = options.active ?? (() => true);
  let lastAt: number | undefined;

  function onReturn(): void {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (!active()) return;
    const now = Date.now();
    if (!returnRefreshDue(lastAt, now)) return;
    lastAt = now;
    refresh();
  }

  if (typeof window !== "undefined") {
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
  }
  const kinds = new Set(options.kinds ?? []);
  const stop = kinds.size
    ? onReferenceChange((kind) => {
        if (kinds.has(kind) && active()) refresh();
      })
    : undefined;

  onScopeDispose(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    }
    stop?.();
  });
}
