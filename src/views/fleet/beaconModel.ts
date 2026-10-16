/**
 * A node's measurement beacon (design 29 D3, wire contract D12): the one
 * inbound socket an agent may open, off until an approved node.beacon plan
 * turns it on, answering only requests signed for it.
 *
 * The node page reads GET /api/nodes/beacon and files plans through
 * POST /api/nodes/beacon/plan; the decision is made on the approvals page.
 * This file reads the view into what the Beacon card says, mirrors the
 * address rules of lattice-sdk package beacon (ParseIPv4, ParseEndpoint,
 * ValidListenPort) so the plan form refuses what the server would, and works
 * out, from the form, the settings the server will plan (the server's
 * beaconSettingsFor), so the operator sees what the plan will ask before it
 * is filed. The server stays the authority: its plan document is what the
 * approval binds.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type {
  ApprovalView,
  BeaconFinding,
  BeaconLimits,
  BeaconPlan,
  BeaconPlanAction,
  BeaconPlanRequest,
  BeaconSettings,
  BeaconSourceView,
  BeaconView,
  Node,
} from "@/lib/api/types";

import { publicIPv4 } from "@/views/fleet/checkRulesModel";

/* ------------------------------------------------------------------ */
/* Ports and addresses (lattice-sdk beacon/addr.go)                     */
/* ------------------------------------------------------------------ */

/** The range the control plane draws a node's random listen port from. */
export const BEACON_PORT_RANDOM_MIN = 40000;
export const BEACON_PORT_RANDOM_MAX = 59999;
/** The lowest port an operator may choose: the beacon never takes a privileged port. */
export const BEACON_PORT_MIN = 1024;
export const BEACON_PORT_MAX = 65535;

/** model.DefaultBeaconLimits: 20 requests a second per source, a 10 s interval floor, 2 packets a second per source and target. */
export const DEFAULT_BEACON_LIMITS: BeaconLimits = { source_rate_per_second: 20, min_interval_sec: 10, packets_per_second_max: 2 };

/** Generated check id prefixes (model.LatencyMonitorPrefixBeacon, BeaconReachMonitorPrefix). */
export const BEACON_CHECK_PREFIX = "mon_latb_";
export const BEACON_REACH_PREFIX = "mon_beaconr_";
/** Monitor.managed_by on a reachability check. */
export const BEACON_MANAGED_BY = "beacon";

/** Whether a port may be a beacon's listen port (beacon.ValidListenPort). */
export function validListenPort(port: number): boolean {
  return Number.isInteger(port) && port >= BEACON_PORT_MIN && port <= BEACON_PORT_MAX;
}

export type BeaconAddressProblem = "notIPv4" | "refused";

function octets(text: string): number[] | undefined {
  // netip.ParseAddr reads four decimal fields, each 0 to 255, with no leading zero; String() must give the text back.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return undefined;
  const parts = text.split(".");
  if (parts.some((p) => p.length > 1 && p.startsWith("0"))) return undefined;
  const values = parts.map(Number);
  return values.every((v) => v <= 255) ? values : undefined;
}

/**
 * beacon.AddressRefused: unspecified (0.0.0.0/8), loopback, link-local
 * (169.254.0.0/16, which holds cloud metadata), multicast and 240.0.0.0/4
 * with the broadcast address. Private and shared ranges stay allowed: a NAT
 * node binds its private address.
 */
function addressRefused(b: number[]): boolean {
  return b[0] === 0 || b[0] === 127 || (b[0] === 169 && b[1] === 254) || b[0]! >= 224;
}

/** A bind address or an endpoint's host (beacon.ParseIPv4): a canonical dotted-quad IPv4 literal of an allowed class. */
export function parseBeaconIPv4(raw: string): { ok: true; value: string } | { ok: false; problem: BeaconAddressProblem } {
  const b = octets(raw);
  if (!b) return { ok: false, problem: "notIPv4" };
  if (addressRefused(b)) return { ok: false, problem: "refused" };
  return { ok: true, value: raw };
}

