/**
 * SSH Guard's read of the guard-reality feed.
 *
 * What each node last reported about its own listeners and firewall. The
 * agent posts it, the server keeps the newest snapshot per node and serves it
 * at /api/netguard/reality in two shapes: a fleet summary (timestamps and
 * counts, one call, paged by cursor and capped at 500 rows) and a per-node
 * detail carrying the listeners themselves. SSH Guard reads both as evidence:
 * the summary says when a node was observed, the detail says what sshd is
 * bound to right now. Both need `netguard:read`.
 *
 * This lives beside the view rather than in the API barrel on purpose. The
 * plugin isolation audit (pluginIsolation.test.ts) keeps NetGuard REST paths
 * out of the host's shared client so the host never grows a native copy of
 * the plugin's surface. This is not that: it is one host page reading one
 * evidence endpoint the design names for it. Keeping it here keeps the audit
 * meaningful and keeps the dependency visible from the page that has it.
 */
import { http, type RequestOptions } from "@/lib/api/client";
import type { GuardRealityDetailResponse, GuardRealityListResponse } from "@/lib/api/types";

export const guardReality = {
  list: (options?: { limit?: number; cursor?: string }, opts?: RequestOptions) =>
    http.get<GuardRealityListResponse>("/api/netguard/reality", options, opts),
  detail: (node_id: string, opts?: RequestOptions) =>
    http.get<GuardRealityDetailResponse>(
      `/api/netguard/reality?node_id=${encodeURIComponent(node_id)}`,
      undefined,
      opts,
    ),
};
