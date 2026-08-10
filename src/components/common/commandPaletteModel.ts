/**
 * Command palette support logic — the pieces that stay framework-free so they
 * can be unit-tested without mounting the palette.
 *
 * `filterPendingSystemApprovals` decides whether the "approve all system
 * events" action exists at all: the server proposes its own plans stamped
 * with the lattice-server actor, and only those are safe to offer as a
 * one-shot batch — anything an operator or another integration wrote still
 * deserves an individual look in the Approvals inbox.
 *
 * `createTtlCache` backs the palette's on-open fetch: opening ⌘K must feel
 * instant, so a fresh result is served for 30s; a failed fetch is never
 * cached, so the next open retries instead of hiding the action on a
 * transient blip.
 */

/** Writer identity the server stamps on plans it proposed itself. */
export const SYSTEM_WRITER = "lattice-server";

export interface SystemApprovalCandidate {
  status: string;
  actor_id?: string;
}

/** Pending items written by the server itself — the palette action's scope. */
export function filterPendingSystemApprovals<T extends SystemApprovalCandidate>(items: readonly T[]): T[] {
  return items.filter((item) => item.status === "pending" && (item.actor_id ?? "").trim() === SYSTEM_WRITER);
}

export interface TtlCache<T> {
  /** Serve the cached value while fresh; otherwise fetch (sharing one
   *  in-flight promise across concurrent callers). */
  load: (fetcher: () => Promise<T>) => Promise<T>;
  /** Drop the cached value — call after a mutation that changes the answer. */
  invalidate: () => void;
}

export function createTtlCache<T>(ttlMs: number, now: () => number = () => Date.now()): TtlCache<T> {
  let cached: { at: number; value: T } | undefined;
  let inflight: Promise<T> | undefined;
  return {
    load(fetcher) {
      if (cached !== undefined && now() - cached.at < ttlMs) {
        return Promise.resolve(cached.value);
      }
      inflight ??= fetcher()
        .then((value) => {
          // Only successes are cached — a rejection propagates and the next
          // load retries instead of serving a remembered failure.
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