export type BeaconEndpointProblem = BeaconAddressProblem | "shape" | "port";

/**
 * An advertised endpoint (beacon.ParseEndpoint): an IPv4 literal and a port,
 * never a host name, so a source can never be pointed at a third party or
 * rebound by DNS.
 */
export function parseBeaconEndpoint(raw: string): { ok: true; value: string } | { ok: false; problem: BeaconEndpointProblem } {
  const text = raw.trim();
  const at = text.indexOf(":");
  if (at < 0 || text.indexOf(":", at + 1) >= 0) return { ok: false, problem: "shape" };
  const host = parseBeaconIPv4(text.slice(0, at));
  if (!host.ok) return host;
  const portText = text.slice(at + 1);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || String(port) !== portText || port < 1 || port > 65535) return { ok: false, problem: "port" };
  return { ok: true, value: `${host.value}:${port}` };
}

/* ------------------------------------------------------------------ */
/* The view                                                             */
/* ------------------------------------------------------------------ */

export const BEACON_STATES = ["off", "pending", "listening", "refused_by_node", "not_listening", "agent_too_old"] as const;
export type BeaconCardState = (typeof BEACON_STATES)[number];

/** The state as the card words it; a state this console does not know reads pending, never listening. */
export function beaconState(view: Pick<BeaconView, "state"> | undefined): BeaconCardState {
  const raw = view?.state ?? "off";
  return (BEACON_STATES as readonly string[]).includes(raw) ? (raw as BeaconCardState) : "pending";
}

/** Whether an applied plan enables the beacon: every state but off. */
export function beaconEnabled(view: Pick<BeaconView, "state"> | undefined): boolean {
  return beaconState(view) !== "off";
}

export type BeaconTone = "success" | "warning" | "destructive" | "muted";

/** Listening is the one good state; a beacon the node refuses or cannot open is broken; an agent too old waits for an update. */
export function beaconTone(state: BeaconCardState): BeaconTone {
  switch (state) {
    case "listening":
      return "success";
    case "refused_by_node":
    case "not_listening":
      return "destructive";
    case "agent_too_old":
      return "warning";
    default:
      return "muted";
  }
}

/** The agent's report: the view's copy, else the node list's. */
function factsOf(view: Pick<BeaconView, "agent"> | undefined, node?: Pick<Node, "beacon">) {
  return view?.agent ?? node?.beacon ?? undefined;
}

/** The node runs its agent with -no-beacon: it never binds, whatever a plan says. */
export function nodeRefusesBeacon(view: Pick<BeaconView, "agent"> | undefined, node?: Pick<Node, "beacon">): boolean {
  return !!factsOf(view, node)?.refusal;
}

/** The agent implements the responder (an agent before M2b reports nothing). */
export function agentHasResponder(view: Pick<BeaconView, "agent"> | undefined, node?: Pick<Node, "beacon">): boolean {
  return !!factsOf(view, node)?.responder;
}

/** Why the agent is not listening, in its own words when it gave them. */
export function notListeningCause(view: Pick<BeaconView, "agent"> | undefined): { kind: "bind_failed" | "circuit_open" | "other"; error?: string } {
  const facts = view?.agent;
  const kind = facts?.state === "bind_failed" ? "bind_failed" : facts?.state === "circuit_open" ? "circuit_open" : "other";
  return { kind, error: facts?.error?.trim() || undefined };
}

export interface BeaconSources {
  /** Approved by the applied plan and using the beacon now. */
  active: BeaconSourceView[];
  /** Using it (the path set or a check) but not approved: they wait for a change plan. */
  waiting: BeaconSourceView[];
  /** Approved but no longer using it: the next change plan drops them. */
  idle: BeaconSourceView[];
}

