/**
 * Terminal page logic that does not need Vue: which sessions become tabs and
 * in what order, whether Connect may fire and over which transport, what the
 * proof line under the title says, how a server close reason reads, and when
 * the page is a denied state rather than an empty one.
 *
 * The view binds these to the DOM; the tests here bind them to the server
 * contract in lattice-server/internal/server/server_terminal.go.
 */

import { isReporting, nodeStatus } from "@/lib/nodeStatus";

export type TerminalTransport = "stream" | "poll";
export type TransportMode = "auto" | TerminalTransport;

/** The scope every terminal route checks, list and per-session alike. */
export const TERMINAL_SCOPE = "terminal:open";

/**
 * Caps the server enforces, copied from server_terminal.go as static facts.
 * They are printed, never fetched: the contract is the source, and a change
 * there is a deliberate change here too.
 */
export const TERMINAL_LIMITS = Object.freeze({
  maxSessions: 128,
  maxPerNode: 4,
  pendingMinutes: 10,
  idleMinutes: 30,
  absoluteHours: 8,
});

export interface SessionLike {
  id: string;
  node_id: string;
  actor_id?: string;
  shell?: string;
  status: string;
  error?: string;
  created_at: string;
  opened_at?: string;
  closed_at?: string;
}

export interface NodeLike {
  id: string;
  name: string;
  online: boolean;
  /** The control plane's status word; see `@/lib/nodeStatus`. */
  status?: string;
  disabled?: boolean;
  agent_version?: string;
  public_ip?: string;
  public_ipv6?: string;
  tags?: string[];
  agent_runtime?: {
    allow_terminal?: boolean;
    no_exec?: boolean;
    terminal_transport?: string;
  } | null;
}

export function isEnded(session: Pick<SessionLike, "status">): boolean {
  return session.status === "closed" || session.status === "failed";
}

export function isLive(session: Pick<SessionLike, "status">): boolean {
  return !isEnded(session);
}

/**
 * Go marshals a zero time.Time as "0001-01-01T00:00:00Z" even under
 * omitempty, so a pending session carries an opened_at that must read as
 * absent, not as year one.
 */
export function parseTime(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return ms;
}

// ---------------------------------------------------------------------------
// Close reasons

export type CloseReasonKind =
  | "pending-expired"
  | "max-duration"
  | "idle"
  | "node-offline"
  | "closed"
  | "failed";

export interface CloseReason {
  kind: CloseReasonKind;
  /** The server's own words when they carry more than the kind does. */
  detail?: string;
}

// Server strings from failTerminalSession callers, matched as substrings so a
// request id suffix or a wrapping prefix does not defeat the mapping.
const REASON_PATTERNS: ReadonlyArray<[needle: string, kind: CloseReasonKind]> = [
  ["expired before node accepted it", "pending-expired"],
  ["reached maximum duration", "max-duration"],
  ["expired after inactivity", "idle"],
  ["agent did not connect", "node-offline"],
];

/** Why an ended session ended, or undefined while it is still live. */
export function closeReason(session: Pick<SessionLike, "status" | "error">): CloseReason | undefined {
  if (!isEnded(session)) return undefined;
  const error = (session.error ?? "").trim();
  for (const [needle, kind] of REASON_PATTERNS) {
    if (error.toLowerCase().includes(needle)) return { kind };
  }
  if (session.status === "failed") return { kind: "failed", detail: error || undefined };
  return { kind: "closed", detail: error || undefined };
}

// ---------------------------------------------------------------------------
// Session tabs

export interface SessionTab {
  id: string;
  nodeId: string;
  nodeName: string;
  actorId: string;
  shell: string;
  status: string;
  live: boolean;
  createdAt: number;
  openedAt?: number;
  closedAt?: number;
  reason?: CloseReason;
  /** The freshest copy of the session, for the terminal component. */
  session: SessionLike;
}

const LIFECYCLE_RANK: Record<string, number> = { pending: 0, open: 1, closed: 2, failed: 2 };

/**
 * Two copies of one session reach the page: the list poll (up to five seconds
 * old, but it carries the server's close reason) and the terminal's own
 * updates (fresh, but a stream close carries no reason). The one further
 * along the lifecycle wins; on a tie the listed copy wins because it is the
 * server's record.
 */
