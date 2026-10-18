/**
 * Pure model for the Mirrors layer of Agent updates (design 31, D4 and S5):
 * the registry of download mirrors, the order of sources each node would
 * download from, and the agent.mirrors plan that changes the registry. Kept
 * free of Vue and i18n so `node --test` covers it directly.
 *
 * Everything here reads what lattice-server sends (model/agent_mirrors.go in
 * lattice-sdk). The order is the server's; the console groups it, never
 * computes it. The draft checks are a subset of the server's
 * validateAgentMirror, so a form can say what is commonly wrong before a
 * round trip; the server stays the authority, and its 400 message is shown
 * as it came.
 */
import type { AgentMirror, AgentMirrorHealth, AgentMirrorOrder, AgentMirrorOrderChange, AgentMirrorPlan } from "@/lib/api/types";

/** The approval plugin and action of a registry change. */
export const AGENT_MIRRORS_PLUGIN = "agent.mirrors";

/** lattice-server's limits (server_agent_mirrors.go). */
export const MAX_AGENT_MIRRORS = 16;
export const MAX_MIRROR_PREFER_FOR = 64;
export const MAX_MIRROR_PRIORITY = 1_000_000;
export const MAX_MIRROR_NAME_CHARS = 80;

const MIRROR_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MIRROR_PATH_RE = /^(\/[A-Za-z0-9._~+-]+)*\/?$/;

// ── source labels ────────────────────────────────────────────────────────────

export type SourceKind = "mirror" | "controlPlane" | "upstream" | "other";

export interface SourceLabel {
  kind: SourceKind;
  /** The registry id of a mirror source. */
  mirror?: string;
  /** The label as the server wrote it, without a trailing "*". */
  raw: string;
  /** The stale reason marks an entry that changed in place with "*". */
  changed: boolean;
}

/**
 * Read one order label: "mirror:<id>", "control-plane" or "upstream". The
 * stale reason of an agent update ends an entry that changed in place (same
 * label, new URL or reason) with "*". Any other label is kept as it came.
 */
export function parseSourceLabel(label: string): SourceLabel {
  let raw = label.trim();
  const changed = raw.endsWith("*");
  if (changed) raw = raw.slice(0, -1);
  if (raw.startsWith("mirror:") && raw.length > "mirror:".length) return { kind: "mirror", mirror: raw.slice("mirror:".length), raw, changed };
  if (raw === "control-plane") return { kind: "controlPlane", raw, changed };
  if (raw === "upstream") return { kind: "upstream", raw, changed };
  return { kind: "other", raw, changed };
}

/** A stale reason's sources value: comma-joined labels; empty means none. */
export function parseSourceList(value: string): SourceLabel[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseSourceLabel);
}

// ── the order preview ────────────────────────────────────────────────────────

export interface OrderNode {
  id: string;
  name: string;
}

/** Nodes whose source order is identical, shown as one row. */
export interface OrderGroup {
  key: string;
  sources: string[];
  nodes: OrderNode[];
}

const byName = (a: OrderNode, b: OrderNode) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * One group per distinct order, the largest first and then by the order
 * itself, so a fleet of a hundred nodes on three mirrors reads as a handful
 * of rows. Nodes inside a group are by name.
 */
export function groupOrders(order: readonly AgentMirrorOrder[]): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();
  for (const entry of order) {
    const sources = entry.sources ?? [];
    const key = sources.join(" ");
    let group = groups.get(key);
    if (!group) {
      group = { key, sources: [...sources], nodes: [] };
      groups.set(key, group);
    }
    group.nodes.push({ id: entry.node_id, name: entry.name || entry.node_id });
  }
  const out = [...groups.values()];
  for (const group of out) group.nodes.sort(byName);
  return out.sort((a, b) => b.nodes.length - a.nodes.length || a.key.localeCompare(b.key));
}