export function beaconSources(view: Pick<BeaconView, "sources"> | undefined): BeaconSources {
  const out: BeaconSources = { active: [], waiting: [], idle: [] };
  const byName = (a: BeaconSourceView, b: BeaconSourceView) => (a.name || a.node_id).localeCompare(b.name || b.node_id) || a.node_id.localeCompare(b.node_id);
  for (const s of [...(view?.sources ?? [])].sort(byName)) {
    if (s.current && s.approved) out.active.push(s);
    else if (s.current) out.waiting.push(s);
    else if (s.approved) out.idle.push(s);
  }
  return out;
}

/**
 * Sources waiting for a change plan. The server says firewall_pending only
 * when NetGuard guards the node; without NetGuard the same sources wait for
 * a plan all the same (the target holds no key for them), so the card names
 * them either way.
 */
export function waitingSources(view: Pick<BeaconView, "sources" | "state"> | undefined): BeaconSourceView[] {
  return beaconEnabled(view) ? beaconSources(view).waiting : [];
}

/** The scopes the beacon's actions need (D12): planning needs netguard:admin too when NetGuard guards the node. */
export interface BeaconScopes {
  monitorAdmin: boolean;
  nodeAdmin: boolean;
  networkPlan: boolean;
  netguardAdmin: boolean;
}

export const BEACON_PLAN_SCOPES = ["monitor:admin", "node:admin", "network:plan"] as const;
export const BEACON_ROTATE_SCOPES = ["monitor:admin", "node:admin"] as const;

export interface BeaconActions {
  /** Enable (off), change and turn off (enabled), each through a plan. */
  enable: boolean;
  change: boolean;
  disable: boolean;
  rotate: boolean;
  /** Enable is offered but cannot be used: the node refuses a beacon. */
  enableBlocked?: "refused_by_node";
  /** The scopes this session lacks for the actions the state would offer; empty when it has them all. */
  missing: string[];
}

export function beaconActions(view: Pick<BeaconView, "state" | "exposure" | "agent"> | undefined, scopes: BeaconScopes, node?: Pick<Node, "beacon">): BeaconActions {
  const enabled = beaconEnabled(view);
  const companion = view?.exposure === "netguard";
  const missing: string[] = [];
  if (!scopes.monitorAdmin) missing.push("monitor:admin");
  if (!scopes.nodeAdmin) missing.push("node:admin");
  const rotateOk = missing.length === 0;
  if (!scopes.networkPlan) missing.push("network:plan");
  if (companion && !scopes.netguardAdmin) missing.push("netguard:admin");
  const planOk = missing.length === 0;
  return {
    enable: !enabled && planOk,
    change: enabled && planOk,
    disable: enabled && planOk,
    rotate: enabled && rotateOk,
    enableBlocked: !enabled && planOk && nodeRefusesBeacon(view, node) ? "refused_by_node" : undefined,
    missing,
  };
}

/* ------------------------------------------------------------------ */
/* The plan form                                                        */
/* ------------------------------------------------------------------ */

/** The endpoint address choice that reveals a typed address. */
export const OTHER_ADDRESS = "other";

export interface BeaconForm {
  /** As typed; for an enable it opens on the node's suggested port. */
  port: string;
  /** Empty takes the default (enable) or keeps the current value (change). */
  bind: string;
  /** The address sources send to: one of endpointAddresses, or OTHER_ADDRESS for endpointOther. */
  endpointAddress: string;
  /** The typed address when endpointAddress is OTHER_ADDRESS: an edge a line on the node declares. */
  endpointOther: string;
  /** The port sources send to; empty is the listen port. It differs only behind a NAT that maps another outside port. */
  endpointPort: string;
}

export type EndpointAddressKind = "public" | "interface" | "current";

export interface EndpointAddress {
  address: string;
  kind: EndpointAddressKind;
}

function endpointParts(endpoint: string | undefined): { host: string; port: number } | undefined {
  const parsed = parseBeaconEndpoint(endpoint ?? "");
  if (!parsed.ok) return undefined;
  const at = parsed.value.lastIndexOf(":");
  return { host: parsed.value.slice(0, at), port: Number(parsed.value.slice(at + 1)) };
}

