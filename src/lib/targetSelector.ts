/**
 * The target selector (design 32 D5): one stored shape for every target
 * field, `{ nodes, groups, all, exclude }`. A node is chosen when `all` is
 * set, when `nodes` names it, or when it is a member of a group `groups`
 * names; `exclude` wins over all of them. The server resolves it every time
 * it is used (lattice-server internal/groups ResolveTargets); this mirror
 * serves the live "resolves to N nodes" line, over the group memberships the
 * server resolved for this session (GroupView.resolved_members).
 *
 * Pure: no Vue, no i18n.
 */
import type { TargetSelector } from "@/lib/api/types";

export interface SelectorGroup {
  id: string;
  resolved_members?: readonly string[];
}

/** Why a node is in a selector's set. */
export type SelectorCover = { by: "all" } | { by: "node" } | { by: "group"; groupId: string };

function sortedUnique(list: readonly string[] | undefined): string[] {
  return [...new Set((list ?? []).map((v) => v.trim()).filter(Boolean))].sort();
}

/** The selector as the server stores it: lists trimmed, deduplicated and sorted, empty ones and a false `all` dropped. */
export function normalizeSelector(sel: TargetSelector | undefined): TargetSelector {
  const out: TargetSelector = {};
  const nodes = sortedUnique(sel?.nodes);
  const groups = sortedUnique(sel?.groups);
  const exclude = sortedUnique(sel?.exclude);
  if (nodes.length) out.nodes = nodes;
  if (groups.length) out.groups = groups;
  if (sel?.all) out.all = true;
  if (exclude.length) out.exclude = exclude;
  return out;
}

/** Nothing chosen: no node, no group and not the whole fleet. Exclusions alone choose nothing. */
export function selectorIsEmpty(sel: TargetSelector | undefined): boolean {
  return !sel?.all && !(sel?.nodes ?? []).length && !(sel?.groups ?? []).length;
}

/** The selector grows with the fleet: it names a group or the whole fleet. */
export function selectorIsBroad(sel: TargetSelector | undefined): boolean {
  return !!sel?.all || (sel?.groups ?? []).length > 0;
}

export function selectorsEqual(a: TargetSelector | undefined, b: TargetSelector | undefined): boolean {
  return JSON.stringify(normalizeSelector(a)) === JSON.stringify(normalizeSelector(b));
}

/**
 * The node ids a selector chooses, sorted, among `nodes`: an id with no node
 * and a group this session does not know choose nothing, as on the server.
 */
export function resolveTargetSelector(sel: TargetSelector | undefined, nodes: readonly { id: string }[], groups: readonly SelectorGroup[]): string[] {
  const exists = new Set(nodes.map((n) => n.id));
  const picked = new Set<string>();
  if (sel?.all) for (const id of exists) picked.add(id);
  for (const id of sel?.nodes ?? []) if (exists.has(id)) picked.add(id);
  const named = new Set(sel?.groups ?? []);
  for (const g of groups) {
    if (!named.has(g.id)) continue;
    for (const id of g.resolved_members ?? []) if (exists.has(id)) picked.add(id);
  }
  for (const id of sel?.exclude ?? []) picked.delete(id);
  return [...picked].sort();
}

/**
 * Why a node is chosen before exclusions: named, the whole fleet, or a
 * group (the first named group that holds it). Undefined when nothing
 * covers it.
 */
export function selectorCover(sel: TargetSelector | undefined, nodeId: string, groups: readonly SelectorGroup[]): SelectorCover | undefined {
  if ((sel?.nodes ?? []).includes(nodeId)) return { by: "node" };
  for (const groupId of sel?.groups ?? []) {
    if (groups.find((g) => g.id === groupId)?.resolved_members?.includes(nodeId)) return { by: "group", groupId };
  }
  if (sel?.all) return { by: "all" };
  return undefined;
}

/** Turn one node on or off. A node a group or the whole fleet covers is turned off by excluding it, and on again by dropping the exclusion. */
export function toggleSelectorNode(sel: TargetSelector, nodeId: string, on: boolean, groups: readonly SelectorGroup[]): TargetSelector {
  const nodes = new Set(sel.nodes ?? []);
  const exclude = new Set(sel.exclude ?? []);
  if (on) {
    exclude.delete(nodeId);
    const covered = selectorCover({ ...sel, nodes: [] }, nodeId, groups);
    if (!covered) nodes.add(nodeId);
  } else {
    nodes.delete(nodeId);
    if (selectorCover({ ...sel, nodes: [] }, nodeId, groups)) exclude.add(nodeId);
  }
  return normalizeSelector({ ...sel, nodes: [...nodes], exclude: [...exclude] });
}

/** Turn one group on or off; exclusions no remaining criterion covers are dropped with it. */
export function toggleSelectorGroup(sel: TargetSelector, groupId: string, on: boolean, groups: readonly SelectorGroup[]): TargetSelector {
  const named = new Set(sel.groups ?? []);
  if (on) named.add(groupId);
  else named.delete(groupId);
  return pruneExclusions(normalizeSelector({ ...sel, groups: [...named] }), groups);
}

/** The whole fleet on or off; exclusions nothing covers any more are dropped. */
export function setSelectorAll(sel: TargetSelector, all: boolean, groups: readonly SelectorGroup[]): TargetSelector {
  return pruneExclusions(normalizeSelector({ ...sel, all }), groups);
}

function pruneExclusions(sel: TargetSelector, groups: readonly SelectorGroup[]): TargetSelector {
  const kept = (sel.exclude ?? []).filter((id) => selectorCover({ ...sel, nodes: [] }, id, groups) !== undefined);
  return normalizeSelector({ ...sel, exclude: kept });
}