/**
 * The filter over the order. A row whose order lists a mirror whose id or
 * registry name contains the text is kept whole ("which nodes use
 * Cloudflare R2"); otherwise a row is kept with only the nodes whose name or
 * id contains it. Blank text keeps every row whole.
 */
export function filterOrderGroups(groups: readonly OrderGroup[], text: string, mirrorNames: ReadonlyMap<string, string> = new Map()): OrderGroup[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [...groups];
  const out: OrderGroup[] = [];
  for (const group of groups) {
    const viaMirror = group.sources.some((label) => {
      const source = parseSourceLabel(label);
      if (source.kind !== "mirror" || !source.mirror) return false;
      return source.mirror.toLowerCase().includes(needle) || (mirrorNames.get(source.mirror) ?? "").toLowerCase().includes(needle);
    });
    if (viaMirror) {
      out.push({ ...group, nodes: [...group.nodes] });
      continue;
    }
    const nodes = group.nodes.filter((node) => node.name.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle));
    if (nodes.length) out.push({ ...group, nodes });
  }
  return out;
}

/** How many nodes list this mirror in their order. */
export function mirrorReach(order: readonly AgentMirrorOrder[], mirrorId: string): number {
  const label = `mirror:${mirrorId}`;
  return order.filter((entry) => (entry.sources ?? []).includes(label)).length;
}

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Where an entry applies. "nowhere" is an enabled entry that is neither
 * preferred for anything nor global: no plan lists it.
 */
export type MirrorScope = "preferred" | "global" | "both" | "nowhere";

export function mirrorScope(mirror: Pick<AgentMirror, "prefer_for" | "global">): MirrorScope {
  const preferred = (mirror.prefer_for ?? []).length > 0;
  if (preferred && mirror.global) return "both";
  if (preferred) return "preferred";
  return mirror.global ? "global" : "nowhere";
}