/**
 * The addresses the form offers for the endpoint, as far as the console
 * sees the server's beaconNodeAddresses: the node's public IPv4 and its
 * primary interface address, then the applied endpoint's address when it is
 * neither (a provider edge a line declares, or an address the node has
 * left). Line edges are not on this wire, so a new one is typed
 * (OTHER_ADDRESS) and the server judges it.
 */
export function endpointAddresses(node: Pick<Node, "internal_ip" | "public_ip"> | undefined, applied?: Pick<BeaconSettings, "endpoint"> | null): EndpointAddress[] {
  const out: EndpointAddress[] = [];
  const add = (address: string | undefined, kind: EndpointAddressKind) => {
    if (address && !out.some((a) => a.address === address)) out.push({ address, kind });
  };
  const pub = parseBeaconIPv4((node?.public_ip ?? "").trim());
  add(pub.ok ? pub.value : undefined, "public");
  const internal = parseBeaconIPv4((node?.internal_ip ?? "").trim());
  add(internal.ok ? internal.value : undefined, "interface");
  add(endpointParts(applied?.endpoint ?? undefined)?.host, "current");
  return out;
}

/** The address an enable offers first: the public IPv4 the server would default to, else the first the node reports, else a typed one. */
export function defaultEndpointAddress(node: Pick<Node, "internal_ip" | "public_ip"> | undefined): string {
  return publicIPv4(node?.public_ip) ?? endpointAddresses(node)[0]?.address ?? OTHER_ADDRESS;
}

/** Where a node's beacon binds unless the operator says otherwise (the server's beaconDefaultBind): its primary interface address, else its public IPv4. */
export function defaultBind(node: Pick<Node, "internal_ip" | "public_ip"> | undefined): string {
  for (const raw of [node?.internal_ip, node?.public_ip]) {
    const parsed = parseBeaconIPv4((raw ?? "").trim());
    if (parsed.ok) return parsed.value;
  }
  return "";
}

/**
 * The form a plan opens on. A change opens on the applied settings, its
 * endpoint split into the address and, when a NAT maps another outside
 * port, that port; an enable opens on the suggested port and the address
 * the server would default to.
 */
export function formFor(
  action: BeaconPlanAction,
  view: Pick<BeaconView, "applied" | "suggested_port"> | undefined,
  node: Pick<Node, "internal_ip" | "public_ip"> | undefined,
): BeaconForm {
  const empty: BeaconForm = { port: "", bind: "", endpointAddress: "", endpointOther: "", endpointPort: "" };
  if (action === "change" && view?.applied) {
    const a = view.applied;
    const ep = endpointParts(a.endpoint);
    return {
      port: a.port ? String(a.port) : "",
      bind: a.bind ?? "",
      endpointAddress: ep?.host ?? defaultEndpointAddress(node),
      endpointOther: "",
      endpointPort: ep && ep.port !== a.port ? String(ep.port) : "",
    };
  }
  if (action === "enable") return { ...empty, port: view?.suggested_port ? String(view.suggested_port) : "", endpointAddress: defaultEndpointAddress(node) };
  return empty;
}

export type BeaconFormProblem =
  | { field: "port"; code: "range" }
  | { field: "bind"; code: BeaconAddressProblem }
  /** Nothing typed and the node reports nothing to default to: the server refuses the plan. */
  | { field: "bind"; code: "noDefault" }
  /** No address chosen, or Another address with nothing typed. */
  | { field: "endpointAddress"; code: BeaconAddressProblem | "missing" }
  /** Not a port; or "needed": a typed address with the listen port still to be drawn. */
  | { field: "endpointPort"; code: "range" | "needed" };