export function mergeSessionState<T extends SessionLike>(listed: T | undefined, local: T | undefined): T | undefined {
  if (!listed) return local;
  if (!local) return listed;
  const listedRank = LIFECYCLE_RANK[listed.status] ?? 1;
  const localRank = LIFECYCLE_RANK[local.status] ?? 1;
  if (localRank > listedRank) return local;
  if (listedRank > localRank) return listed;
  // Same stage: keep the server's record, but never lose a reason either copy
  // has; the fresher local copy may carry bytes and last_seen the list lacks.
  return { ...local, ...listed, error: listed.error || local.error };
}

export function nodeDisplayName(nodes: readonly NodeLike[], nodeId: string): string {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (node?.name) return node.name;
  return nodeId.length > 14 ? `${nodeId.slice(0, 14)}…` : nodeId;
}

/**
 * Tabs are every live session the server lists (own sessions only, from
 * server#73 on) plus the sessions this page opened or watched end and has not
 * dismissed yet. Ended sessions the page never held are not tabs: they are
 * history, and the recent line below the pane covers them.
 */
export function buildSessionTabs<T extends SessionLike>(
  listed: readonly T[],
  pinned: readonly T[],
  nodes: readonly NodeLike[],
  dismissed: ReadonlySet<string> = new Set(),
): SessionTab[] {
  const byId = new Map<string, T>();
  for (const session of listed) {
    if (isLive(session) && !dismissed.has(session.id)) byId.set(session.id, session);
  }
  for (const session of pinned) {
    if (dismissed.has(session.id)) continue;
    const fromList = listed.find((candidate) => candidate.id === session.id);
    const merged = mergeSessionState(fromList, session);
    if (merged) byId.set(session.id, merged);
  }
  return [...byId.values()]
    .map((session) => toTab(session, nodes))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function toTab(session: SessionLike, nodes: readonly NodeLike[]): SessionTab {
  return {
    id: session.id,
    nodeId: session.node_id,
    nodeName: nodeDisplayName(nodes, session.node_id),
    actorId: session.actor_id ?? "",
    shell: session.shell || "/bin/sh",
    status: session.status,
    live: isLive(session),
    createdAt: parseTime(session.created_at) ?? 0,
    openedAt: parseTime(session.opened_at),
    closedAt: parseTime(session.closed_at),
    reason: closeReason(session),
    session,
  };
}

/** Which tab to show once `closingId` leaves the strip: its right neighbour, else its left, else none. */
export function nextActiveTab(tabs: readonly Pick<SessionTab, "id">[], closingId: string, activeId: string): string {
  if (activeId !== closingId) return tabs.some((tab) => tab.id === activeId) ? activeId : "";
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index === -1) return "";
  const remaining = tabs.filter((tab) => tab.id !== closingId);
  const pick = remaining[index] ?? remaining[index - 1] ?? remaining[remaining.length - 1];
  return pick ? pick.id : "";
}

// ---------------------------------------------------------------------------
// Connect readiness and transport

export type BlockedReason = "no-node" | "disabled" | "offline" | "terminal-off" | "exec-off";

export type ConnectReadiness =
  | { ready: true; transport: TerminalTransport }
  | { ready: false; reason: BlockedReason };

/** The transport a session on this node would use, given the operator's override. */
export function resolveTransport(node: NodeLike | undefined, mode: TransportMode): TerminalTransport {
  if (mode === "stream" || mode === "poll") return mode;
  return node?.agent_runtime?.terminal_transport === "stream" ? "stream" : "poll";
}

export function connectReadiness(node: NodeLike | undefined, mode: TransportMode): ConnectReadiness {
  if (!node) return { ready: false, reason: "no-node" };
  // The same status word every page prints: disabled outranks a live agent,
  // never reported and offline both mean nobody is there to open a shell,
  // degraded still answers.
  if (nodeStatus(node) === "disabled") return { ready: false, reason: "disabled" };
  if (!isReporting(node)) return { ready: false, reason: "offline" };
  const runtime = node.agent_runtime;
  if (!runtime?.allow_terminal) return { ready: false, reason: "terminal-off" };
  if (runtime.no_exec) return { ready: false, reason: "exec-off" };
  return { ready: true, transport: resolveTransport(node, mode) };
}

/** A node the operator can open a shell on right now. */
export function isTerminalReady(node: NodeLike): boolean {
  return connectReadiness(node, "auto").ready;
}

/**
 * The create request binds the node id the operator saw at click time. The
 * caller passes the id it captured, not an index into a list that a poll may
 * have reordered since.
 */
