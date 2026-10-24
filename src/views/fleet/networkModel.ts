/**
 * Monitoring's Topology view (design 32 D2): what the graph and list modes
 * share beyond the drawing itself. One query over the matrix's paths serves
 * both modes; the list shows the paths it keeps, grouped by the target's
 * region, worst first unless a column or a `sort:` term orders them.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import { REGION_ORDER, type RegionKey } from "@/lib/regions";
import type { QueryValue } from "@/components/common/tableUrlState";
import { worstFirst } from "@/views/fleet/nodePathsModel";
import { targetLabel, type PathItem } from "@/views/fleet/pathsModel";

/* ------------------------------------------------------------------ */
/* Presentation                                                         */
/* ------------------------------------------------------------------ */

export type Presentation = "graph" | "list";

/** `?as=` read: absent is the screen's default. */
export function parsePresentation(raw: QueryValue | undefined): Presentation | "auto" {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "list" || value === "graph" ? value : "auto";
}

/**
 * The view's width from which both modes have their room. In the graph, with
 * the default four sources drawn and the address terminals, a target's name
 * keeps a one-source row's room beside its summary and marks from a drawing
 * about 1068 px wide (topologyModel's layout; the frame's border and padding
 * make it 1100). The list's table with every figure column wants about the
 * same. Narrower, the view opens in the list and the list groups its rows by
 * target; the graph stays one tap away and scrolls sideways inside its frame.
 */
export const ROOMY_W = 1100;

export function roomy(viewWidth: number): boolean {
  return viewWidth >= ROOMY_W;
}

export interface Screen {
  /** The view itself is ROOMY_W wide (the window less the sidebar and the gutters). */
  roomy: boolean;
  finePointer: boolean;
}

/**
 * The mode a screen opens in: the graph with a mouse in a roomy view, the
 * list in a narrower one, on a phone, or on a touch screen (32 px rows and a
 * 14 px stroke are not touch targets). The other mode is one tap away, the
 * graph on a phone too.
 */
export function defaultPresentation(screen: Screen): Presentation {
  return screen.roomy && screen.finePointer ? "graph" : "list";
}

export function presentation(asked: Presentation | "auto", screen: Screen): Presentation {
  return asked === "auto" ? defaultPresentation(screen) : asked;
}

/** `?as=` written: the screen's default is written as nothing, so the bare address stays bare. */
export function formatPresentation(value: Presentation, screen: Screen): Presentation | "auto" {
  return value === defaultPresentation(screen) ? "auto" : value;
}

/* ------------------------------------------------------------------ */
/* The list                                                             */
/* ------------------------------------------------------------------ */

/** The list's group for a path: its target node's region, or `checks` for a check to an address (they sit last). */
export type ListGroup = RegionKey | "checks";

export function listGroup(path: Pick<PathItem, "targetNode" | "region">): ListGroup {
  return path.targetNode ? path.region : "checks";
}

/** The groups in the order the list shows them: near regions first, checks to addresses last. */
export const LIST_GROUP_ORDER: readonly ListGroup[] = [...REGION_ORDER, "checks"];

/** The list's own order, before a column or a `sort:` term replaces it: worst first (down, degraded, unknown, paused, up). */
export function listOrder(paths: readonly PathItem[]): PathItem[] {
  return [...paths].sort(worstFirst);
}

/** A target with the paths into it, for the phone's grouped list. */
export interface TargetGroup {
  /** The target node, or `@<monitor id>` for a check to an address. */
  key: string;
  name: string;
  /** The country, or the address a check dials. */
  detail: string;
  paths: PathItem[];
}

export interface RegionGroup {
  group: ListGroup;
  targets: TargetGroup[];
  /** Paths in the group. */
  count: number;
}

/**
 * The phone's list: region groups in LIST_GROUP_ORDER, targets in the order
 * their first path arrives (so the list's order, worst first or sorted,
 * decides which target leads), each target's paths in that order too.
 */
export function regionGroups(paths: readonly PathItem[]): RegionGroup[] {
  const groups = new Map<ListGroup, Map<string, TargetGroup>>();
  for (const path of paths) {
    const group = listGroup(path);
    const targets = groups.get(group) ?? new Map<string, TargetGroup>();
    const key = path.targetNode ?? path.rowKey;
    const target = targets.get(key) ?? { key, name: targetLabel(path), detail: path.targetNode ? (path.country ?? "") : path.target, paths: [] };
    target.paths.push(path);
    targets.set(key, target);
    groups.set(group, targets);
  }
  return LIST_GROUP_ORDER.filter((g) => groups.has(g)).map((group) => {
    const targets = [...groups.get(group)!.values()];
    return { group, targets, count: targets.reduce((n, t) => n + t.paths.length, 0) };
  });
}

/**
 * Availability as the list prints it: one decimal, floored, so 99.96% of
 * runs never reads as 100%, and 100% only when every expected run passed.
 */
export function formatAvailability(share: number | undefined): string {
  if (share === undefined || !Number.isFinite(share)) return "";
  if (share >= 1) return "100%";
  return `${(Math.floor(Math.max(0, share) * 1000) / 10).toFixed(1)}%`;
}