/**
 * The settings the server will plan from the form (beaconSettingsFor): an
 * empty port takes the suggested one (enable) or keeps the current one
 * (change); an empty bind address takes the node's primary interface
 * address. The endpoint is the chosen address with the endpoint port, or
 * the listen port when that is empty, so a changed listen port moves an
 * endpoint that followed it. An enable whose port the control plane will
 * draw leaves the endpoint to the server when it is the public IPv4.
 * Fields the form gets wrong are left undefined with their problem.
 */
export function plannedSettings(
  action: BeaconPlanAction,
  form: BeaconForm,
  view: Pick<BeaconView, "applied" | "suggested_port"> | undefined,
  node: Pick<Node, "internal_ip" | "public_ip"> | undefined,
): { port?: number; portRandom: boolean; bind?: string; endpoint?: string; endpointDefault: boolean; problems: BeaconFormProblem[] } {
  const problems: BeaconFormProblem[] = [];
  if (action === "disable") return { portRandom: false, endpointDefault: false, problems };
  const current = action === "change" ? view?.applied ?? undefined : undefined;
  let port: number | undefined = current?.port || undefined;
  const typedPort = form.port.trim();
  if (typedPort) {
    const n = Number(typedPort);
    if (!/^\d+$/.test(typedPort) || !validListenPort(n)) problems.push({ field: "port", code: "range" });
    else port = n;
  } else if (!port && view?.suggested_port) {
    port = view.suggested_port;
  }
  // An enable with no port and no suggestion: the control plane draws one from 40000 to 59999 when it plans.
  const portRandom = action === "enable" && !typedPort && !port;

  let bind: string | undefined = current?.bind || undefined;
  const typedBind = form.bind.trim();
  if (typedBind) {
    const parsed = parseBeaconIPv4(typedBind);
    if (parsed.ok) bind = parsed.value;
    else {
      bind = undefined;
      problems.push({ field: "bind", code: parsed.problem });
    }
  } else if (!bind) {
    bind = defaultBind(node) || undefined;
    if (!bind) problems.push({ field: "bind", code: "noDefault" });
  }

  let endpoint: string | undefined;
  let endpointDefault = false;
  let host: string | undefined;
  if (form.endpointAddress === OTHER_ADDRESS) {
    const typed = form.endpointOther.trim();
    const parsed = typed ? parseBeaconIPv4(typed) : undefined;
    if (parsed?.ok) host = parsed.value;
    else problems.push({ field: "endpointAddress", code: parsed ? parsed.problem : "missing" });
  } else if (form.endpointAddress) {
    host = form.endpointAddress;
  } else {
    problems.push({ field: "endpointAddress", code: "missing" });
  }
  const typedSendPort = form.endpointPort.trim();
  let sendPort = port;
  if (typedSendPort) {
    const n = Number(typedSendPort);
    if (!/^\d+$/.test(typedSendPort) || String(n) !== typedSendPort || n < 1 || n > 65535) {
      sendPort = undefined;
      problems.push({ field: "endpointPort", code: "range" });
    } else sendPort = n;
  }
  if (host && sendPort) endpoint = `${host}:${sendPort}`;
  else if (host && portRandom && !typedSendPort) {
    // The server advertises the public IPv4 with the port it draws; any other address needs its port named.
    if (host === publicIPv4(node?.public_ip)) endpointDefault = true;
    else problems.push({ field: "endpointPort", code: "needed" });
  }
  return { port, portRandom, bind, endpoint, endpointDefault, problems };
}

/**
 * Whether an endpoint's address is one of the node's own (the server's
 * beaconEndpointCurrent): its public or primary interface address. The
 * server also accepts a provider edge a line on the node declares, which
 * the console cannot see, so a miss is a note, never a refusal.
 */
export function endpointIsOwn(endpoint: string | undefined, node: Pick<Node, "internal_ip" | "public_ip"> | undefined): boolean {
  const host = endpointParts(endpoint)?.host;
  if (!host) return true;
  return endpointAddresses(node).some((a) => a.address === host);
}

