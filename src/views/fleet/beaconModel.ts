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

export interface BeaconForm {
  /** As typed; for an enable it opens on the node's suggested port. */
  port: string;
  /** Empty takes the default (enable) or keeps the current value (change). */
  bind: string;
  endpoint: string;
}

/** Where a node's beacon binds unless the operator says otherwise (the server's beaconDefaultBind): its primary interface address, else its public IPv4. */
export function defaultBind(node: Pick<Node, "internal_ip" | "public_ip"> | undefined): string {
  for (const raw of [node?.internal_ip, node?.public_ip]) {
    const parsed = parseBeaconIPv4((raw ?? "").trim());
    if (parsed.ok) return parsed.value;
  }
  return "";
}

/** The endpoint an enable advertises by default: the node's public IPv4 (as the destination rule accepts it) and the port. */
export function defaultEndpoint(node: Pick<Node, "public_ip"> | undefined, port: number | undefined): string {
  const ip = publicIPv4(node?.public_ip);
  return ip && port ? `${ip}:${port}` : "";
}

export function formFor(action: BeaconPlanAction, view: Pick<BeaconView, "applied" | "suggested_port"> | undefined): BeaconForm {
  if (action === "change" && view?.applied) {
    return { port: view.applied.port ? String(view.applied.port) : "", bind: view.applied.bind ?? "", endpoint: view.applied.endpoint ?? "" };
  }
  if (action === "enable") return { port: view?.suggested_port ? String(view.suggested_port) : "", bind: "", endpoint: "" };
  return { port: "", bind: "", endpoint: "" };
}

export type BeaconFormProblem =
  | { field: "port"; code: "range" }
  | { field: "bind"; code: BeaconAddressProblem }
  | { field: "endpoint"; code: BeaconEndpointProblem }
  /** Nothing typed and the node reports nothing to default to: the server refuses the plan. */
  | { field: "bind"; code: "noDefault" }
  | { field: "endpoint"; code: "noDefault" };

/**
 * The settings the server will plan from the form (beaconSettingsFor): an
 * empty port takes the suggested one (enable) or keeps the current one
 * (change); an empty bind address takes the node's primary interface
 * address; an empty endpoint takes the public IPv4 with the port, and a
 * change of port moves an endpoint that was that default along with it.
 * Fields the form gets wrong are left undefined with their problem.
 */
export function plannedSettings(
  action: BeaconPlanAction,
  form: BeaconForm,
  view: Pick<BeaconView, "applied" | "suggested_port"> | undefined,
  node: Pick<Node, "internal_ip" | "public_ip"> | undefined,
): { port?: number; bind?: string; endpoint?: string; endpointDefault: boolean; problems: BeaconFormProblem[] } {
  const problems: BeaconFormProblem[] = [];
  if (action === "disable") return { endpointDefault: false, problems };
  const current = action === "change" ? view?.applied ?? undefined : undefined;
  let port: number | undefined = current?.port || undefined;
  let portChanged = false;
  const typedPort = form.port.trim();
  if (typedPort) {
    const n = Number(typedPort);
    if (!/^\d+$/.test(typedPort) || !validListenPort(n)) problems.push({ field: "port", code: "range" });
    else {
      portChanged = n !== port;
      port = n;
    }
  } else if (!port && view?.suggested_port) {
    port = view.suggested_port;
    portChanged = true;
  }

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

  let endpoint: string | undefined = current?.endpoint || undefined;
  let endpointDefault = false;
  const typedEndpoint = form.endpoint.trim();
  const followsPort = !!current?.endpoint && portChanged && current.endpoint === `${(node?.public_ip ?? "").trim()}:${current.port}`;
  if (typedEndpoint && !(followsPort && typedEndpoint === current?.endpoint)) {
    const parsed = parseBeaconEndpoint(typedEndpoint);
    if (parsed.ok) endpoint = parsed.value;
    else {
      endpoint = undefined;
      problems.push({ field: "endpoint", code: parsed.problem });
    }
  } else if (!endpoint || followsPort) {
    endpoint = defaultEndpoint(node, port) || undefined;
    endpointDefault = true;
    if (!endpoint && port) problems.push({ field: "endpoint", code: "noDefault" });
  }
  return { port, bind, endpoint, endpointDefault, problems };
}

/**
 * The plan request. An enable names the port (the field opens on the
 * suggested one) and only the addresses the operator typed; a change names
 * only what differs from the applied settings, so an untouched field keeps
 * its value; a disable names nothing.
 */
export function buildBeaconPlanRequest(nodeId: string, action: BeaconPlanAction, form: BeaconForm, view: Pick<BeaconView, "applied"> | undefined): BeaconPlanRequest {
  const body: BeaconPlanRequest = { node_id: nodeId, action };
  if (action === "disable") return body;
  const current = action === "change" ? view?.applied ?? undefined : undefined;
  const port = Number(form.port.trim());
  if (form.port.trim() && validListenPort(port) && port !== current?.port) body.port = port;
  const bind = form.bind.trim();
  if (bind && bind !== current?.bind) body.bind = bind;
  const endpoint = form.endpoint.trim();
  if (endpoint && endpoint !== current?.endpoint) body.endpoint = endpoint;
  return body;
}

/** Which settings a change plan would move. A change that moves none re-plans the source set and the NetGuard rule. */
export function changedSettings(form: BeaconForm, view: Pick<BeaconView, "applied"> | undefined): ("port" | "bind" | "endpoint")[] {
  const body = buildBeaconPlanRequest("", "change", form, view);
  return (["port", "bind", "endpoint"] as const).filter((key) => body[key] !== undefined);
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
