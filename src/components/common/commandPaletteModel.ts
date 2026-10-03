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
 * transient blip.
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
  /** Drop the cached value. Call after a mutation that changes the answer. */
  invalidate: () => void;
}

export function createTtlCache<T>(ttlMs: number, now: () => number = () => Date.now()): TtlCache<T> {
  let cached: { at: number; value: T } | undefined;
  let inflight: Promise<T> | undefined;
  return {
    load(fetcher) {
      if (cached !== undefined && now() - cached.at < ttlMs) {
        return Promise.resolve(cached.value);
      }
      inflight ??= fetcher()
        .then((value) => {
          // Only successes are cached. A rejection propagates and the next
          // load retries instead of serving a remembered failure.
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Search: pages, plugin pages, nodes, approvals, actions               */
/* ------------------------------------------------------------------ */

/**
 * Groups in the order that breaks a tie between equally good matches. An id
 * the operator pasted is the most specific thing they could have typed, so
 * its jump always comes first; actions next, because a verb typed
 * ("approve", "renew") is a request to do something; then the objects, then
 * the pages.
 */
export const PALETTE_GROUPS = ["jump", "action", "approval", "node", "page"] as const;
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
  return text.split(/[\s/·_\-.:()[\],]+/).filter(Boolean);
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
