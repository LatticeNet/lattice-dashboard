/**
 * How the Topology layer words an edge, a node and a sample, shared by the
 * graph and the list so the two never say different things about one path.
 * The caller passes its `t` and locale; nothing here holds Vue state.
 */
import { formatAge } from "@/lib/format";

import { BAND_STYLE, coveragePercent, formatLoss, formatMs } from "./latencyModel";
import type { TopoEdge, TopoLastSample, TopoNode } from "./topologyModel";

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

/** The short value a row or a list line prints for one edge. */
export function edgeValue(t: Translate, edge: TopoEdge): EdgeValue {
  const lossy = edge.loss !== undefined && edge.loss > 0 ? formatLoss(edge.loss) : undefined;
  if (edge.kind === "probe") {
    switch (edge.state) {
      case "measured":
        return { text: formatMs(edge.p50Ms), tone: BAND_STYLE[edge.band ?? "destructive"].text, loss: lossy };
      case "lossy":
        return { text: formatMs(edge.p50Ms), tone: BAND_STYLE[edge.band ?? "destructive"].text, loss: lossy };
      case "failing":
        return { text: t("fleet.monitoring.topology.value.failing"), tone: "text-destructive" };
      case "quiet":
        return { text: edge.p50Ms !== undefined ? formatMs(edge.p50Ms) : t("fleet.monitoring.topology.value.quiet"), tone: "text-muted-foreground" };
      case "paused":
        return { text: t("fleet.monitoring.topology.value.paused"), tone: "text-muted-foreground" };
      default:
        return { text: t("fleet.monitoring.topology.value.unknown"), tone: "text-muted-foreground" };
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

/** "25s ago, 162 ms", "6d ago, failed", or "none yet". */
export function lastSampleText(t: Translate, locale: string, last: TopoLastSample | undefined, now: number): string {
  if (!last) return t("fleet.monitoring.topology.card.lastNone");
  const age = formatAge(now - last.at, locale);
  if (!last.ok) return t("fleet.monitoring.topology.card.lastFail", { age });
  if (last.ms === undefined) return t("fleet.monitoring.topology.card.lastOkNoValue", { age });
  return t("fleet.monitoring.topology.card.lastOk", { age, value: formatMs(last.ms) });
}

/** Why a quiet probe is quiet, in words. */
export function quietText(t: Translate, locale: string, edge: TopoEdge, now: number): string {
  if (edge.quietReason === "source") return t("fleet.monitoring.topology.quiet.source");
  const age = edge.last ? formatAge(now - edge.last.at, locale) : "";
  return t("fleet.monitoring.topology.quiet.old", { age });
}

export function partialText(t: Translate, edge: TopoEdge): string | undefined {
  if (!edge.partial || edge.coverage === undefined) return undefined;
  return t("fleet.monitoring.topology.card.partial", { pct: coveragePercent(edge.coverage) });
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
