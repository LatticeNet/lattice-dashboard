/**
 * Command palette support logic. The pieces that stay framework-free so they
 * can be unit-tested without mounting the palette.
 *
 * `filterPendingSystemApprovals` decides whether the "approve all system
 * events" action exists at all: the server proposes its own plans stamped
 * with the lattice-server actor, and only those are safe to offer as a
 * one-shot batch. Anything an operator or another integration wrote still
 * deserves an individual look in the Approvals inbox.
 *
 * `createTtlCache` backs the palette's on-open fetch: opening ⌘K must feel
 * instant, so a fresh result is served for 30s; a failed fetch is never
 * cached, so the next open retries instead of hiding the action on a
 * transient blip. `invalidate` also disowns a fetch still in flight, and
 * `createPrincipalCache` keys the cache to the principal that loads it, so a
 * list read for one principal never lands after the next one signs in.
 */

/** Writer identity the server stamps on plans it proposed itself. */
export const SYSTEM_WRITER = "lattice-server";

export interface SystemApprovalCandidate {
  status: string;
  actor_id?: string;
}

/** Pending items written by the server itself. The palette action's scope. */
export function filterPendingSystemApprovals<T extends SystemApprovalCandidate>(items: readonly T[]): T[] {
  return items.filter((item) => item.status === "pending" && (item.actor_id ?? "").trim() === SYSTEM_WRITER);
}

export interface TtlCache<T> {
  /** Serve the cached value while fresh; otherwise fetch (sharing one
   *  in-flight promise across concurrent callers). */
  load: (fetcher: () => Promise<T>) => Promise<T>;
  /** Drop the cached value and disown any fetch in flight. Call after a
   *  mutation that changes the answer, or when the principal changes. */
  invalidate: () => void;
}

/**
 * What a load rejects with when `invalidate` ran while it was in flight: its
 * answer belongs to a principal or a state that is gone, so the caller keeps
 * what it has (which the invalidating code already reset) instead of writing
 * the stale answer back.
 */
export class StaleLoadError extends Error {
  constructor() {
    super("load superseded by invalidate");
    this.name = "StaleLoadError";
  }
}

export function createTtlCache<T>(ttlMs: number, now: () => number = () => Date.now()): TtlCache<T> {
  let cached: { at: number; value: T } | undefined;
  let inflight: Promise<T> | undefined;
  // Bumped by invalidate. A fetch started under an older generation neither
  // caches its answer nor resolves with it, and a load after invalidate
  // starts its own fetch instead of joining the disowned one: the principal
  // watcher invalidates, and a new principal opening the palette within the
  // old read's flight would otherwise be handed the old principal's list.
  let generation = 0;
  return {
    load(fetcher) {
      if (cached !== undefined && now() - cached.at < ttlMs) {
        return Promise.resolve(cached.value);
      }
      if (inflight) return inflight;
      const mine = generation;
      const pending: Promise<T> = fetcher()
        .then(
          (value) => {
            if (mine !== generation) throw new StaleLoadError();
            // Only successes are cached. A rejection propagates and the next
            // load retries instead of serving a remembered failure.
            cached = { at: now(), value };
            return value;
          },
          (error: unknown) => {
            throw mine !== generation ? new StaleLoadError() : error;
          },
        )
        .finally(() => {
          if (inflight === pending) inflight = undefined;
        });
      inflight = pending;
      return pending;
    },
    invalidate() {
      generation += 1;
      cached = undefined;
      inflight = undefined;
    },
  };
}

/**
 * A TtlCache that belongs to the principal signed in when it is loaded.
 * `actor` names that principal (its actor id, undefined when signed out). A
 * value read for one principal is never served to another: a load under a
 * different actor than the last one drops the cached value and disowns the
 * read in flight first. A load whose actor changed while it waited rejects
 * with StaleLoadError, so the caller does not write one principal's list into
 * state while the next one is signed in. The palette's principal watcher
 * still clears what is on screen; this keeps the cache itself from depending
 * on that watcher.
 */
export function createPrincipalCache<T>(ttlMs: number, actor: () => string | undefined, now?: () => number): TtlCache<T> {
  const cache = createTtlCache<T>(ttlMs, now);
  let owner: string | undefined;
  return {
    async load(fetcher) {
      const mine = actor();
      if (mine !== owner) {
        cache.invalidate();
        owner = mine;
      }
      const value = await cache.load(fetcher);
      if (actor() !== mine) throw new StaleLoadError();
      return value;
    },
    invalidate: () => cache.invalidate(),
  };
}

