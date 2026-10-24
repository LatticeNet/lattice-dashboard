/**
 * The target selector (design 32 D5): explicit nodes, node groups, the whole
 * fleet, and nodes to leave out. One stored shape for every target field
 * (outbound policy targets now, check sources and targets in S2b, security
 * group bindings later), stored as written and resolved when used.
 *
 * Resolution here mirrors the server's groups.ResolveTargets over what this
 * session can see: the union of the named nodes, the members of the named
 * groups and, with `all`, every node, minus the exclusions; only nodes in the
 * visible fleet count. The server resolves again at plan time, so this is the
 * operator's preview, not the authority.
 *
 * Pure TS, so `node --test` covers it directly.
 */
import type { TargetSelector } from "@/lib/api/types";

export type { TargetSelector };

export interface SelectorNode {
  id: string;
  name?: string;
}

export interface SelectorGroup {
  id: string;
  name: string;
  /** The group's members as the server resolved them for this session. */
  resolved_members: string[];
}

function clean(ids: readonly string[] | undefined): string[] {
  const set = new Set<string>();
  for (const id of ids ?? []) {
    const trimmed = id.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set].sort();
}

/**
 * The stored form of a selector, in the shape the server accepts: ids
 * trimmed, deduplicated and sorted; a whole-fleet selector names no nodes or
 * groups; exclusions only beside a group or the whole fleet, and never a node
 * that is also named as a target; empty fields left out.
 */
export function normalizeSelector(sel: TargetSelector): TargetSelector {
  const all = sel.all === true;
  const groups = all ? [] : clean(sel.groups);
  const nodes = all ? [] : clean(sel.nodes);
  const named = new Set(nodes);
  const exclude = all || groups.length > 0 ? clean(sel.exclude).filter((id) => !named.has(id)) : [];
  const out: TargetSelector = {};
  if (nodes.length) out.nodes = nodes;
  if (groups.length) out.groups = groups;
  if (all) out.all = true;
  if (exclude.length) out.exclude = exclude;
  return out;
}

/** A selector that targets nothing: no node, no group, not the whole fleet. */
export function isEmptySelector(sel: TargetSelector): boolean {
  const n = normalizeSelector(sel);
  return !n.all && !n.nodes?.length && !n.groups?.length;
}

export function selectorEquals(a: TargetSelector, b: TargetSelector): boolean {
  return JSON.stringify(normalizeSelector(a)) === JSON.stringify(normalizeSelector(b));
}

/** How one visible node relates to a selector, for the picker's rows. */
export interface NodeCoverage {
  /** Named as a target on its own. */
  explicit: boolean;
  /** Ids of the named groups that contain it. */
  via: string[];
  /** Covered by the whole-fleet target. */
  fleet: boolean;
  /** Left out. */
  excluded: boolean;
  /** Ends up targeted. */
  targeted: boolean;
}

export function nodeCoverage(sel: TargetSelector, nodeId: string, groups: readonly SelectorGroup[]): NodeCoverage {
  const n = normalizeSelector(sel);
  const explicit = (n.nodes ?? []).includes(nodeId);
  const via = groups.filter((g) => (n.groups ?? []).includes(g.id) && g.resolved_members.includes(nodeId)).map((g) => g.id);
  const fleet = n.all === true;
  const excluded = (n.exclude ?? []).includes(nodeId);
  return { explicit, via, fleet, excluded, targeted: (explicit || via.length > 0 || fleet) && !excluded };
}

/**
 * Coverage for every visible node at once, for a list that renders them all:
 * the selector is normalized once and each named group's members become a
 * Set, so a fleet of thousands of nodes and large groups stays linear per
 * render instead of normalizing and scanning member arrays per node.
 */
export function coverageMap(
  sel: TargetSelector,
  nodes: readonly SelectorNode[],
  groups: readonly SelectorGroup[],
): Map<string, NodeCoverage> {
  const n = normalizeSelector(sel);
  const named = new Set(n.nodes ?? []);
  const excluded = new Set(n.exclude ?? []);
  const fleet = n.all === true;
  const chosen = (n.groups ?? [])
    .map((id) => groups.find((g) => g.id === id))
    .filter((g): g is SelectorGroup => !!g)
    .map((g) => ({ id: g.id, members: new Set(g.resolved_members) }));
  const out = new Map<string, NodeCoverage>();
  for (const node of nodes) {
    const explicit = named.has(node.id);
    const via = chosen.filter((g) => g.members.has(node.id)).map((g) => g.id);
    const left = excluded.has(node.id);
    out.set(node.id, { explicit, via, fleet, excluded: left, targeted: (explicit || via.length > 0 || fleet) && !left });
  }
  return out;
}

/** What the picker's search matches a node on: its name, id and country. */
export function nodeSearchText(node: SelectorNode & { geo?: { country?: string } }): string {
  return `${node.name ?? ""} ${node.id} ${node.geo?.country ?? ""}`.toLowerCase();
}