/**
 * The plan request. An enable names the port (the field opens on the
 * suggested one), the bind address the operator typed and the endpoint
 * unless the server is to draw the port; a change names only what differs
 * from the applied settings, so an untouched field keeps its value; a
 * disable names nothing.
 */
export function buildBeaconPlanRequest(
  node: Pick<Node, "id" | "internal_ip" | "public_ip">,
  action: BeaconPlanAction,
  form: BeaconForm,
  view: Pick<BeaconView, "applied" | "suggested_port"> | undefined,
): BeaconPlanRequest {
  const body: BeaconPlanRequest = { node_id: node.id, action };
  if (action === "disable") return body;
  const current = action === "change" ? view?.applied ?? undefined : undefined;
  const port = Number(form.port.trim());
  if (form.port.trim() && validListenPort(port) && port !== current?.port) body.port = port;
  const bind = form.bind.trim();
  if (bind && bind !== current?.bind) body.bind = bind;
  const endpoint = plannedSettings(action, form, view, node).endpoint;
  if (endpoint && endpoint !== current?.endpoint) body.endpoint = endpoint;
  return body;
}

/** Which settings a change plan would move. A change that moves none re-plans the source set and the NetGuard rule. */
export function changedSettings(
  form: BeaconForm,
  view: Pick<BeaconView, "applied" | "suggested_port"> | undefined,
  node: Pick<Node, "id" | "internal_ip" | "public_ip">,
): ("port" | "bind" | "endpoint")[] {
  const body = buildBeaconPlanRequest(node, "change", form, view);
  return (["port", "bind", "endpoint"] as const).filter((key) => body[key] !== undefined);
}

/* ------------------------------------------------------------------ */
/* The NetGuard companion                                               */
/* ------------------------------------------------------------------ */

export type CompanionOutcome =
  /** The apply task is queued or running, or waits on what the server's sentence names. */
  | { kind: "applying"; reason?: string; blocked: boolean }
  /** The task failed: NetGuard did not take the rule, and the beacon stays closed to every source. */
  | { kind: "failed"; reason?: string }
  | { kind: "applied" }
  /** A status this console does not know. */
  | { kind: "unknown" };

/**
 * The approval to read for the NetGuard companion's outcome: the applied
 * plan's, while NetGuard guards the node and the view says firewall
 * pending (design 29 D12: the beacon stays closed to sources until the
 * companion task succeeds, and stays closed if it fails).
 */
export function companionApprovalToRead(view: Pick<BeaconView, "state" | "exposure" | "firewall_pending" | "applied_approval_id"> | undefined): string | undefined {
  if (!view || !beaconEnabled(view) || view.exposure !== "netguard" || !view.firewall_pending) return undefined;
  return view.applied_approval_id || undefined;
}

/** How the applied plan's NetGuard task went, read from its approval. */
export function companionOutcome(approval: Pick<ApprovalView, "status" | "reason" | "waiting"> | undefined): CompanionOutcome {
  switch (approval?.status) {
    case "approved":
      return { kind: "applying", reason: approval.waiting?.reason?.trim() || undefined, blocked: !!approval.waiting?.blocked };
    case "applied":
      return { kind: "applied" };
    case "rejected":
    case "failed":
      return { kind: "failed", reason: approval.reason?.trim() || undefined };
    default:
      return { kind: "unknown" };
  }
}

/**
 * Why a plan or a read was refused with 403, in the terms D12 gives: a
 * node.beacon plan names every source with its addresses, so filing or
 * reading one needs monitor:read on each of them.
 */
export function beaconForbidden(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 403;
}

/* ------------------------------------------------------------------ */
/* The plan document                                                    */
/* ------------------------------------------------------------------ */