/**
 * Whether the palette reads the identity list now. The list rides vpn-core's
 * users/list on the plugin call path, where the server writes one plugin.call
 * audit row per call, and the method answers every identity at once (it takes
 * no filter). So the palette reads it only when it has a use for it: the
 * operator typed something, and an address may be what they are after, or
 * the browse view holds a recent identity, whose row takes its words from the
 * list. Opening the palette to pick a page or a recent node reads nothing.
 */
export function wantsIdentityList(query: string, recent: readonly RecentObject[]): boolean {
  return query.trim() !== "" || recent.some((object) => object.kind === "identity");
}

/**
 * Which object lists the palette may read, by the same gates its pages use.
 * `pages` is the set of nav names the sidebar offers this principal (already
 * filtered by each page's scope). Nodes and approvals ride their pages;
 * identities need vpn-core's Users page; shares need Publishing and the
 * scope Publishing asks for its list (proxy:admin), because Publishing is
 * offered to principals that may not read shares.
 */
export interface PaletteListAccess {
  nodes: boolean;
  approvals: boolean;
  identities: boolean;
  shares: boolean;
}

export function paletteListAccess(pages: { has: (name: string) => boolean }, can: (scope: string) => boolean): PaletteListAccess {
  return {
    nodes: pages.has("nodes"),
    approvals: pages.has("approvals"),
    identities: pages.has(VPN_USERS_PAGE),
    shares: pages.has("platform-publishing") && can("proxy:admin"),
  };
}

/* ------------------------------------------------------------------ */
/* Search: pages, plugin pages, nodes, approvals, identities, shares,  */
/* actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Groups in the order that breaks a tie between equally good matches. An id
 * the operator pasted is the most specific thing they could have typed, so
 * its jump always comes first; actions next, because a verb typed
 * ("approve", "renew") is a request to do something; then the objects, then
 * the pages.
 */
export const PALETTE_GROUPS = ["jump", "action", "approval", "node", "identity", "share", "page"] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export interface PaletteEntry<P = unknown> {
  /** Unique across the palette ("page:nodes", "node:node_x"). */
  key: string;
  group: PaletteGroup;
  /** What the row says, already localized. */
  label: string;
  /** The row's second line: section, address, id. Searched like a term. */
  detail?: string;
  /** Words that find the entry besides its label: ids, addresses, tags, verbs. */
  terms?: readonly string[];
  payload: P;
}

/** Case, width and spacing folded, so "ＪＰ" finds "jp" and "  Nodes " finds "nodes". */
export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokensOf(query: string): string[] {
  const normalized = normalizeSearch(query);
  return normalized ? normalized.split(" ") : [];
}

function wordsOf(text: string): string[] {
  // "@" splits too, so "example" finds alice@example.com as a word, not only as a substring.
  return text.split(/[\s/·_\-.:()[\],@]+/).filter(Boolean);
}

/**
 * How well one entry answers the query, 0 for not at all. Every token must
 * land somewhere (label, detail or a term), so "dmit la" narrows to the DMIT
 * machines in Los Angeles rather than widening to anything with "la". A hit
 * on the label outranks a hit on a term, and a prefix outranks a hit in the
 * middle, so "nod" puts Nodes above "Node Profiles" only by its label.
 */
export function paletteMatchScore(entry: Pick<PaletteEntry, "label" | "detail" | "terms">, query: string): number {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return 0;
  const label = normalizeSearch(entry.label);
  const labelWords = wordsOf(label);
  const others = [entry.detail ?? "", ...(entry.terms ?? [])].map(normalizeSearch).filter(Boolean);
  const otherWords = others.flatMap(wordsOf);
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    if (label === token) best = 100;
    else if (label.startsWith(token)) best = 80;
    else if (labelWords.some((word) => word.startsWith(token))) best = 60;
    else if (label.includes(token)) best = 40;
    else if (others.some((other) => other === token)) best = 35;
    else if (others.some((other) => other.startsWith(token)) || otherWords.some((word) => word.startsWith(token))) best = 30;
    else if (token.length >= 2 && others.some((other) => other.includes(token))) best = 15;
    if (best === 0) return 0;
    score += best;
  }
  // The whole query as typed, at the start of the label: "node pro" over "pro node".
  const whole = tokens.join(" ");
  if (tokens.length > 1 && label.startsWith(whole)) score += 20;
  return score;
}

/**
 * The entries that match, a group at a time, best first inside a group and
 * in the given order on a tie, at most `limits[group]` from each. Groups
 * come in the order of their best match, so typing a node's name puts the
 * nodes above an approval that only mentions that node; PALETTE_GROUPS
 * breaks a tie, and an id jump always leads. Fleets here run to a few dozen
 * nodes and pages, so a linear pass per keystroke is well under a
 * millisecond and needs no index.
 */