/** The registry in the order the server ranks it: priority, then id. */
export function sortMirrors(mirrors: readonly AgentMirror[]): AgentMirror[] {
  return [...mirrors].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/** Health by mirror id, for the table. */
export function healthById(health: readonly AgentMirrorHealth[] | null | undefined): Map<string, AgentMirrorHealth> {
  return new Map((health ?? []).map((entry) => [entry.mirror, entry] as const));
}

/** Mirrors at least one node's last download caught writing chunks that failed the manifest. */
export function mirrorsWithChunkFailures(health: readonly AgentMirrorHealth[] | null | undefined): AgentMirrorHealth[] {
  return (health ?? []).filter((entry) => entry.chunk_failures > 0);
}

export interface MirrorRefLabel {
  /** A node, a static group, or an id neither list names (gone, or not readable here). */
  kind: "node" | "group" | "unknown";
  text: string;
}

/**
 * What a prefer_for entry names. Node and group ids share one namespace on
 * the server (node_... and grp_... prefixes), so a node is tried first.
 */
export function mirrorRefLabel(
  ref: string,
  nodes: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, string>,
): MirrorRefLabel {
  const node = nodes.get(ref);
  if (node !== undefined) return { kind: "node", text: node || ref };
  const group = groups.get(ref);
  if (group !== undefined) return { kind: "group", text: group || ref };
  return { kind: "unknown", text: ref };
}

/**
 * A principal confined to some nodes, as lattice-server decides it
 * (principalHasNodeRestriction): a non-empty allowlist without "*". Such a
 * principal reads the registry but cannot change it, because a mirror
 * steers every node.
 */
export function isNodeConfined(allowlist: readonly string[] | null | undefined): boolean {
  const list = allowlist ?? [];
  return list.length > 0 && !list.includes("*");
}

// ── the add and change form ──────────────────────────────────────────────────

/** The form's fields as typed; priority stays text until it is checked. */
export interface MirrorDraft {
  id: string;
  name: string;
  base_url: string;
  prefer_for: string[];
  global: boolean;
  priority: string;
  enabled: boolean;
}

export type MirrorDraftField = "id" | "name" | "base_url" | "priority" | "prefer_for";

export type MirrorDraftProblem =
  | "idInvalid"
  | "nameTooLong"
  | "nameNotPrintable"
  | "urlRequired"
  | "urlNotHttps"
  | "urlUserinfo"
  | "urlQuery"
  | "urlFragment"
  | "urlPath"
  | "urlDotSegment"
  | "urlTaken"
  | "idTaken"
  | "priorityInvalid"
  | "preferForTooMany";

export const DEFAULT_MIRROR_PRIORITY = "100";

export function emptyMirrorDraft(): MirrorDraft {
  return { id: "", name: "", base_url: "", prefer_for: [], global: false, priority: DEFAULT_MIRROR_PRIORITY, enabled: true };
}

export function draftFromMirror(mirror: AgentMirror): MirrorDraft {
  return {
    id: mirror.id,
    name: mirror.name ?? "",
    base_url: mirror.base_url,
    prefer_for: [...(mirror.prefer_for ?? [])],
    global: !!mirror.global,
    priority: String(mirror.priority),
    enabled: mirror.enabled,
  };
}

function baseUrlProblem(raw: string): MirrorDraftProblem | undefined {
  const value = raw.trim();
  if (!value) return "urlRequired";
  if (!/^https:\/\//i.test(value)) return "urlNotHttps";
  if (value.includes("?")) return "urlQuery";
  if (value.includes("#")) return "urlFragment";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "urlNotHttps";
  }
  if (parsed.username || parsed.password || value.slice("https://".length).split("/", 1)[0]?.includes("@")) return "urlUserinfo";
  if (!parsed.hostname) return "urlNotHttps";
  if (!MIRROR_PATH_RE.test(parsed.pathname)) return "urlPath";
  // URL() resolves "." and ".." away, so they are read from the text the
  // operator typed; the server refuses them for the same reason.
  const rawPath = value.replace(/^https:\/\/[^/]*/i, "");
  if (rawPath.split("/").some((part) => part === "." || part === "..")) return "urlDotSegment";
  return undefined;
}

/**
 * A base URL as canonicalAgentMirrorBase compares it: scheme and host
 * lowercased (URL() does both), the default port dropped, no trailing
 * slash. The server also canonicalizes numeric hosts, which this leaves to it.
 */
function comparableBase(raw: string): string {
  const value = raw.trim();
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

/**
 * The part of the server's validateAgentMirror a form can check while the
 * operator types, field by field. The host checks (loopback, link-local,
 * the control plane's own host, non-canonical numbers) stay the server's:
 * it answers 400 with the reason.
 */
export function mirrorDraftProblems(
  draft: MirrorDraft,
  /** The registry the page holds, and the entry being changed, for the server's two conflicts it can see coming. */
  context: { registry?: readonly AgentMirror[]; editing?: string } = {},
): Partial<Record<MirrorDraftField, MirrorDraftProblem>> {
  const out: Partial<Record<MirrorDraftField, MirrorDraftProblem>> = {};
  const id = draft.id.trim();
  const others = (context.registry ?? []).filter((mirror) => mirror.id !== context.editing);
  if (!MIRROR_ID_RE.test(id)) out.id = "idInvalid";
  else if (!context.editing && others.some((mirror) => mirror.id === id)) out.id = "idTaken";
  const name = draft.name.trim();
  if ([...name].length > MAX_MIRROR_NAME_CHARS) out.name = "nameTooLong";
  else if (/[\u0000-\u001f\u007f]/.test(name)) out.name = "nameNotPrintable";
  const url = baseUrlProblem(draft.base_url);
  if (url) out.base_url = url;
  else if (others.some((mirror) => comparableBase(mirror.base_url) === comparableBase(draft.base_url))) out.base_url = "urlTaken";
  const priority = draft.priority.trim();
  if (!/^\d+$/.test(priority) || Number(priority) > MAX_MIRROR_PRIORITY) out.priority = "priorityInvalid";
  if (new Set(draft.prefer_for).size > MAX_MIRROR_PREFER_FOR) out.prefer_for = "preferForTooMany";
  return out;
}

/** The entry a create or change plan carries; the server trims, sorts and canonicalizes it again. */
export function mirrorFromDraft(draft: MirrorDraft): AgentMirror {
  const name = draft.name.trim();
  const preferFor = [...new Set(draft.prefer_for.map((ref) => ref.trim()).filter(Boolean))].sort();
  return {
    id: draft.id.trim(),
    ...(name ? { name } : {}),
    base_url: draft.base_url.trim(),
    ...(preferFor.length ? { prefer_for: preferFor } : {}),
    global: draft.global,
    priority: Number(draft.priority.trim()),
    enabled: draft.enabled,
  };
}

/**
 * Whether a change draft differs from the entry, compared as the server
 * compares them after trimming and sorting. A draft that matches would only
 * get the server's 409 "already reads exactly this".
 */
export function draftChangesMirror(draft: MirrorDraft, mirror: AgentMirror): boolean {
  const next = mirrorFromDraft(draft);
  const before = [...(mirror.prefer_for ?? [])].sort();
  const after = next.prefer_for ?? [];
  return (
    (next.name ?? "") !== (mirror.name ?? "") ||
    comparableBase(next.base_url) !== comparableBase(mirror.base_url) ||
    before.join(",") !== after.join(",") ||
    !!next.global !== !!mirror.global ||
    next.priority !== mirror.priority ||
    next.enabled !== mirror.enabled
  );
}

// ── the agent.mirrors plan ───────────────────────────────────────────────────

const ACTIONS = new Set(["create", "change", "delete"]);

function isMirror(value: unknown): value is AgentMirror {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.base_url === "string";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The plan document an agent.mirrors approval carries as its text, or
 * undefined when the text is not one. The approval's hash covers the text;
 * this is only how the console reads it.
 */
export function parseAgentMirrorPlan(text: string | null | undefined): AgentMirrorPlan | undefined {
  const trimmed = text?.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const doc = parsed as Record<string, unknown>;
  if (doc.kind !== AGENT_MIRRORS_PLUGIN || typeof doc.action !== "string" || !ACTIONS.has(doc.action) || !isMirror(doc.mirror)) return undefined;
  const changes = Array.isArray(doc.changes)
    ? doc.changes
        .filter((change): change is Record<string, unknown> => !!change && typeof change === "object" && typeof (change as Record<string, unknown>).node_id === "string")
        .map((change) => ({
          node_id: change.node_id as string,
          ...(typeof change.name === "string" && change.name ? { name: change.name } : {}),
          before: stringList(change.before),
          after: stringList(change.after),
        }))
    : [];
  return {
    kind: AGENT_MIRRORS_PLUGIN,
    action: doc.action as AgentMirrorPlan["action"],
    mirror: doc.mirror,
    ...(isMirror(doc.previous) ? { previous: doc.previous } : {}),
    diff: stringList(doc.diff),
    base_revision: typeof doc.base_revision === "number" ? doc.base_revision : 0,
    changes,
  };
}

/** The fields a diff line can name, in the server's order. */
export const MIRROR_FIELDS = ["name", "base_url", "prefer_for", "global", "priority", "enabled"] as const;
export type MirrorField = (typeof MIRROR_FIELDS)[number];

/** A field's value as the server's agentMirrorField prints it; "-" is absent. */
export function mirrorFieldValue(mirror: AgentMirror | undefined, field: MirrorField): string {
  if (!mirror) return "-";
  switch (field) {
    case "name":
      return mirror.name || "-";
    case "base_url":
      return mirror.base_url;
    case "prefer_for":
      return (mirror.prefer_for ?? []).length ? (mirror.prefer_for ?? []).join(",") : "-";
    case "global":
      return String(!!mirror.global);
    case "priority":
      return String(mirror.priority);
    case "enabled":
      return String(!!mirror.enabled);
  }
}

export type MirrorDiffRow =
  | { field: MirrorField; before: AgentMirror | undefined; after: AgentMirror | undefined }
  | { raw: string };

/**
 * The plan's diff as rows the review can lay out. A line is read from the
 * plan's own entries (previous and mirror) only when rendering them gives
 * back the exact line; any other line is kept verbatim, so a value that
 * happens to contain " -> " is never split in the wrong place.
 */
export function mirrorPlanDiff(plan: AgentMirrorPlan): MirrorDiffRow[] {
  const before = plan.previous;
  const after = plan.action === "delete" ? undefined : plan.mirror;
  return plan.diff.map((line) => {
    const field = MIRROR_FIELDS.find((name) => line.startsWith(`${name}: `));
    if (field && line === `${field}: ${mirrorFieldValue(before, field)} -> ${mirrorFieldValue(after, field)}`) {
      return { field, before, after };
    }
    return { raw: line };
  });
}

/** Nodes whose order changes the same way, shown as one row. */
export interface OrderChangeGroup {
  key: string;
  before: string[];
  after: string[];
  nodes: OrderNode[];
}

export function groupOrderChanges(changes: readonly AgentMirrorOrderChange[]): OrderChangeGroup[] {
  const groups = new Map<string, OrderChangeGroup>();
  for (const change of changes) {
    // The server always sends both lists; a typed fallback may not.
    const before = change.before ?? [];
    const after = change.after ?? [];
    const key = `${before.join(" ")}|${after.join(" ")}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, before: [...before], after: [...after], nodes: [] };
      groups.set(key, group);
    }
    group.nodes.push({ id: change.node_id, name: change.name || change.node_id });
  }
  const out = [...groups.values()];
  for (const group of out) group.nodes.sort(byName);
  return out.sort((a, b) => b.nodes.length - a.nodes.length || a.key.localeCompare(b.key));
}

/**
 * A plan made against an older registry revision. The server refuses it as
 * stale when it is decided; the console says so before anyone tries.
 */
export function planBehindRegistry(plan: Pick<AgentMirrorPlan, "base_revision">, revision: number | undefined): boolean {
  return typeof revision === "number" && plan.base_revision < revision;
}

/**
 * Whether an agent.mirrors approval is stale: still pending, and made
 * against an older revision than the registry's now. Only a pending plan can
 * be: every plan that was applied moved the revision past its own base, so a
 * decided one is history, never stale.
 */
export function mirrorPlanStale(
  status: string,
  plan: Pick<AgentMirrorPlan, "base_revision"> | undefined,
  revision: number | undefined,
): boolean {
  return status === "pending" && !!plan && planBehindRegistry(plan, revision);
}

/**
 * A prefer_for change as the review reads it: what the plan adds, what it
 * removes, and what it keeps, each in the order the entry lists it.
 */
export function preferForChange(before: readonly string[] | undefined, after: readonly string[] | undefined): { added: string[]; removed: string[]; kept: string[] } {
  const was = new Set(before ?? []);
  const now = new Set(after ?? []);
  return {
    added: (after ?? []).filter((ref) => !was.has(ref)),
    removed: (before ?? []).filter((ref) => !now.has(ref)),
    kept: (after ?? []).filter((ref) => was.has(ref)),
  };
}

/**
 * The field a server refusal names, read from validateAgentMirror's
 * messages ("base_url must not ...", "mirror id must ..."), so the form
 * marks that field as well as printing the message.
 */
export function serverProblemField(message: string): MirrorDraftField | undefined {
  const text = message.trim();
  if (text.startsWith("base_url")) return "base_url";
  if (text.startsWith("prefer_for")) return "prefer_for";
  if (text.startsWith("mirror id")) return "id";
  if (text.startsWith("mirror name")) return "name";
  if (text.startsWith("mirror priority")) return "priority";
  return undefined;
}

/** The picker's one-line count of what is chosen: groups, nodes, and ids neither list names. */
export function chosenSummary(
  refs: readonly string[],
  nodes: ReadonlySet<string>,
  groups: ReadonlySet<string>,
): { total: number; groups: number; nodes: number; unknown: number } {
  const out = { total: 0, groups: 0, nodes: 0, unknown: 0 };
  for (const ref of new Set(refs)) {
    out.total += 1;
    if (nodes.has(ref)) out.nodes += 1;
    else if (groups.has(ref)) out.groups += 1;
    else out.unknown += 1;
  }
  return out;
}

/**
 * The first names of a list and how many more, for a row that must stay one
 * or two lines. A "show 1 more" would hide one name behind a click that
 * costs as much as the name, so a list one longer than the preview is shown
 * whole.
 */
export function namePreview<T>(items: readonly T[], shown: number): { names: T[]; extra: number } {
  if (items.length <= shown + 1) return { names: [...items], extra: 0 };
  return { names: items.slice(0, shown), extra: items.length - shown };
}

/**
 * What a plan does, in the words a list row can carry: an enable or a
 * disable when that is the whole change, otherwise the fields it changes.
 */
export type PlanHeadline =
  | { kind: "create" | "delete" | "enable" | "disable" }
  | { kind: "change"; fields: MirrorField[] };

export function planHeadline(plan: AgentMirrorPlan): PlanHeadline {
  if (plan.action !== "change") return { kind: plan.action };
  const fields = MIRROR_FIELDS.filter((field) => plan.diff.some((line) => line.startsWith(`${field}: `)));
  if (fields.length === 1 && fields[0] === "enabled") return { kind: plan.mirror.enabled ? "enable" : "disable" };
  return { kind: "change", fields };
}

/** A plan this page filed, held as waiting until the registry read lists it. */
export interface FiledPlan {
  id: string;
  plan: AgentMirrorPlan;
  /** When the server answered, in ms since the epoch. */
  at: number;
}

/**
 * The filed plans still worth holding after a read: not yet in the pending
 * plans read (which then speaks for them), and either listed by the
 * registry read or filed too recently for that read to know them. A plan a
 * read that came well after the filing no longer lists was decided
 * elsewhere.
 */
export function pruneFiledPlans(
  filed: readonly FiledPlan[],
  read: ReadonlySet<string>,
  listed: ReadonlySet<string>,
  now: number,
  graceMs = 5000,
): FiledPlan[] {
  return filed.filter((entry) => !read.has(entry.id) && (listed.has(entry.id) || now - entry.at < graceMs));
}

/**
 * The plans waiting, as read and as just filed, each once, leaving out any
 * made against an older registry revision than the one read: the server
 * would refuse such a plan, so it waits for nothing, and a mirror whose only
 * plan is stale has none waiting. stalePlans names those.
 */
export function waitingPlans<T extends { id: string; plan?: AgentMirrorPlan }>(
  read: readonly T[],
  filed: readonly FiledPlan[],
  revision?: number,
): Array<T | FiledPlan> {
  const known = new Set(read.map((entry) => entry.id));
  return [...read, ...filed.filter((entry) => !known.has(entry.id))].filter((entry) => !(entry.plan && planBehindRegistry(entry.plan, revision)));
}

/** The pending plans made against an older registry revision: they can only be rejected and filed afresh. */
export function stalePlans<T extends { id: string; plan?: AgentMirrorPlan }>(read: readonly T[], revision: number | undefined): T[] {
  return read.filter((entry) => !!entry.plan && planBehindRegistry(entry.plan, revision));
}

/** Mirror ids with a plan waiting, from the pending plans the page could read. */
export function pendingByMirror(plans: ReadonlyArray<{ id: string; plan?: AgentMirrorPlan }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of plans) {
    if (!entry.plan) continue;
    const list = out.get(entry.plan.mirror.id) ?? [];
    list.push(entry.id);
    out.set(entry.plan.mirror.id, list);
  }
  return out;
}
