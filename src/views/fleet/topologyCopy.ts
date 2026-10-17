/**
 * How the Topology layer words an edge, a node and a sample, shared by the
 * graph and the list so the two never say different things about one path.
 * The caller passes its `t` and locale; nothing here holds Vue state.
 */
import { formatAge } from "@/lib/format";

import { formatLoss, formatMs } from "@/views/fleet/latencyModel";
import type { ProbeState, RowSummary, TopoEdge, TopoLastSample, TopoNode } from "@/views/fleet/topologyModel";

type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string;

export interface EdgeValue {
  text: string;
  /** Tailwind text class. */
  tone: string;
  /** Loss worth printing beside the value, already formatted. */
  loss?: string;
}

export function stateLabel(t: Translate, edge: Pick<TopoEdge, "kind" | "state">): string {
  // A check fails; a probe path is unreachable.
  if (edge.kind === "check" && edge.state === "failing") return t("fleet.monitoring.topology.state.checkFailing");
  return t(`fleet.monitoring.topology.state.${edge.state}`);
}

/** A probe state's ink: the state tones only (design 29 D13), so a p50 is never coloured by how fast it is. */
export const PROBE_INK: Record<ProbeState, string> = {
  up: "text-foreground",
  degraded: "text-warning-text",
  down: "text-destructive",
  unknown: "text-muted-foreground",
  paused: "text-muted-foreground",
};

/** A probe state's mark on a target row: one per drawn source. */
export const PROBE_MARK: Record<ProbeState, string> = {
  up: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "border border-muted-foreground bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_3px)]",
  paused: "bg-muted-foreground/40",
};

/** The short value a row or a list line prints for one edge. */
export function edgeValue(t: Translate, edge: TopoEdge): EdgeValue {
  const lossy = edge.loss !== undefined && edge.loss > 0 ? formatLoss(edge.loss) : undefined;
  if (edge.kind === "probe") {
    const state = edge.state as ProbeState;
    switch (state) {
      case "up":
      case "degraded":
        return { text: edge.p50Ms !== undefined ? formatMs(edge.p50Ms) : stateLabel(t, edge), tone: PROBE_INK[state], loss: lossy };
      case "down":
        return { text: t("fleet.monitoring.topology.value.down"), tone: PROBE_INK.down };
      case "paused":
        return { text: t("fleet.monitoring.topology.value.paused"), tone: PROBE_INK.paused };
      default:
        return { text: t("fleet.monitoring.topology.value.unknown"), tone: PROBE_INK.unknown };
    }
  }
  if (edge.kind === "chain") {
    const tone = edge.state === "failed" ? "text-destructive" : edge.state === "drifted" ? "text-warning-text" : edge.state === "converged" ? "text-foreground" : "text-info-text";
    return { text: stateLabel(t, edge), tone };
  }
  switch (edge.state) {
    case "up":
      return { text: edge.last?.ms !== undefined ? formatMs(edge.last.ms) : stateLabel(t, edge), tone: "text-foreground" };
    case "failing":
      return { text: stateLabel(t, edge), tone: "text-destructive" };
    default:
      return { text: stateLabel(t, edge), tone: "text-muted-foreground" };
  }
}

/**
 * A target row's value with several sources drawn: "down from 1 of 4",
 * "degraded from 2 of 4", "up from all 4", in the speaking state's ink. With
 * no live path the row says the state alone ("unknown", "paused").
 */
export function rowSummaryValue(t: Translate, summary: RowSummary): EdgeValue {
  const { state, n, of } = summary;
  const tone = PROBE_INK[state];
  switch (state) {
    case "down":
    case "degraded":
      return { text: t(`fleet.monitoring.topology.value.summary.${state}`, { n, of }), tone };
    case "up":
      return { text: n === of ? t("fleet.monitoring.topology.value.summary.upAll", { of }) : t("fleet.monitoring.topology.value.summary.up", { n, of }), tone };
    default:
      return { text: t(`fleet.monitoring.topology.value.${state}`), tone };
  }
}

/** "25s ago, 162 ms", "6d ago, failed", or "none yet". */
export function lastSampleText(t: Translate, locale: string, last: TopoLastSample | undefined, now: number): string {
  if (!last) return t("fleet.monitoring.topology.card.lastNone");
  const age = formatAge(now - last.at, locale);
  // A probe path says when it last heard, not how that run went.
  if (last.ok === undefined) return t("fleet.monitoring.topology.card.lastHeard", { age });
  if (!last.ok) return t("fleet.monitoring.topology.card.lastFail", { age });
  if (last.ms === undefined) return t("fleet.monitoring.topology.card.lastOkNoValue", { age });
  return t("fleet.monitoring.topology.card.lastOk", { age, value: formatMs(last.ms) });
}

/** The heartbeat in words: "beating", "quiet for 6d", "never reported". */
export function freshnessText(t: Translate, locale: string, node: TopoNode, now: number): string {
  switch (node.freshness) {
    case "fresh":
      return t("fleet.monitoring.topology.freshness.fresh");
    case "degraded":
      return t("fleet.monitoring.topology.freshness.degraded");
    case "quiet":
      return t("fleet.monitoring.topology.freshness.quiet", { age: node.lastSeenAt ? formatAge(now - node.lastSeenAt, locale) : "?" });
    case "never":
      return t("fleet.monitoring.topology.freshness.never");
    case "disabled":
      return t("fleet.monitoring.topology.freshness.disabled");
    default:
      return "";
  }
}

/** Dot colour for a node's heartbeat. */
export function freshnessDot(node: Pick<TopoNode, "freshness">): string {
  switch (node.freshness) {
    case "fresh":
      return "bg-success";
    case "degraded":
      return "bg-warning";
    case "quiet":
      return "bg-destructive";
    case "never":
    case "disabled":
      return "border border-muted-foreground bg-transparent";
    default:
      return "border border-dashed border-muted-foreground bg-transparent";
  }
}