export function rankPaletteEntries<P>(
  entries: readonly PaletteEntry<P>[],
  query: string,
  limits: Partial<Record<PaletteGroup, number>> = {},
): PaletteEntry<P>[] {
  const scored = entries
    .map((entry, at) => ({ entry, at, score: paletteMatchScore(entry, query) }))
    .filter((row) => row.score > 0);
  const groups = PALETTE_GROUPS.map((group, order) => {
    const rows = scored.filter((row) => row.entry.group === group).sort((a, b) => b.score - a.score || a.at - b.at);
    const limit = limits[group] ?? Number.POSITIVE_INFINITY;
    const best = group === "jump" && rows.length ? Number.POSITIVE_INFINITY : (rows[0]?.score ?? 0);
    return { order, best, rows: rows.slice(0, limit) };
  }).filter((group) => group.rows.length > 0);
  groups.sort((a, b) => b.best - a.best || a.order - b.order);
  return groups.flatMap((group) => group.rows.map((row) => row.entry));
}

export type PaletteJumpKind = "approval" | "task" | "node";

/** Server ids are a prefix, an underscore and lowercase base32 (internal/id). */
const ID_JUMP = /^(approval|task|node)_[a-z0-9]{3,64}$/;

/**
 * A pasted approval, task or node id names one object: the palette offers
 * to open it even when it is not in any list the palette read (a decided
 * approval, a task from last week). The page's sheet says if it is gone.
 */
export function paletteIdJump(query: string): { kind: PaletteJumpKind; id: string } | null {
  const id = query.trim().toLowerCase();
  const match = ID_JUMP.exec(id);
  return match ? { kind: match[1] as PaletteJumpKind, id } : null;
}

/** Where an id jump goes: the object's sheet on its page, or the node's own page. */
export function paletteJumpLocation(jump: { kind: PaletteJumpKind; id: string }): { path: string; query?: Record<string, string> } {
  if (jump.kind === "node") return { path: `/nodes/${encodeURIComponent(jump.id)}` };
  return { path: jump.kind === "approval" ? "/approvals" : "/tasks", query: { open: jump.id } };
}

/**
 * The locale key (shell.command.terms.<key>) of the words that find a
 * destination besides its label, or null when the label already says it.
 * The words live in the locales because an operator reading Chinese types
 * Chinese verbs; the palette searches the active locale's words and the
 * English ones. Official plugin pages are keyed by plugin and route, since
 * their titles are the manifests' English.
 */
const NAV_TERMS: Readonly<Record<string, string>> = {
  overview: "overview",
  nodes: "nodes",
  inventory: "inventory",
  upcoming: "upcoming",
  monitoring: "monitoring",
  approvals: "approvals",
  tasks: "tasks",
  terminal: "terminal",
  audit: "audit",
  "network-policy": "networkPolicy",
  "network-ssh-guard": "sshGuard",
  "platform-publishing": "publishing",
  "platform-notifications": "notifications",
  "platform-agent-updates": "agentUpdates",
  "platform-system": "system",
  "settings-access": "access",
  "settings-appearance": "appearance",
};

const PLUGIN_TERMS: Readonly<Record<string, string>> = {
  "latticenet.vpn-core/users": "vpnUsers",
  "latticenet.vpn-core/lines": "vpnLines",
  "latticenet.vpn-core/profiles": "vpnProfiles",
  "latticenet.vpn-core/usage": "vpnUsage",
  "latticenet.sub-store": "subStore",
  "latticenet.netguard": "netguard",
  "latticenet.wireguard": "wireguard",
};

export function paletteTermsKey(item: { name: string; plugin?: { id: string }; route?: string }): string | null {
  if (item.plugin) {
    return PLUGIN_TERMS[`${item.plugin.id}/${item.route ?? ""}`] ?? PLUGIN_TERMS[item.plugin.id] ?? null;
  }
  return NAV_TERMS[item.name] ?? null;
}

/* ------------------------------------------------------------------ */
/* VPN identities and subscription shares, as the palette keeps them    */
/* ------------------------------------------------------------------ */

/** vpn-core's plugin id and the core-backed service its Users page reads identities from. */
export const VPN_CORE_PLUGIN_ID = "latticenet.vpn-core";
export const VPN_USERS_SERVICE = "latticenet.vpn-core/users";
/** vpn-core's Users page, by nav name: the page an identity opens in. */
export const VPN_USERS_PAGE = `plugin:${VPN_CORE_PLUGIN_ID}:users`;

export interface PaletteIdentity {
  id: string;
  email: string;
  name?: string;
  enabled: boolean;
  /** RFC 3339, absent when the identity never expires. */
  expiresAt?: string;
  group?: string;
}

