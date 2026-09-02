/**
 * Stand-in for `@/views/networking/sshGuardReality`, aliased in by
 * vite.harness.config.ts. Serves the fixture's snapshots in two pages so the
 * cursor path is exercised, and the per-node detail with the listeners.
 */
import type { GuardRealityDetailResponse, GuardRealityListResponse } from "@/lib/api/index";

import { state } from "./fixtureState";

const LATENCY_MS = 180;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

export const guardReality = {
  list: (options?: { limit?: number; cursor?: string }): Promise<GuardRealityListResponse> => {
    const sorted = [...state.summaries].sort((a, b) => (a.node_id < b.node_id ? -1 : 1));
    const start = options?.cursor ? sorted.findIndex((s) => s.node_id === options.cursor) + 1 : 0;
    const page = sorted.slice(start, start + 20);
    const last = page[page.length - 1];
    const next_cursor = start + 20 < sorted.length && last ? last.node_id : undefined;
    return delay({ nodes: page, next_cursor });
  },
  detail: (node_id: string): Promise<GuardRealityDetailResponse> => {
    const reality = state.details.get(node_id) ?? null;
    const summary = state.summaries.find((s) => s.node_id === node_id);
    return delay({
      node: {
        node_id,
        snapshot_status: summary?.snapshot_status ?? "unknown",
        reality,
        received_at: summary?.received_at ?? null,
        stale_after: summary?.stale_after ?? null,
      },
    });
  },
};
