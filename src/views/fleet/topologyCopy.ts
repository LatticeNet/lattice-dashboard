/**
 * How the Network view's graph words an edge, a node and a sample, so the
 * drawing, its card and an edge's keyboard label never say different things
 * about one path. The caller passes its `t` and locale; nothing here holds
 * Vue state.
 *
 * One vocabulary (design 32 D1): a path is up, degraded, down, paused or
 * unknown, and unknown always says why.
 */
import { formatAge } from "@/lib/format";

import { formatLoss, formatMs } from "@/views/fleet/latencyModel";
import { reasonCode } from "@/views/fleet/pathsModel";
import type { EdgePathState, RowSummary, TopoAddress, TopoEdge, TopoLastSample, TopoNode } from "@/views/fleet/topologyModel";

type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string;

export interface EdgeValue {
  text: string;
  /** Tailwind text class. */
  tone: string;
  /** Loss worth printing beside the value, already formatted. */
  loss?: string;
}

/** Why a path is unknown, in a few words: the reason's short form, the code as sent, or "no reason given". */
export function reasonWords(t: Translate, reason: string | undefined): string {
  const code = reasonCode(reason);
  if (code) return t(`fleet.monitoring.paths.reasonShort.${code}`);
  return reason || t("fleet.monitoring.paths.reasonShort.unspecified");
}

/** The state in words; unknown carries its reason ("unknown: agent offline"). */
export function stateLabel(t: Translate, edge: Pick<TopoEdge, "kind" | "state" | "reason">): string {
  if (edge.kind === "path" && edge.state === "unknown") return t("fleet.monitoring.paths.state.unknownWhy", { reason: reasonWords(t, edge.reason) });
  if (edge.kind === "path") return t(`fleet.monitoring.paths.state.${edge.state}`);
  return t(`fleet.monitoring.topology.state.${edge.state}`);
}

/** A path state's ink: the state tones only (design 29 D13), so a p50 is never coloured by how fast it is. */
export const PATH_INK: Record<EdgePathState, string> = {
  up: "text-foreground",
  degraded: "text-warning-text",
  down: "text-destructive",
  unknown: "text-muted-foreground",
  paused: "text-muted-foreground",
};

/** A path state's mark on a target row: one per drawn source. */
export const PATH_MARK: Record<EdgePathState, string> = {
  up: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "border border-muted-foreground bg-[repeating-linear-gradient(135deg,var(--border)_0_1px,transparent_1px_3px)]",
  paused: "bg-muted-foreground/40",
};

/** The short value a row or a card line prints for one edge: p50 when measured, else the state in words. */
export function edgeValue(t: Translate, edge: TopoEdge): EdgeValue {
  const lossy = edge.loss !== undefined && edge.loss > 0 ? formatLoss(edge.loss) : undefined;
  if (edge.kind === "path") {
    const state = edge.state as EdgePathState;
    switch (state) {
      case "up":
      case "degraded":
        return { text: edge.p50Ms !== undefined ? formatMs(edge.p50Ms) : stateLabel(t, edge), tone: PATH_INK[state], loss: lossy };
      default:
        return { text: stateLabel(t, edge), tone: PATH_INK[state] };
    }
  }
  const tone = edge.state === "failed" ? "text-destructive" : edge.state === "drifted" ? "text-warning-text" : edge.state === "converged" ? "text-foreground" : "text-info-text";
  return { text: stateLabel(t, edge), tone };
}

/**
 * A target row's value with several sources drawn: "down from 1 of 4",
 * "degraded from 2 of 4", "up from 3 of 4", and "down from all 4" (likewise
 * every state) when every drawn source reads it, in the speaking state's
 * ink. Unknown says why, from the path that speaks for the row.
 */
export function rowSummaryValue(t: Translate, summary: RowSummary): EdgeValue {
  const { state, n, of } = summary;
  const all = n === of ? "All" : "";
  return { text: t(`fleet.monitoring.topology.value.summary.${state}${all}`, { n, of, reason: reasonWords(t, summary.reason) }), tone: PATH_INK[state] };
}

/**
 * An address terminal's line: down on N of M in red, degraded on N of M in
 * amber, else how many of its paths are up, muted. Amber means degraded
 * wherever a path state is shown (D13), so paths that are only unknown or
 * paused beside the passing ones keep the muted ink.
 */
export function addressLineValue(t: Translate, address: Pick<TopoAddress, "counts">): EdgeValue {
  const c = address.counts;
  if (c.down > 0) return { text: t("fleet.monitoring.topology.address.down", { n: c.down, total: c.paths }), tone: "text-destructive" };
  if (c.degraded > 0) return { text: t("fleet.monitoring.topology.address.degraded", { n: c.degraded, total: c.paths }), tone: "text-warning-text" };
  return { text: t("fleet.monitoring.topology.address.up", { up: c.up, total: c.paths }), tone: "text-muted-foreground" };
}

/** "25s ago", "6d ago, failed", or "none yet". */
export function lastSampleText(t: Translate, locale: string, last: TopoLastSample | undefined, now: number): string {
  if (!last) return t("fleet.monitoring.topology.card.lastNone");
  const age = formatAge(now - last.at, locale);
  // A path says when it last heard; only a down one's newest outcome is known.
  if (last.ok === false) return t("fleet.monitoring.topology.card.lastFail", { age });
  return t("fleet.monitoring.topology.card.lastHeard", { age });
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