export interface PaletteShare {
  id: string;
  /** The share's name: the path segment its link is served under. */
  slug: string;
  enabled: boolean;
  expiresAt?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Go writes an unset time.Time as year 1 even with omitempty, so a time
 * before 1971 means "not set".
 */
function setTime(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.UTC(1971, 0, 1) ? raw : undefined;
}

function rowsOf(answer: unknown, key: string): unknown[] {
  if (Array.isArray(answer)) return answer;
  const rows = answer && typeof answer === "object" ? (answer as Record<string, unknown>)[key] : undefined;
  return Array.isArray(rows) ? rows : [];
}

/**
 * vpn-core's users/list answer reduced to what a palette row says: the
 * address, the name, whether it is on, when it expires. The answer also
 * carries credential descriptors, bindings, quota and usage; the server
 * already reduces each credential to has_secret, and the palette has no use
 * for the rest, so none of it reaches the cache or the rows.
 */
export function paletteIdentities(answer: unknown): PaletteIdentity[] {
  const out: PaletteIdentity[] = [];
  for (const row of rowsOf(answer, "users")) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = text(record.id);
    const email = text(record.email);
    if (!id || !email) continue;
    const name = text(record.name);
    const group = text(record.group);
    out.push({
      id,
      email,
      ...(name ? { name } : {}),
      enabled: record.enabled !== false,
      ...(setTime(record.expires_at) ? { expiresAt: setTime(record.expires_at) } : {}),
      ...(group ? { group } : {}),
    });
  }
  return out;
}

/**
 * The share list reduced to each share's name and state. The list carries
 * every share's token, and the token is the subscription link itself; the
 * palette drops it on receipt, so its cache, its rows and its recents never
 * hold a link. Opening a share goes to Publishing's sheet, which reads the
 * share itself.
 */
export function paletteShares(answer: unknown): PaletteShare[] {
  const out: PaletteShare[] = [];
  for (const row of rowsOf(answer, "shares")) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = text(record.id);
    const slug = text(record.slug);
    if (!id || !slug) continue;
    const expiresAt = setTime(record.expires_at);
    out.push({ id, slug, enabled: record.enabled !== false, ...(expiresAt ? { expiresAt } : {}) });
  }
  return out;
}

export type ObjectState = "on" | "off" | "expired";

/** Turned off wins over expired: switching it back on is the first thing the operator would have to do. */
export function objectState(item: { enabled: boolean; expiresAt?: string }, now: number): ObjectState {
  if (!item.enabled) return "off";
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return "expired";
  return "on";
}

/* ------------------------------------------------------------------ */
/* Recent objects                                                       */
/* ------------------------------------------------------------------ */

export const RECENT_OBJECT_KINDS = ["node", "approval", "identity", "share"] as const;
export type RecentObjectKind = (typeof RECENT_OBJECT_KINDS)[number];

export interface RecentObject {
  kind: RecentObjectKind;
  id: string;
}

export const RECENT_OBJECTS_MAX = 5;
const RECENT_ID_MAX = 128;

function isRecentObject(value: unknown): value is RecentObject {
  if (!value || typeof value !== "object") return false;
  const { kind, id } = value as Record<string, unknown>;
  return (
    typeof kind === "string" &&
    (RECENT_OBJECT_KINDS as readonly string[]).includes(kind) &&
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= RECENT_ID_MAX
  );
}

/**
 * The objects this principal opened from the palette, newest first. Only
 * the kind and the id are stored: the row's words come from the lists the
 * palette reads on open, so an object the principal can no longer read, or
 * one that is gone, is not shown, and no name or address sits in storage.
 * A list stored by another principal (or by nobody) reads as empty.
 */
export function readRecentObjects(raw: string | null, owner: string | undefined): RecentObject[] {
  if (!raw || !owner) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const stored = parsed as { owner?: unknown; items?: unknown };
    if (stored.owner !== owner || !Array.isArray(stored.items)) return [];
    const out: RecentObject[] = [];
    for (const item of stored.items) {
      if (!isRecentObject(item) || out.some((seen) => seen.kind === item.kind && seen.id === item.id)) continue;
      out.push({ kind: item.kind, id: item.id });
      if (out.length === RECENT_OBJECTS_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** The list with `item` first and any older copy of it dropped, capped at RECENT_OBJECTS_MAX. */
export function pushRecentObject(list: readonly RecentObject[], item: RecentObject): RecentObject[] {
  return [item, ...list.filter((entry) => !(entry.kind === item.kind && entry.id === item.id))].slice(0, RECENT_OBJECTS_MAX);
}

export function serializeRecentObjects(owner: string, items: readonly RecentObject[]): string {
  return JSON.stringify({ owner, items: items.slice(0, RECENT_OBJECTS_MAX).map(({ kind, id }) => ({ kind, id })) });
}