/** The plan the approval binds, read from its text; the response's own copy when the text does not parse. */
export function readBeaconPlan(text: string | undefined | null, fallback?: BeaconPlan): BeaconPlan | undefined {
  if (text) {
    try {
      const parsed = JSON.parse(text) as BeaconPlan;
      if (parsed && typeof parsed === "object" && parsed.beacon && typeof parsed.beacon === "object") return parsed;
    } catch {
      /* not JSON: fall back to the response's copy */
    }
  }
  return fallback;
}

export interface SettingsRow {
  key: "state" | "port" | "bind" | "endpoint";
  before?: string;
  after?: string;
  changed: boolean;
}

/** Settings before and after, for the filed plan: a disable shows what closes, an enable what opens. */
export function settingsRows(plan: Pick<BeaconPlan, "beacon" | "previous">): SettingsRow[] {
  const before = plan.previous ?? undefined;
  const after = plan.beacon;
  const on = (s?: BeaconSettings) => !!s?.enabled;
  const value = (s: BeaconSettings | undefined, key: "port" | "bind" | "endpoint") => (on(s) && s?.[key] ? String(s[key]) : undefined);
  const rows: SettingsRow[] = [{ key: "state", before: on(before) ? "on" : "off", after: on(after) ? "on" : "off", changed: on(before) !== on(after) }];
  for (const key of ["port", "bind", "endpoint"] as const) {
    const b = value(before, key);
    const a = value(after, key);
    rows.push({ key, before: b, after: a, changed: b !== a });
  }
  return rows;
}

/** Blocking findings first, then warnings, each by code. */
export function sortFindings(findings: readonly BeaconFinding[] | null | undefined): BeaconFinding[] {
  const rank = (f: BeaconFinding) => (f.severity === "block" ? 0 : f.severity === "warn" ? 1 : 2);
  return [...(findings ?? [])].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

/** The findings a refused plan came back with (409, `{error, findings}`), or none when the refusal was something else. */
export function refusedFindings(error: unknown): BeaconFinding[] {
  const e = error as { status?: number; body?: unknown } | null;
  if (e?.status !== 409) return [];
  const findings = (e.body as { findings?: BeaconFinding[] } | undefined)?.findings;
  return Array.isArray(findings) ? sortFindings(findings) : [];
}

/** How many addresses the NetGuard companion admits, counted once each. */
export function companionAllowCount(plan: Pick<BeaconPlan, "netguard">): number {
  return new Set(plan.netguard?.allow ?? []).size;
}

/** A hash shortened for a line, with both ends kept: "9f2c41…07e1". */
export function shortHash(hash: string | undefined, keep = 6): string {
  const h = (hash ?? "").trim();
  return h.length > keep * 2 + 1 ? `${h.slice(0, keep)}…${h.slice(-4)}` : h;
}

/* ------------------------------------------------------------------ */
/* Reachability and rotation                                            */
/* ------------------------------------------------------------------ */

export const BEACON_REACH_STATES = ["pending", "reachable", "filtered", "not_listening", "no_source"] as const;
export type BeaconReachState = (typeof BEACON_REACH_STATES)[number];

/** The reachability verdict, or undefined before any check was armed. */
export function reachState(view: Pick<BeaconView, "reachability"> | undefined): BeaconReachState | undefined {
  const raw = view?.reachability?.state;
  if (!raw) return undefined;
  return (BEACON_REACH_STATES as readonly string[]).includes(raw) ? (raw as BeaconReachState) : undefined;
}

/** The epoch a rotation moves sources to. */
export function nextEpoch(view: Pick<BeaconView, "epoch"> | undefined): number {
  return (view?.epoch ?? 0) + 1;
}

/** Whether a check is a beacon's reachability check: not a path, not the operator's, shown only on the Beacon card. */
export function isReachabilityCheck(monitor: { id?: string; monitor_id?: string; managed_by?: string } | undefined): boolean {
  if (!monitor) return false;
  const id = monitor.id ?? monitor.monitor_id ?? "";
  return monitor.managed_by === BEACON_MANAGED_BY || id.startsWith(BEACON_REACH_PREFIX);
}
