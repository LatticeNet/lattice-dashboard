import { isDemoObject } from "@/lib/demo";

/**
 * Go's `omitempty` does not drop a zero time.Time, so a routing that was never
 * applied arrives as "0001-01-01T00:00:00Z" and formats into a real-looking
 * year-1 date instead of falling through to "never".
 */
export function hasRealTime(value?: string | null): boolean {
  return !!value && !value.startsWith("0001");
}

export type GeoDeleteLine =
  | { kind: "record"; hostname: string }
  | { kind: "nothingSent" }
  | { kind: "answering"; nodeId: string; hostname: string; appliedAt: string }
  | { kind: "answeringUnknown"; hostname: string; appliedAt: string }
  | { kind: "noRemoval" };

export interface GeoDeleteImpact {
  /** The routing was applied to its DNS nodes: its zone stays on them after the delete. */
  applied: boolean;
  /** The operator types the routing's name before Delete enables. */
  typed: boolean;
  lines: GeoDeleteLine[];
}

interface RoutingLike {
  name?: string;
  hostname: string;
  last_applied_at?: string | null;
  dns_node_ids?: string[] | null;
}

/**
 * Which destructive class a geo routing delete belongs to (design 23, 3.8).
 *
 * The server's delete removes only the record (handleDeleteGeoRouting). A
 * routing that was never applied, and the demo preview, live only on this
 * server: irreversible inside Lattice, nothing reaches a node. One that was
 * applied left its zone in the CoreDNS on its DNS nodes, so each of them keeps
 * answering the hostname: the class that leaves config on a node, which
 * names every node and asks for the typed name.
 */
export function geoDeleteImpact(route: RoutingLike): GeoDeleteImpact {
  const applied = !isDemoObject(route.name) && hasRealTime(route.last_applied_at);
  if (!applied) {
    return { applied, typed: false, lines: [{ kind: "record", hostname: route.hostname }, { kind: "nothingSent" }] };
  }
  const appliedAt = route.last_applied_at as string;
  const nodes = route.dns_node_ids ?? [];
  const lines: GeoDeleteLine[] = nodes.length
    ? nodes.map((nodeId) => ({ kind: "answering", nodeId, hostname: route.hostname, appliedAt }))
    : [{ kind: "answeringUnknown", hostname: route.hostname, appliedAt }];
  lines.push({ kind: "noRemoval" });
  return { applied, typed: true, lines };
}