export function createRequest(
  nodes: readonly NodeLike[],
  chosenNodeId: string,
  shell: string,
  size: { cols: number; rows: number },
): { node_id: string; shell: string; cols: number; rows: number } | undefined {
  if (!chosenNodeId) return undefined;
  if (!nodes.some((node) => node.id === chosenNodeId)) return undefined;
  return { node_id: chosenNodeId, shell, cols: size.cols, rows: size.rows };
}

// ---------------------------------------------------------------------------
// Node search

function matchesQuery(node: NodeLike, needle: string): boolean {
  return [node.name, node.id, node.public_ip, node.public_ipv6, node.agent_version, ...(node.tags ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(needle));
}

/** Ready nodes first, then by name; the query matches name, id, addresses, version and tags. */
export function filterNodes<T extends NodeLike>(nodes: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  const ordered = [...nodes].sort((a, b) => {
    const readyA = isTerminalReady(a);
    const readyB = isTerminalReady(b);
    if (readyA !== readyB) return readyA ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
  return needle ? ordered.filter((node) => matchesQuery(node, needle)) : ordered;
}

// ---------------------------------------------------------------------------
// Proof line

export interface ProofFacts {
  node?: NodeLike;
  readiness: ConnectReadiness;
  shell: string;
  /** Live sessions the server lists for this operator. */
  liveOwn: number;
  /** Of those, how many are on the chosen node. */
  liveOnNode: number;
}

export type ProofLabel =
  | { key: "transport"; transport: TerminalTransport }
  | { key: "shell"; shell: string }
  | { key: "agent"; version: string }
  | { key: "agentUnknown" }
  | { key: "liveOnNode"; count: number }
  | { key: "liveOwn"; count: number }
  | { key: "blocked"; reason: BlockedReason }
  | { key: "audited" };

/**
 * The strip under the title, as labels the view translates. Before a node is
 * chosen it says what is live and that sessions are audited; with a node it
 * adds transport, shell and agent version, or the one reason Connect is off.
 */
export function proofLabels(facts: ProofFacts): ProofLabel[] {
  const labels: ProofLabel[] = [];
  if (facts.node) {
    if (facts.readiness.ready) {
      labels.push({ key: "transport", transport: facts.readiness.transport });
      labels.push({ key: "shell", shell: facts.shell });
    } else {
      labels.push({ key: "blocked", reason: facts.readiness.reason });
    }
    if (facts.node.agent_version) labels.push({ key: "agent", version: facts.node.agent_version });
    else labels.push({ key: "agentUnknown" });
    labels.push({ key: "liveOnNode", count: facts.liveOnNode });
  }
  labels.push({ key: "liveOwn", count: facts.liveOwn });
  labels.push({ key: "audited" });
  return labels;
}

export function sessionCounts(sessions: readonly SessionLike[], nodeId: string): { liveOwn: number; liveOnNode: number } {
  let liveOwn = 0;
  let liveOnNode = 0;
  for (const session of sessions) {
    if (!isLive(session)) continue;
    liveOwn += 1;
    if (nodeId && session.node_id === nodeId) liveOnNode += 1;
  }
  return { liveOwn, liveOnNode };
}

/** The most recently ended session the server still lists, for the recent line. */
export function latestEnded<T extends SessionLike>(sessions: readonly T[]): T | undefined {
  return sessions
    .filter(isEnded)
    .sort((a, b) => (parseTime(b.closed_at) ?? parseTime(b.created_at) ?? 0) - (parseTime(a.closed_at) ?? parseTime(a.created_at) ?? 0))[0];
}

// ---------------------------------------------------------------------------
// Denied states

export type DeniedState = "no-scope" | "forbidden";

/** An HTTP 403 from the API client, checked by shape so a harness fake qualifies too. */
export function isForbidden(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 403;
}

/**
 * The page is denied, not empty, when the token lacks the scope or the server
 * refuses the list. Both read the same to the operator: nothing here can be
 * opened, and the fix is a scope grant, not a retry.
 */
export function deniedState(input: { hasScope: boolean; listError?: unknown }): DeniedState | undefined {
  if (!input.hasScope) return "no-scope";
  if (isForbidden(input.listError)) return "forbidden";
  return undefined;
}

// ---------------------------------------------------------------------------
// Route query

export function queryString(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

export function queryFlag(value: unknown): boolean {
  const raw = queryString(value);
  return raw === "1" || raw === "true";
}