/**
 * The one group or node a search names, when exactly one matches; Enter in
 * the search box picks it. Several matches or none pick nothing, so Enter
 * never guesses.
 */
export function onlyMatch(
  query: string,
  nodes: readonly (SelectorNode & { geo?: { country?: string } })[],
  groups: readonly SelectorGroup[],
  allowGroups: boolean,
): { kind: "group" | "node"; id: string } | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const groupHits = allowGroups ? groups.filter((g) => g.name.toLowerCase().includes(q)) : [];
  const nodeHits = nodes.filter((n) => nodeSearchText(n).includes(q));
  if (groupHits.length + nodeHits.length !== 1) return undefined;
  const group = groupHits[0];
  if (group) return { kind: "group", id: group.id };
  const node = nodeHits[0];
  return node ? { kind: "node", id: node.id } : undefined;
}

/** The visible nodes a selector resolves to, sorted by id. */
export function resolveSelector(
  sel: TargetSelector,
  nodes: readonly SelectorNode[],
  groups: readonly SelectorGroup[],
): string[] {
  const n = normalizeSelector(sel);
  const visible = new Set(nodes.map((node) => node.id));
  const out = new Set<string>();
  if (n.all) for (const id of visible) out.add(id);
  for (const id of n.nodes ?? []) if (visible.has(id)) out.add(id);
  for (const groupId of n.groups ?? []) {
    const group = groups.find((g) => g.id === groupId);
    for (const id of group?.resolved_members ?? []) if (visible.has(id)) out.add(id);
  }
  for (const id of n.exclude ?? []) out.delete(id);
  return [...out].sort();
}

/** Name a node explicitly, or stop naming it. Naming a node takes it out of the exclusions. */
export function toggleNode(sel: TargetSelector, nodeId: string, on: boolean): TargetSelector {
  const n = normalizeSelector(sel);
  const nodes = new Set(n.nodes ?? []);
  const exclude = new Set(n.exclude ?? []);
  if (on) {
    nodes.add(nodeId);
    exclude.delete(nodeId);
  } else {
    nodes.delete(nodeId);
  }
  return normalizeSelector({ ...n, nodes: [...nodes], exclude: [...exclude] });
}

/**
 * Name a group, or stop naming it. Dropping the last group drops the
 * exclusions that stood beside it (they mean nothing without a group or the
 * whole fleet, and the server refuses them); naming a group again does not
 * bring them back.
 */
export function toggleGroup(sel: TargetSelector, groupId: string, on: boolean): TargetSelector {
  const n = normalizeSelector(sel);
  const groups = new Set(n.groups ?? []);
  if (on) groups.add(groupId);
  else groups.delete(groupId);
  return normalizeSelector({ ...n, groups: [...groups] });
}

/** Leave a node out, or bring it back. Leaving a node out stops naming it. */
export function toggleExclude(sel: TargetSelector, nodeId: string, on: boolean): TargetSelector {
  const n = normalizeSelector(sel);
  const exclude = new Set(n.exclude ?? []);
  const nodes = new Set(n.nodes ?? []);
  if (on) {
    exclude.add(nodeId);
    nodes.delete(nodeId);
  } else {
    exclude.delete(nodeId);
  }
  return normalizeSelector({ ...n, nodes: [...nodes], exclude: [...exclude] });
}

/**
 * Turn the whole-fleet target on or off. Turning it on drops the named nodes
 * and groups from the stored selector (the server refuses both together);
 * `restore` is what to name again when it goes off, so a quick toggle does
 * not lose the operator's picks.
 */
export function setWholeFleet(sel: TargetSelector, on: boolean, restore: TargetSelector = {}): TargetSelector {
  const n = normalizeSelector(sel);
  if (on) return normalizeSelector({ all: true, exclude: n.exclude });
  const back = normalizeSelector(restore);
  return normalizeSelector({ nodes: back.nodes, groups: back.groups, exclude: n.exclude });
}

/** One summary item for the chips row and the labels that name a target. */
export type SelectorPart =
  | { kind: "fleet" }
  | { kind: "group"; id: string; name: string }
  | { kind: "node"; id: string; name: string }
  | { kind: "exclude"; id: string; name: string };

/** The selector as chips, in reading order: the fleet or groups, then nodes, then exclusions. */
export function selectorParts(
  sel: TargetSelector,
  nodes: readonly SelectorNode[],
  groups: readonly SelectorGroup[],
): SelectorPart[] {
  const n = normalizeSelector(sel);
  const nodeName = (id: string) => nodes.find((node) => node.id === id)?.name || id;
  const parts: SelectorPart[] = [];
  if (n.all) parts.push({ kind: "fleet" });
  for (const id of n.groups ?? []) parts.push({ kind: "group", id, name: groups.find((g) => g.id === id)?.name ?? id });
  for (const id of n.nodes ?? []) parts.push({ kind: "node", id, name: nodeName(id) });
  for (const id of n.exclude ?? []) parts.push({ kind: "exclude", id, name: nodeName(id) });
  return parts;
}
