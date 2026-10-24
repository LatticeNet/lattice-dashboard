/**
 * An in-memory stand-in for `@/lib/api` for the Home and Fleet pages, wired in
 * by vite.harness.config.ts through a resolve alias so the production config
 * and bundle never see it.
 *
 *   LATTICE_HARNESS=fleet LATTICE_HARNESS_PORT=5471 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5471/dev/fleet.html               (Home)
 *   open http://127.0.0.1:5471/dev/fleet-nodes.html         (Nodes)
 *   open http://127.0.0.1:5471/dev/fleet-node.html?id=node_020  (one node's page)
 *   open http://127.0.0.1:5471/dev/fleet-machines.html      (Machines)
 *   open http://127.0.0.1:5471/dev/fleet-map.html           (Map)
 *   open http://127.0.0.1:5471/dev/fleet-monitoring.html    (Monitoring)
 *   open http://127.0.0.1:5471/dev/fleet-groups.html        (Groups)
 *
 * The data is dev/fleetFixture.ts (`?fleet=prod|dense|empty`,
 * `?monitors=some`). `?fail=` is a comma list of reads that answer 502, so
 * each page's failed and stale states can be drawn: nodes, audit, counts,
 * approvals, expiring, machines, monitors, groups, ddns, geo, tasks, or all.
 * `?fail=nodes:later` lets the first read land and fails every one after it
 * (the stale state). `?deny=tasks,approvals,audit,machines` answers those reads
 * 403 and drops their read scopes, for a principal that cannot read them.
 * Reads are counted by name on window.__harnessReads, so a render can prove
 * a read happened or did not.
 * `?expire=<ms>` ends the session that long after the page loads: every read
 * and /api/me then answer 401, reported the way the real client reports them,
 * and signing in again starts a session that does not expire.
 * `?incidents=some` gives the Keepalive layer, Home and the node pages their
 * incidents, maintenance windows and loop health (dev/keepaliveFixture.ts);
 * acknowledging, snoozing and editing windows change the in-memory state.
 * `?m2b=1` answers as a design 29 M2b server (dev/beaconShapes.ts): the
 * beacon routes answer, nodes report beacon facts, and plans and rotations
 * change the in-memory state; without it those routes answer 404, as a
 * server before M2b does. `?fail=beacon` fails the beacon read, `?deny=beacon`
 * refuses it (403), `?deny=beaconplan` refuses a plan (403), `?deny=approvals`
 * refuses the companion's approval read, and `?beaconMs=` slows the read.
 * `?latency=one|three|defaults|nosource|off` shapes the Latency layer and the
 * node page's latency card (dev/latencyFixture.ts); `?fail=latency` fails its
 * reads, and saving the probe settings recomputes the plan by the server's rule.
 * `?chains=some|none` shapes the Topology layer's line chains
 * (dev/topologyFixture.ts); `?deny=chains` and `?fail=chains` refuse or fail
 * them, and `?topo=many` adds 280 nodes so the topology folds by country.
 * `?resultsMs=` slows monitor results; `?latencyMs=` slows the latency plan and rollups; `?rollupsMs=` slows the rollups alone (the map's layer reads until both answer). `?audit=old` answers audit reads as a
 * server from before exclude_action (the exclusions are ignored);
 * `?audit=capped` answers them as a scan that stopped at the cap. Writes change the in-memory state, so saving, disabling
 * and deleting can be driven end to end.
 * `?drop=<scopes>` removes those scopes from the principal while every read
 * still answers (`?drop=inventory:admin` draws a reader who may learn that a
 * console link is stored but may not reveal it).
 * `?machinesLate=<node ids>` enrolls those nodes as the first machines read
 * starts: neither that read nor a node list read before it has them, and
 * every read after it does (the Nodes page's next poll lists them).
 * `?machinesHidden=<node ids>` leaves them out of every machines read (no
 * inventory:read on those nodes) while the node list still has them.
 *
 * Only the calls these pages make are implemented; anything else is missing
 * from `api` and fails loudly.
 */
import { ApiError, reportUnauthorized } from "@/lib/api/client";
import type { AuditEvent, BeaconPlanRequest, CheckDefinition, CheckDefinitionSave, CheckDefinitionView, LatencyProbeConfig, LatencyWindow, MachineProfileInput, MachineView, MaintenanceWindowInput, MonitorCreateInput, MonitorHeader, MonitorUpdateInput, MonitorView, MonitorWindow, PathSeriesQuery, PathsResponse, Principal } from "@/lib/api/index";
import { canonicalHeaderName, monitorOrigin } from "@/views/fleet/checkRulesModel";
import { formatDay } from "@/views/fleet/inventoryEditorModel";
import { nextReminder } from "@/views/fleet/reminderModel";
import { sumTotals } from "@/views/fleet/upcomingModel";

import {
  AGENT_POLICIES,
  DAY,
  DDNS,
  GROUPS,
  MACHINES,
  MONITORS,
  NODES,
  PARAMS,
  SHAPE,
  auditEvents,
  expiringItems,
  iso,
  monitorLatest,
  monitorResults,
  sshGuardFor,
  taskCounts,
  tasksFor,
  ungrouped,
} from "./fleetFixture";
import { findIncident, incidentList, keepaliveNodeState, loopHealthFor, setWindows, updateIncident, windows } from "./keepaliveFixture";
import { EXTRA_NODES, SOURCE_NODE, generatedLatencyMonitors, initialConfig, planFor, probeFacts, rollupsFor, seriesFor } from "./latencyFixture";
import { lineChains } from "./topologyFixture";
import { M2B, REPLANS, beaconShape, runsBeaconClient } from "./beaconShapes";
import { appliedBeaconApproval, beaconReplansFor, beaconViewFor, planBeacon, rotateBeacon } from "./beaconFixture";
import { FLEET_MESH_ID, GOLDEN, MIGRATED, PATHS_SHAPE, goldenMonitors, goldenNodes, goldenPaths, goldenPlan, goldenSeries, operatorChecks, pathsFor, resultsFor, saveSettings, seriesFor as pathSeriesFor, settingsFor } from "./pathsFixture";
import { nodeHistory } from "./systemFixture";
import { SEED_LEFT_TARGET, definitionView, fleetMeshOf, planDefinition, runsOf, seedDefinitions } from "./definitionsFixture";
import type { MetricsRange } from "@/lib/api/systemTypes";

export * from "@/lib/api/index";

const LATENCY_MS = 70;

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const FAIL = new Map(
  (PARAMS.get("fail") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, when] = entry.split(":");
      return [name!, when === "later" ? "later" : "now"] as const;
    }),
);
const reads = new Map<string, number>();
const READ_COUNTS: Record<string, number> = ((window as unknown as { __harnessReads?: Record<string, number> }).__harnessReads = {});
const DENY = new Set((PARAMS.get("deny") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
const DENIED_SCOPES: Record<string, string> = { tasks: "task:read", approvals: "approval:read", audit: "audit:read", machines: "inventory:read", chains: "proxy:read", nodes: "node:read" };
const idList = (name: string) => new Set((PARAMS.get(name) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
const MACHINES_LATE = idList("machinesLate");
const MACHINES_HIDDEN = idList("machinesHidden");
/** Whether a node has enrolled yet, as the reads see it (`?machinesLate=`). */
const enrolled = (node: { id: string }) => !MACHINES_LATE.has(node.id) || (reads.get("machines") ?? 0) >= 1;
const DROPPED_SCOPES = idList("drop");

const EXPIRE_MS = Number(PARAMS.get("expire") ?? "");
let sessionEndsAt = EXPIRE_MS > 0 ? Date.now() + EXPIRE_MS : Number.POSITIVE_INFINITY;

/** The 401 the server sends once a session is gone, reported as the real client reports it. */
function sessionGone<T>(path: string, ms = LATENCY_MS): Promise<T> | undefined {
  if (Date.now() < sessionEndsAt) return undefined;
  return delay(undefined, ms).then(() => {
    reportUnauthorized(path);
    throw new ApiError(401, "unauthorized", "session expired");
  });
}

/** Answer, or fail the way `?fail=` asked for this read. */
function answer<T>(name: string, value: () => T, ms = LATENCY_MS): Promise<T> {
  const count = (reads.get(name) ?? 0) + 1;
  reads.set(name, count);
  READ_COUNTS[name] = count;
  const gone = sessionGone<T>(`/api/${name}`, ms);
  if (gone) return gone;
  if (DENY.has(name)) {
    return delay(undefined, ms).then(() => {
      throw new ApiError(403, "forbidden", `${name} read forbidden: missing scope`);
    });
  }
  const mode = FAIL.get(name) ?? FAIL.get("all");
  if (mode === "now" || (mode === "later" && count > 1)) {
    return delay(undefined, ms).then(() => {
      throw new ApiError(502, "bad_gateway", `${name} read failed: upstream timed out after 10s`);
    });
  }
  // A value that refuses the read (?m3=golden's notGolden) fails it the way a server would, after the delay.
  let body: T;
  try {
    body = value();
  } catch (error) {
    return delay(undefined, ms).then(() => {
      throw error;
    });
  }
  return delay(body, ms);
}

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: [
    "node:read",
    "node:admin",
    "approval:read",
    "task:read",
    "audit:read",
    "terminal:open",
    "group:read",
    "group:admin",
    "inventory:read",
    "inventory:admin",
    "monitor:read",
    "monitor:admin",
    // A beacon plan needs these beside monitor:admin and node:admin (design 29 D12); ?drop= takes them away.
    "network:plan",
    "network:apply",
    "netguard:admin",
    "ddns:admin",
    "sshguard:admin",
    "notify:admin",
    "proxy:read",
    "log:read",
  ].filter((scope) => !DROPPED_SCOPES.has(scope) && ![...DENY].some((name) => DENIED_SCOPES[name] === scope)),
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

// cd-hs-sh joins only on latency renders; every node, it included, carries
// the keepalive state and loop health the incidents fixture gives it.
let nodes = [...NODES, ...(SOURCE_NODE ? [SOURCE_NODE] : []), ...manyNodes(), ...EXTRA_NODES].map((node, index) => {
  // A node whose beacon binds a private address (NAT) reports that address as its primary interface's.
  const bind = M2B ? beaconShape(node.name).bind : undefined;
  const shaped = { ...node, ...(bind ? { internal_ip: bind } : {}), ...keepaliveNodeState(node), ...probeFacts(node) };
  return { ...shaped, loop_health: loopHealthFor(shaped, index) };
});

/**
 * `?many=N` (up to 2000) adds N copies of the located nodes, half on their
 * city's own point and half scattered across the land between 50S and 65N,
 * to time the map at fleet sizes well past production's 34.
 */
function manyNodes(): typeof NODES {
  const count = Math.max(0, Math.min(2000, Number(PARAMS.get("many")) || 0));
  const located = NODES.filter((node) => typeof node.geo?.lat === "number" && typeof node.geo?.lon === "number");
  if (!count || !located.length) return [];
  let seed = 17;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: count }, (_, i) => {
    const base = located[i % located.length]!;
    const piled = i % 2 === 0;
    const geo = piled ? base.geo : { ...base.geo, lat: -50 + random() * 115, lon: -180 + random() * 360, city: undefined };
    return { ...base, id: `many_${String(i).padStart(4, "0")}`, name: `${base.name ?? base.id}-x${i}`, geo };
  });
}
let latency = initialConfig();
let machines = MACHINES.map((machine) => ({ ...machine }));
let monitors = [...MONITORS, ...operatorChecks()].map((monitor) => ({ ...monitor }));

/**
 * `?paths=` (dev/pathsFixture.ts) answers the design 29 routes; `?paths=old`
 * answers them 404, as a server from before design 29 does. `?pathsMs=`
 * slows the paths read so the loading state can be drawn; `?fail=paths` and
 * `?fail=series` fail them.
 */
function missingRoute<T>(path: string): Promise<T> {
  return delay(undefined).then(() => {
    throw new ApiError(404, "not_found", `no route for ${path}`);
  });
}
const pathsOld = () => PATHS_SHAPE === "old";

function refuse<T>(status: number, code: string, message: string, field?: string): Promise<T> {
  return delay(undefined).then(() => {
    throw new ApiError(status, code, message, undefined, field ? { error: { code, message, field } } : undefined);
  });
}

/**
 * Design 32 R6 in the harness. `?refuse=<path>` refuses every check and
 * definition save with 400 naming that request field ("targets",
 * "interval_sec", "addresses[0]"), as the server does for a rule the console
 * cannot foresee. `?conflict=1` makes the first edit of each check or
 * definition lose a race: another operator renames it and changes its
 * interval, the version moves on, and the edit answers 409 version_conflict.
 */
const REFUSE_FIELD = PARAMS.get("refuse") ?? "";
const CONFLICT_ONCE = PARAMS.get("conflict") === "1";
const raced = new Set<string>();
function refusedSave<T>(): Promise<T> | undefined {
  if (!REFUSE_FIELD) return undefined;
  return refuse(400, "bad_request", `${REFUSE_FIELD} is refused by the harness (?refuse=)`, REFUSE_FIELD);
}

/**
 * Paths renders also answer design 32's check definitions
 * (dev/definitionsFixture.ts): two seeded definitions whose monitors join
 * the monitors list, as the server's expansion writes them, so the matrix
 * draws their paths. `?defs=none` starts with none, `?fail=definitions` fails
 * the read, `?fail=defsave` refuses a save the way the server refuses a
 * broad selector from a restricted token, and `?paths=old` answers the
 * routes 404, as a server from before design 32 does.
 */
const definitionNodes = () => nodes.map((n) => ({ id: n.id, name: n.name ?? n.id, public_ip: n.public_ip, online: n.online, probe_methods: n.probe_methods, probe_refusals: n.probe_refusals }));
const heldBy = (id: string) => monitors.filter((m) => m.check_definition_id === id);
const planOf = (def: CheckDefinition) => planDefinition(def, heldBy(def.id), definitionNodes(), GROUPS, new Date().toISOString());
function writeDefinition(def: CheckDefinition) {
  const plan = planOf(def);
  monitors = [...monitors.filter((m) => m.check_definition_id !== def.id), ...plan.monitors];
}
/** A definition as reads carry it: secret header values never leave the server. */
function shownDefinition(def: CheckDefinition, withMonitors: boolean) {
  const headers = def.headers?.map((h) => (h.secret ? { name: h.name, secret: true, set: true } : { name: h.name, value: h.value }));
  const origins = def.headers?.some((h) => h.secret) ? [...new Set((def.addresses ?? []).map((a) => monitorOrigin(a)).filter(Boolean))] : undefined;
  return definitionView({ ...def, ...(headers ? { headers } : {}), ...(origins ? { secrets_origins: origins as string[] } : {}) }, heldBy(def.id), planOf(def).preview, withMonitors);
}
function definitionFrom(input: CheckDefinitionSave, held: CheckDefinition | undefined): CheckDefinition {
  const { headers: ops, id: _id, version: _version, ...spec } = input;
  const now = new Date().toISOString();
  return {
    ...spec,
    name: spec.name.trim() || "Untitled check",
    id: held?.id ?? `chk_${Date.now().toString(36)}`,
    headers: ops?.length ? applyHeaderOps(held?.headers, ops) : held?.headers,
    version: (held?.version ?? 0) + 1,
    created_at: held?.created_at ?? now,
    updated_at: now,
    updated_by: "cdcd",
  };
}
let definitions: CheckDefinition[] =
  PARAMS.has("paths") && !pathsOld() && PATHS_SHAPE !== "empty" && PARAMS.get("defs") !== "none"
    ? seedDefinitions(definitionNodes(), GROUPS.map((g) => g.id), (ms) => new Date(Date.now() + ms).toISOString())
    : [];
for (const def of definitions) {
  // The ping measured Helsinki before Helsinki left its set: that monitor stays, paused, with its history.
  const left = definitionNodes().find((n) => n.name === SEED_LEFT_TARGET);
  if (def.id === "chk_apac_ping" && left) writeDefinition({ ...def, targets: { nodes: [...(def.targets.nodes ?? []), left.id] } });
  writeDefinition(def);
}

/**
 * Design 32 R1: the path set as the check definition it became. Its stored
 * form stays the harness's latency configuration, which the fake planner
 * reads, so an edit here (Stop measuring this pair, Switch to Auto, leave a
 * target out) moves the matrix the way the server's sync would. The region
 * rule reads as the whole fleet minus the nodes it leaves out.
 */
let meshVersion = 5;
function fleetMeshDefinition(): CheckDefinition {
  const c = latency.config;
  const plan = pathPlan();
  const leftOut = plan.nodes.filter((n) => n.target === "none" && ["mainland", "excluded", "region_unknown"].includes(n.target_reason ?? "")).map((n) => n.node_id);
  const type = (c.method === "auto" || c.method === "icmp" || c.method === "beacon" ? c.method : "tcp") as CheckDefinition["type"];
  return {
    id: FLEET_MESH_ID,
    name: "Fleet mesh",
    type,
    sources: { nodes: [...c.sources] },
    targets: c.auto_targets ? { all: true, exclude: [...new Set(leftOut)].sort() } : { nodes: [...(c.include_targets ?? [])] },
    interval_sec: c.interval_sec,
    timeout_sec: c.timeout_sec,
    ...(type === "tcp" ? {} : { packets: 3 }),
    alert: c.alert || "off",
    ...(c.alert_after ? { alert_after: c.alert_after } : {}),
    ...(c.degraded ? { degraded: c.degraded } : {}),
    enabled: c.enabled,
    ...(c.disabled_pairs?.length ? { excluded_pairs: c.disabled_pairs.map((p) => ({ ...p })) } : {}),
    version: meshVersion,
    created_at: "2026-10-24T10:00:00Z",
    updated_at: c.updated_at ?? "2026-10-24T10:00:00Z",
    updated_by: c.updated_by,
  };
}
function fleetMeshView(withMonitors: boolean): CheckDefinitionView {
  const plan = pathPlan();
  const held = generatedLatencyMonitors(plan);
  const active = plan.pairs.filter((p) => p.active).length;
  return {
    ...fleetMeshDefinition(),
    summary: { monitors: held.length, paths: active, paused_targets: 0, paused_runs: 0 },
    ...(withMonitors
      ? { monitors: held.map((m) => ({ monitor_id: m.id, method: m.type, target: m.target, target_node: m.target_node, in_set: true, enabled: m.enabled, sources: m.node_ids ?? [], runs: 1440 })) }
      : {}),
  };
}
/** A save of Fleet mesh, written back into the configuration the planner reads. */
function saveFleetMesh(input: CheckDefinitionSave): CheckDefinitionView {
  const plan = pathPlan();
  const mainland = new Set(plan.nodes.filter((n) => n.target_reason === "mainland" || n.target_reason === "region_unknown").map((n) => n.node_id));
  const c = latency.config;
  latency = {
    stored: true,
    config: {
      ...c,
      method: input.type === "tcp" ? "" : input.type,
      sources: [...(input.sources.nodes ?? c.sources)],
      exclude_targets: input.targets.all ? (input.targets.exclude ?? []).filter((id) => !mainland.has(id)) : c.exclude_targets,
      interval_sec: input.interval_sec,
      timeout_sec: input.timeout_sec,
      alert: typeof input.alert === "string" ? input.alert : c.alert,
      enabled: input.enabled,
      disabled_pairs: (input.excluded_pairs ?? []).map((p) => ({ ...p })),
      version: c.version + 1,
      updated_by: "cdcd",
      updated_at: new Date().toISOString(),
    },
  };
  meshVersion += 1;
  return fleetMeshView(true);
}

/** ?m3=golden: a read the golden responses do not hold fails, rather than answer something the server never sent. */
function notGolden(what: string): never {
  throw new ApiError(502, "bad_gateway", `the golden responses do not hold ${what}`);
}

/**
 * A check as the server answers it (design 29 M2a): a secret header's value
 * never leaves, its read carries `set` instead, and the origin secrets are
 * bound to is the server's to write.
 */
function viewOf(m: MonitorView): MonitorView {
  if (!m.headers?.length) return { ...m };
  const headers = m.headers.map((h) => (h.secret ? { name: h.name, secret: true, set: true } : { name: h.name, value: h.value }));
  return { ...m, headers, ...(headers.some((h) => h.secret) ? { secrets_origin: monitorOrigin(m.target) } : {}) };
}

/** Apply an edit's header operations in order, as the server does; a keep for a header that is gone is refused. */
function applyHeaderOps(held: MonitorHeader[] | undefined, ops: NonNullable<MonitorUpdateInput["headers"]>): MonitorHeader[] {
  let out = [...(held ?? [])];
  const same = (a: string, b: string) => canonicalHeaderName(a).toLowerCase() === canonicalHeaderName(b).toLowerCase();
  for (const op of ops) {
    const at = out.findIndex((h) => same(h.name, op.name));
    if (op.op === "keep" && at < 0) throw new ApiError(400, "invalid_request", `header ${op.name} is not on the check`);
    if (op.op === "delete") out = out.filter((_, i) => i !== at);
    if (op.op === "set") {
      const next: MonitorHeader = { name: canonicalHeaderName(op.name), value: op.value, ...(op.secret ? { secret: true } : {}) };
      out = at < 0 ? [...out, next] : out.map((h, i) => (i === at ? next : h));
    }
  }
  return out;
}

/** What a node target resolves to, as the server would: the public IPv4 for icmp, the line port for tcp. */
function resolveTarget(input: { type: string; target?: string; target_node?: string }): string {
  if (!input.target_node) return input.target ?? "";
  const node = nodes.find((n) => n.id === input.target_node);
  const planNode = pathPlan().nodes.find((n) => n.node_id === input.target_node);
  if (input.type === "icmp") return planNode?.icmp_target ?? node?.public_ip ?? "";
  return planNode?.endpoint ?? `${node?.public_ip ?? "203.0.113.1"}:443`;
}

/** Each source's newest run for a check on the paths renders, as the list carries it. */
function pathsLatest(monitorId: string) {
  const byNode = new Map<string, ReturnType<typeof resultsFor>>();
  for (const r of resultsFor(pathPlan(), monitors, monitorId)) byNode.set(r.node_id, [...(byNode.get(r.node_id) ?? []), r]);
  return [...byNode.entries()].map(([nodeId, rows]) => {
    const sorted = [...rows].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
    const newest = sorted[0]!;
    let streak = 0;
    for (const r of sorted) {
      if (r.success) break;
      streak += 1;
    }
    return { ...newest, node_id: nodeId, fail_streak: streak, since: sorted[Math.max(0, streak - 1)]!.at };
  });
}
const pathPlan = () => planFor(latency.config, latency.stored);

/** The sources that use a target's beacon now: the path set's beacon pairs and the beacon checks naming it, if their agents run the client. */
function currentBeaconSources(targetId: string): string[] {
  const runs = (id: string) => runsBeaconClient(nodes.find((n) => n.id === id)?.name);
  // D12: every path set source whose method for the target is auto or beacon, with the pair on, whichever method Auto picked.
  const setting = (source: string) => latency.config.source_methods?.[source] || latency.config.method || "tcp";
  const fromPlan = pathPlan()
    .pairs.filter((p) => p.target === targetId && p.enabled && latency.config.enabled && ["auto", "beacon"].includes(setting(p.source)))
    .map((p) => p.source);
  const fromChecks = monitors.filter((m) => m.type === "beacon" && m.enabled && m.target_node === targetId).flatMap((m) => m.node_ids ?? []);
  return [...new Set([...fromPlan, ...fromChecks])].filter(runs).sort();
}

/**
 * The server with the monitoring follow-ups names the beacons that need a
 * change plan in every paths read (REPLANS), each with the node.beacon
 * approval that waits for it, as the server's beaconReplans fills it in.
 * `?replansStale=1` serves a paths read older than a plan filed since (as
 * after a plan filed in another tab): the entries name no waiting approval,
 * and only the beacon read again for the action says one waits.
 */
function withReplans(response: PathsResponse): PathsResponse {
  if (!REPLANS) return response;
  const replans = beaconReplansFor(nodes, currentBeaconSources);
  const stale = PARAMS.get("replansStale") === "1";
  return { ...response, beacon_replans: stale ? replans.map(({ pending_approval_id: _waits, ...rest }) => rest) : replans };
}

function reachabilityCheck(): MonitorView {
  const target = nodes.find((n) => n.name === "[cd]-gomami-hk-turin-mini");
  const at = new Date(Date.now() - 40_000).toISOString();
  return {
    id: `mon_beaconr_${target?.id ?? "node_012"}`,
    name: `Beacon reachability of ${target?.name ?? "gomami"}`,
    type: "beacon",
    target: `${target?.public_ip ?? "203.0.113.21"}:45509`,
    target_node: target?.id,
    packets: 3,
    interval_sec: 60,
    timeout_sec: 2,
    node_ids: ["node_sh"],
    enabled: true,
    managed_by: "beacon",
    alert: "off",
    latest: [{ node_id: "node_sh", at, success: false, error: "no reply within 2s", fail_streak: 4, since: at, sent: 3, lost: 3 }],
  };
}

function beaconNode(nodeId: string) {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new ApiError(404, "not_found", "node not found");
  return node;
}

interface AuditParams {
  action?: string;
  decision?: string;
  node_id?: string;
  at_from?: string;
  exclude_action?: string;
  exclude_decision?: string;
  limit?: number;
  offset?: number;
}

function fieldMatches(value: string | undefined, want: string | undefined): boolean {
  if (!want) return true;
  if (want.endsWith("*")) return (value ?? "").startsWith(want.slice(0, -1));
  return value === want;
}

/** GET /api/audit with the filters the server applies inside its scan. */
function auditQuery(params: AuditParams = {}) {
  const auditMode = PARAMS.get("audit");
  const excludeActions = auditMode === "old" ? [] : (params.exclude_action ?? "").split(",").map((p) => p.trim().replace(/\*$/, "")).filter(Boolean);
  const excludeDecisions = new Set(auditMode === "old" ? [] : (params.exclude_decision ?? "").split(",").map((p) => p.trim()).filter(Boolean));
  const from = params.at_from ? Date.parse(params.at_from) : NaN;
  const matched = auditEvents().filter(
    (event: AuditEvent) =>
      fieldMatches(event.action, params.action) &&
      fieldMatches(event.decision, params.decision) &&
      fieldMatches(event.node_id, params.node_id) &&
      (Number.isNaN(from) || Date.parse(event.at) >= from) &&
      !excludeActions.some((prefix) => event.action.startsWith(prefix)) &&
      !excludeDecisions.has(event.decision),
  );
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  if (auditMode === "capped") return { events: matched.slice(offset, offset + limit), total: matched.length, limit, offset, scanned: 200_000, complete: false };
  return { events: matched.slice(offset, offset + limit), total: matched.length, limit, offset, scanned: matched.length + 1200, complete: true };
}

function machineFromInput(input: MachineProfileInput & { id?: string }, base?: MachineView): MachineView {
  const node = nodes.find((n) => n.id === input.node_id);
  return {
    ...(base ?? {}),
    ...input,
    id: input.id ?? base?.id ?? `mch_new_${Date.now().toString(36)}`,
    node_id: input.node_id,
    node_name: node?.name ?? input.node_id,
    online: node?.status === "online",
    updated_at: new Date().toISOString(),
  } as MachineView;
}

export const api = {
  auth: {
    me: () => sessionGone<Principal>("/api/me") ?? delay(principal),
    login: () => {
      sessionEndsAt = Number.POSITIVE_INFINITY;
      return delay({ ok: true });
    },
    ssoProviders: () => delay([]),
  },
  nodes: {
    // ?m3=golden: the path set's nodes, so the drawing holds only what the golden responses name.
    list: () => answer("nodes", () => ({ nodes: GOLDEN ? goldenNodes(nodes.find((n) => n.name === "[cd]-volcengine-shanghai") ?? nodes[0]!) : nodes.filter(enrolled).map((n) => ({ ...n })) })),
    beacon: {
      get: (nodeId: string) =>
        !M2B ? missingRoute("/api/nodes/beacon") : answer("beacon", () => beaconViewFor(beaconNode(nodeId), nodes, currentBeaconSources(nodeId)), Number(PARAMS.get("beaconMs")) || LATENCY_MS),
      plan: async (input: BeaconPlanRequest) => {
        if (!M2B) return missingRoute("/api/nodes/beacon/plan");
        await delay(undefined, 260);
        // ?deny=beaconplan: a source of the plan is a node this session may not read (D12).
        if (DENY.has("beaconplan")) throw new ApiError(403, "capability_denied", "forbidden: a source of this beacon is a node this token may not read");
        const outcome = await planBeacon(input, beaconNode(input.node_id), nodes, currentBeaconSources(input.node_id));
        // The server answers a blocked plan with its findings beside the error, as a plain string.
        if (!outcome.ok) throw new ApiError(outcome.status, String(outcome.status), outcome.message, undefined, outcome.findings ? { error: outcome.message, findings: outcome.findings } : undefined);
        return outcome.response;
      },
      rotate: async (nodeId: string) => {
        if (!M2B) return missingRoute("/api/nodes/beacon/rotate");
        await delay(undefined, 320);
        const outcome = rotateBeacon(beaconNode(nodeId));
        if (!outcome.ok) throw new ApiError(409, "409", outcome.message);
        return { node_id: nodeId, epoch: outcome.epoch };
      },
    },
    geo: () => answer("geo", () => ({ nodes: nodes.filter(enrolled).map((n) => ({ ...n })) })),
    // ?history=empty|disabled|unavailable|gaps shapes the node page's History card (dev/systemFixture.ts).
    history: (nodeId: string, range: MetricsRange) => {
      const mode = PARAMS.get("history");
      if (mode === "disabled" || mode === "unavailable") {
        READ_COUNTS.history = (READ_COUNTS.history ?? 0) + 1;
        return delay(undefined, LATENCY_MS).then(() => {
          // The server scrubs 5xx messages; the code tells the cases apart.
          throw new ApiError(503, mode === "disabled" ? "metrics_disabled" : "metrics_unavailable", "internal server error");
        });
      }
      return answer("history", () => nodeHistory(nodeId, range, mode));
    },
    duplicates: () => delay({ groups: SHAPE === "dense" ? [{ reason: "host_fingerprint", confidence: "high", signal: "machine-id", node_ids: [nodes[1]!.id, nodes[33]!.id] }] : [] }),
    disable: (id: string, disabled: boolean) => {
      nodes = nodes.map((n) => (n.id === id ? { ...n, disabled: disabled || undefined, status: disabled ? "disabled" : "online" } : n));
      return delay(undefined);
    },
    rotateToken: (id: string) => delay({ node_id: id, token: "lat_agent_harness_rotated_token_0000000000" }),
    enrollToken: (input: { name: string }) =>
      delay({ node_id: "node_new", token: "lat_enroll_harness", command: `curl -fsSL https://lattice.example.net/install.sh | sh -s -- --name ${input.name}`, commands: { linux: `curl -fsSL https://lattice.example.net/install.sh | sh -s -- --name ${input.name}`, manual: "lattice-agent --token lat_enroll_harness" } }),
    update: (input: { node_id: string; name?: string; tags?: string[]; role?: string; comment?: string }) => {
      nodes = nodes.map((n) => (n.id === input.node_id ? { ...n, ...input, id: n.id } : n));
      const node = nodes.find((n) => n.id === input.node_id)!;
      return delay({ ok: true, name: node.name, role: node.role ?? "", tags: node.tags ?? [], comment: node.comment });
    },
    // One live gate, allowed through the agent config (invented).
    nodeCapabilities: () => delay({ effective: [{ capability: "sing-box", enforced: true, allowed: true, source: "derived" }] }),
    capabilities: () => delay({ capabilities: [] }),
    deletePlan: () => delay({ mutated: false, monitors_stripped: 0, ddns: 1, groups: 1 }),
    resolveGeo: (id: string) => delay({ ...nodes.find((n) => n.id === id)! }),
    updateGeo: (id: string, geo: Record<string, unknown>) => {
      nodes = nodes.map((n) => (n.id === id ? { ...n, geo: { ...geo, source: "operator", updated_at: new Date().toISOString() } } : n));
      return delay({ ...nodes.find((n) => n.id === id)! });
    },
    clearGeo: (id: string) => {
      nodes = nodes.map((n) => (n.id === id ? { ...n, geo: undefined } : n));
      return delay({ ...nodes.find((n) => n.id === id)! });
    },
    // The shape the server renders: the installer and the binary from one
    // pinned release, named again as agent_version.
    reconfigureCommand: (input: { node_id: string }) => {
      const pin = "v0.3.9";
      const linux =
        `curl -fsSL --proto '=https' --tlsv1.2 'https://raw.githubusercontent.com/LatticeNet/lattice-node-agent/${pin}/scripts/install.sh' -o lattice-agent-install.sh && chmod +x lattice-agent-install.sh && ` +
        `set -a; for f in /opt/lattice/lattice-agent.env /opt/lattice/node-agent/agent.env /etc/lattice/agent.env; do [ -f "$f" ] && . "$f" && break; done; set +a; ` +
        `env LATTICE_SERVER='https://lattice.example.net' LATTICE_NODE_ID='${input.node_id}' LATTICE_AGENT_VERSION='${pin}' LATTICE_AGENT_ALLOW_EXEC='1' ./lattice-agent-install.sh`;
      const manual = `lattice-agent -server 'https://lattice.example.net' -node-id '${input.node_id}' -allow-exec`;
      return delay({ node_id: input.node_id, server_url: "https://lattice.example.net", command: linux, commands: { linux, manual }, agent_version: pin });
    },
    ipConfig: (input: { node_id: string }) => delay({ ...nodes.find((n) => n.id === input.node_id)! }),
    setDebug: (id: string, enabled: boolean, collect?: boolean) => {
      nodes = nodes.map((n) => (n.id === id ? { ...n, agent_debug: { enabled, collect: !!collect } } : n));
      return delay({ ...nodes.find((n) => n.id === id)! });
    },
    setCapability: () => delay({ ok: true }),
  },
  approvals: {
    counts: () =>
      answer("approvals", () => {
        const pending = SHAPE === "dense" ? 3 : 0;
        return { pending, approved: 0, stale: 0, applied: 1144, rejected: 207, dismissed: 0, total: 1351 + pending };
      }),
    list: () => answer("approvals", () => ({ approvals: [], total: 0, limit: 50, offset: 0 })),
    // The applied plan of a beacon, which the Beacon card reads for its NetGuard task (?deny=approvals refuses it).
    get: (id: string) =>
      answer("approvals", () => {
        const approval = appliedBeaconApproval(id, nodes);
        if (!approval) throw new ApiError(404, "not_found", "approval not found");
        return approval;
      }),
  },
  tasks: {
    counts: () => answer("counts", () => taskCounts()),
    listForNode: (nodeId: string) => answer("tasks", () => ({ tasks: tasksFor(nodeId) })),
    results: () => answer("tasks", () => ({ results: [] })),
  },
  audit: {
    query: (params?: AuditParams) => answer("audit", () => auditQuery(params)),
  },
  expiring: {
    list: (within = 30) =>
      answer("expiring", () => {
        // Machine rows follow the live profiles, so a recorded renewal moves its row.
        const items = expiringItems(within, machines);
        return { generated_at: new Date(Date.now() - 12_000).toISOString(), within_days: within, items, totals: sumTotals(items), hidden_kinds: [] };
      }),
  },
  ddns: {
    list: () => answer("ddns", () => DDNS.map((d) => ({ ...d }))),
  },
  agentUpdates: {
    list: () => delay({ policies: AGENT_POLICIES.map((p) => ({ ...p })) }),
    releases: () => delay({ latest: "0.3.9", releases: [] }),
  },
  groups: {
    list: () => answer("groups", () => ({ groups: GROUPS.map((g) => ({ ...g })), ungrouped: ungrouped() })),
    preview: (selector: { members?: string[] }) => delay({ node_ids: selector.members ?? [], count: selector.members?.length ?? 0 }),
    // Design 32 D3: the check definitions that name the group, as a source set or a target set.
    usedBy: (id: string) =>
      answer("usedBy", () => ({
        group_id: id,
        // One entry per definition: source, target, or source_and_target when both sets name it (a group mesh).
        used_by: definitions.flatMap((d) => {
          const source = !!d.sources.groups?.includes(id);
          const target = !!d.targets.groups?.includes(id);
          if (!source && !target) return [];
          return [{ kind: "check" as const, id: d.id, label: d.name, role: source && target ? "source_and_target" : source ? "source" : "target" }];
        }),
        hidden: 0,
      })),
    // A new group gets an id the way the server gives one; an edit keeps its own.
    upsert: (input: { id?: string; name: string }) => {
      const held = GROUPS.find((g) => g.id === input.id);
      if (held) return delay({ ...held, ...input, id: held.id });
      const created = { ...GROUPS[0]!, members: [], ...input, id: `grp_${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, system: false };
      GROUPS.push(created);
      return delay(created);
    },
    delete: (id: string) => {
      const index = GROUPS.findIndex((g) => g.id === id);
      if (index >= 0) GROUPS.splice(index, 1);
      return delay({ ok: true });
    },
  },
  sshGuard: {
    status: (ids?: string[]) =>
      delay({ ok: true, nodes: (ids ?? nodes.map((n) => n.id)).map(sshGuardFor).filter(Boolean), node: ids?.length === 1 ? sshGuardFor(ids[0]!) : undefined }),
  },
  machines: {
    list: () =>
      answer("machines", () => ({
        machines: machines
          .filter((m) => !MACHINES_HIDDEN.has(m.node_id) && !(MACHINES_LATE.has(m.node_id) && reads.get("machines") === 1))
          .map((m) => ({ ...m })),
      })),
    create: (input: MachineProfileInput) => {
      const created = machineFromInput(input);
      machines = [...machines, created];
      return delay(created);
    },
    update: (input: MachineProfileInput & { id: string }) => {
      const base = machines.find((m) => m.id === input.id);
      const updated = machineFromInput(input, base);
      machines = machines.map((m) => (m.id === input.id ? updated : m));
      return delay(updated);
    },
    delete: (id: string) => {
      machines = machines.filter((m) => m.id !== id);
      return delay({ ok: true });
    },
    renew: (id: string, next?: string) => {
      const due = next ?? iso(30 * DAY);
      const today = Date.parse(`${formatDay(new Date())}T00:00:00Z`);
      const days = Math.round((Date.parse(due) - today) / DAY);
      machines = machines.map((m) => (m.id === id ? { ...m, next_renewal: due, days_until_renewal: days } : m));
      return delay({ ...machines.find((m) => m.id === id)! });
    },
    // What the server would send on this run: the machines whose next reminder is today.
    runReminders: (id?: string) => {
      const today = formatDay(new Date());
      const fired = machines
        .filter((m) => (!id || m.id === id) && m.id)
        .flatMap((m) => {
          const next = nextReminder(m, today);
          return next && next.inDays === 0 ? [{ machine_id: m.id!, node_id: m.node_id, node_name: m.node_name, offset_days: next.offset, next_renewal: next.renewal }] : [];
        });
      return delay({ fired });
    },
    revealLink: () => delay({ url: "https://console.example.net/servers/123" }),
  },
  // Any code passes, so the step-up in front of a stored machine link can be
  // driven end to end; the grant lasts five minutes like a short real one.
  security: {
    stepUp: () => delay({ ok: true, grant: "harness_step_up_grant", expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }),
  },
  machineVendors: {
    list: () => delay({ vendors: [{ id: "vnd_dmit", name: "DMIT", url: "https://www.dmit.io" }] }),
    upsert: (input: { name: string }) => delay({ vendor: { id: `vnd_${input.name}`, ...input } }),
  },
  notify: {
    channels: () =>
      delay([
        { id: "nch_bark_urgent", name: "Bark urgent", kind: "bark", config_keys: ["base_url", "key", "level"], enabled: true, created_at: iso(-60 * DAY), updated_at: iso(-20 * DAY) },
        { id: "nch_bark_info", name: "Bark info", kind: "bark", config_keys: ["base_url", "key", "group"], enabled: true, created_at: iso(-40 * DAY), updated_at: iso(-9 * DAY) },
      ]),
    rules: () =>
      delay({
        rules: [
          { id: "nrl_alerts", name: "Alerts", event_types: ["monitor.down", "proxy.quota", "ssh.compromise_suspected", "node.offline"], channel_ids: ["nch_bark_urgent"], enabled: true, created_at: iso(-60 * DAY), updated_at: iso(-20 * DAY) },
          { id: "nrl_routine", name: "Routine", event_types: ["inventory.renewal", "monitor.recovered"], channel_ids: ["nch_bark_info"], enabled: true, created_at: iso(-40 * DAY), updated_at: iso(-9 * DAY) },
          { id: "nrl_logins", name: "Logins", event_types: ["ssh.login"], channel_ids: ["nch_bark_info"], enabled: true, created_at: iso(-40 * DAY), updated_at: iso(-9 * DAY) },
          { id: "nrl_all", name: "Everything (paused)", event_types: ["*"], channel_ids: ["nch_bark_urgent"], enabled: false, created_at: iso(-90 * DAY), updated_at: iso(-30 * DAY) },
        ],
      }),
  },
  incidents: {
    list: () => answer("incidents", () => incidentList()),
    ack: (id: string) => {
      const incident = findIncident(id);
      if (!incident) return delay(undefined).then(() => { throw new ApiError(404, "not_found", "incident not found"); });
      if (incident.state !== "open") return delay(undefined).then(() => { throw new ApiError(409, "conflict", `incident is ${incident.state}, not open`); });
      return delay(updateIncident(id, { state: "acknowledged", acked_by: principal.username, acked_at: new Date().toISOString() }));
    },
    unack: (id: string) => {
      const incident = findIncident(id);
      if (!incident) return delay(undefined).then(() => { throw new ApiError(404, "not_found", "incident not found"); });
      if (incident.state !== "open" && incident.state !== "acknowledged") return delay(undefined).then(() => { throw new ApiError(409, "conflict", "only an open incident can be un-acknowledged"); });
      return delay(updateIncident(id, { state: "open", acked_by: undefined, acked_at: undefined }));
    },
    snooze: (id: string, minutes: number) => {
      const incident = findIncident(id);
      if (!incident) return delay(undefined).then(() => { throw new ApiError(404, "not_found", "incident not found"); });
      const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : undefined;
      return delay(updateIncident(id, { snoozed_until: until, snoozed_by: until ? principal.username : undefined }));
    },
  },
  maintenance: {
    list: () => answer("maintenance", () => ({ windows: windows.map((w) => ({ ...w })), now: new Date().toISOString() })),
    upsert: (input: MaintenanceWindowInput) => {
      const now = new Date().toISOString();
      const held = windows.find((w) => w.id === input.id);
      const next = {
        ...(held ?? { id: `mw_${Date.now().toString(36)}`, created_by: principal.username, created_at: now }),
        name: input.name,
        reason: input.reason,
        node_ids: input.node_ids ?? [],
        group_ids: input.group_ids ?? [],
        starts_at: input.starts_at ?? held?.starts_at ?? now,
        ends_at: input.ends_at,
        updated_at: now,
      };
      setWindows(held ? windows.map((w) => (w.id === next.id ? next : w)) : [...windows, next]);
      return delay({ ...next });
    },
    delete: (id: string) => {
      setWindows(windows.filter((w) => w.id !== id));
      return delay({ ok: true });
    },
  },
  monitors: {
    // Each node's newest result rides on the list, as the server sends it.
    // On latency renders the list also carries the generated latency monitors, as the server sends them.
    list: () =>
      // ?m3=golden: GET /api/monitors as the server answered it, a bare array.
      GOLDEN ? answer("monitors", () => goldenMonitors()) : answer("monitors", () => ({
        monitors: [
          ...monitors.map((m) => ({ ...viewOf(m), latest: PARAMS.has("paths") ? pathsLatest(m.id) : monitorLatest(m.id) })),
          ...(PARAMS.has("latency") || PARAMS.has("paths")
            ? generatedLatencyMonitors(planFor(latency.config, latency.stored)).map((m) => ({
                ...m,
                ...(PARAMS.has("paths") ? { latest: pathsLatest(m.id) } : {}),
                // Adopted by Fleet mesh: the path set's mark stays, the definition is named beside it (design 32 R1).
                ...(MIGRATED && PARAMS.has("paths") ? { check_definition_id: FLEET_MESH_ID } : {}),
              }))
            : []),
          // A beacon's reachability check (design 29 D12), still running and failing: the console must list it nowhere.
          ...(M2B && PARAMS.has("paths") ? [reachabilityCheck()] : []),
        ],
      })),
    // `?resultsMs=<ms>` slows the results read, so a sheet swapped to another monitor can be seen mid-read.
    results: (id: string) =>
      answer("monitors", () => ({ results: GOLDEN ? [] : PARAMS.has("paths") ? resultsFor(pathPlan(), monitors, id) : monitorResults(id) }), Number(PARAMS.get("resultsMs")) || LATENCY_MS),
    paths: (window: MonitorWindow) =>
      GOLDEN
        ? answer("paths", () => goldenPaths(window) ?? notGolden(`the paths read for window ${window}`))
        : pathsOld()
          ? missingRoute("/api/monitors/paths")
          : answer("paths", () => withReplans(pathsFor(pathPlan(), window, monitors)), Number(PARAMS.get("pathsMs")) || LATENCY_MS),
    series: (query: PathSeriesQuery) =>
      GOLDEN
        ? answer("series", () => goldenSeries(query) ?? notGolden(`the series of ${query.source || "the control plane"} to ${query.target_node ?? query.monitor} over ${query.window}`))
        : pathsOld()
          ? missingRoute("/api/monitors/series")
          : answer("series", () => pathSeriesFor(pathPlan(), monitors, query)),
    settings: {
      get: () =>
        GOLDEN
          ? answer("settings", () => settingsFor(goldenPaths("1h")!.paths.length))
          : pathsOld() || !PARAMS.has("paths")
            ? missingRoute("/api/monitors/settings")
            : answer("settings", () => settingsFor(pathsFor(pathPlan(), "1h", monitors).paths.length)),
      update: (input: { version: number; fine_retention_days: number }) => {
        const saved = saveSettings(input.version, input.fine_retention_days);
        if (saved === "conflict") {
          return delay(undefined).then(() => {
            throw new ApiError(409, "conflict", "monitoring settings changed since they were read");
          });
        }
        return delay(saved);
      },
    },
    update: (input: MonitorUpdateInput) => {
      if (pathsOld()) return missingRoute("/api/monitors/update");
      const held = monitors.find((m) => m.id === input.id);
      if (!held) return delay(undefined).then(() => { throw new ApiError(404, "not_found", "monitor not found"); });
      if (held.managed_by) return refuse(409, "conflict", "generated checks are changed through the path set");
      if (CONFLICT_ONCE && !raced.has(held.id)) {
        raced.add(held.id);
        const theirs = { ...held, name: `${held.name || held.id} (theirs)`, interval_sec: (held.interval_sec ?? 30) + 30, version: (held.version ?? 0) + 1, updated_at: new Date().toISOString() } as MonitorView;
        monitors = monitors.map((m) => (m.id === held.id ? theirs : m));
        return refuse(409, "version_conflict", "monitor changed since it was read");
      }
      if (input.version !== (held.version ?? 0)) return refuse(409, "version_conflict", "monitor changed since it was read");
      const refused = refusedSave<MonitorView>();
      if (refused) return refused;
      const { id: _id, version: _version, headers: ops, ...fields } = input;
      let headers: MonitorHeader[] | undefined;
      try {
        headers = ops?.length ? applyHeaderOps(held.headers, ops) : held.headers;
      } catch (error) {
        return delay(undefined).then(() => {
          throw error;
        });
      }
      const updated = { ...held, ...fields, ...(headers ? { headers } : {}), version: (held.version ?? 0) + 1, updated_at: new Date().toISOString() } as MonitorView;
      monitors = monitors.map((m) => (m.id === input.id ? updated : m));
      return delay(viewOf(updated));
    },
    create: (input: MonitorCreateInput) => {
      // `?fail=create` refuses the save the way the server refuses a node it cannot resolve, a refusal the console cannot foresee.
      const refused = refusedSave<MonitorView>();
      if (refused) return refused;
      if (FAIL.has("create")) {
        const message = input.target_node
          ? `node ${input.target_node} has no public tcp line to connect to: it serves no public TCP line the probe may dial (never SSH or a knock-gated port)`
          : `target ${input.target ?? ""} is an address in a numeric form; write it as a dotted IPv4 or an IPv6 literal`;
        return delay(undefined).then(() => {
          throw new ApiError(400, "invalid_request", message);
        });
      }
      const created = { ...input, target: resolveTarget(input), id: `mon_${Date.now().toString(36)}`, enabled: true, created_at: new Date().toISOString(), ...(PARAMS.has("paths") && !pathsOld() ? { version: 1 } : {}) } as MonitorView;
      if (created.headers) created.headers = created.headers.map((h) => ({ ...h, name: canonicalHeaderName(h.name) }));
      monitors = [...monitors, created];
      return delay(viewOf(created));
    },
    delete: (id: string) => {
      monitors = monitors.filter((m) => m.id !== id);
      return delay({ ok: true });
    },
    definitions: {
      list: () =>
        pathsOld()
          ? missingRoute("/api/monitors/definitions")
          : answer("definitions", () => ({
              definitions: [...(MIGRATED && PARAMS.has("paths") ? [fleetMeshView(false)] : []), ...definitions.map((d) => shownDefinition(d, false))],
              fleet_mesh: { ...fleetMeshOf(planFor(latency.config, latency.stored), latency.stored), ...(MIGRATED && PARAMS.has("paths") ? { migrated: true, definitions: [FLEET_MESH_ID] } : {}) },
            })),
      get: (id: string) => {
        if (id === FLEET_MESH_ID && MIGRATED) return answer("definitions", () => fleetMeshView(true));
        const def = definitions.find((d) => d.id === id);
        return def ? answer("definitions", () => shownDefinition(def, true)) : refuse(404, "not_found", "check definition not found");
      },
      preview: (input: CheckDefinitionSave) => {
        const held = definitions.find((d) => d.id === input.id);
        return delay(planOf(definitionFrom(input, held)).preview, Number(PARAMS.get("previewMs")) || LATENCY_MS);
      },
      create: (input: CheckDefinitionSave) => {
        const refused = refusedSave<CheckDefinitionView>();
        if (refused) return refused;
        if (FAIL.has("defsave")) return refuse(403, "forbidden", "a group or whole-fleet selector requires an unrestricted principal; name the nodes instead");
        const def = definitionFrom(input, undefined);
        definitions = [...definitions, def];
        writeDefinition(def);
        return delay(shownDefinition(def, true));
      },
      update: (input: CheckDefinitionSave) => {
        if (input.id === FLEET_MESH_ID && MIGRATED) {
          if (CONFLICT_ONCE && !raced.has(FLEET_MESH_ID)) {
            raced.add(FLEET_MESH_ID);
            latency = { ...latency, config: { ...latency.config, interval_sec: latency.config.interval_sec + 30, updated_by: "operator-b", updated_at: new Date().toISOString() } };
            meshVersion += 1;
            return refuse(409, "version_conflict", "check definition changed since it was read");
          }
          if (input.version !== meshVersion) return refuse(409, "version_conflict", "check definition changed since it was read");
          const refused = refusedSave<CheckDefinitionView>();
          if (refused) return refused;
          return delay(saveFleetMesh(input));
        }
        const held = definitions.find((d) => d.id === input.id);
        if (!held) return refuse(404, "not_found", "check definition not found");
        if (CONFLICT_ONCE && !raced.has(held.id)) {
          raced.add(held.id);
          const theirs = { ...held, name: `${held.name} (theirs)`, interval_sec: held.interval_sec + 30, version: held.version + 1, updated_by: "operator-b", updated_at: new Date().toISOString() };
          definitions = definitions.map((d) => (d.id === held.id ? theirs : d));
          writeDefinition(theirs);
          return refuse(409, "version_conflict", "check definition changed since it was read");
        }
        if (input.version !== held.version) return refuse(409, "version_conflict", "check definition changed since it was read");
        const refused = refusedSave<CheckDefinitionView>();
        if (refused) return refused;
        if (FAIL.has("defsave")) return refuse(403, "forbidden", "a group or whole-fleet selector requires an unrestricted principal; name the nodes instead");
        const def = definitionFrom(input, held);
        definitions = definitions.map((d) => (d.id === def.id ? def : d));
        writeDefinition(def);
        return delay(shownDefinition(def, true));
      },
      delete: (input: { id: string; version: number; monitor_ids: string[] }) => {
        const held = definitions.find((d) => d.id === input.id);
        if (!held) return refuse(404, "not_found", "check definition not found");
        const ids = heldBy(input.id).map((m) => m.id).sort();
        if (input.version !== held.version || ids.join() !== [...input.monitor_ids].sort().join()) {
          return refuse(409, input.version !== held.version ? "version_conflict" : "conflict", "the definition or its monitors changed since they were read");
        }
        monitors = monitors.filter((m) => m.check_definition_id !== input.id);
        definitions = definitions.filter((d) => d.id !== input.id);
        return delay({ ok: true, deleted: ids, runs: ids.reduce((n, id) => n + runsOf(id), 0) });
      },
      forget: (input: { id: string; monitor_ids: string[] }) => {
        const held = definitions.find((d) => d.id === input.id);
        if (!held) return refuse(404, "not_found", "check definition not found");
        const inSet = new Set(planOf(held).preview.targets.map((t) => t.monitor_id));
        const still = input.monitor_ids.find((id) => inSet.has(id));
        if (still) return refuse(409, "conflict", `monitor ${still} is still in the definition's target set`);
        const gone = new Set(input.monitor_ids);
        monitors = monitors.filter((m) => !(m.check_definition_id === input.id && gone.has(m.id)));
        return delay({ ok: true, forgotten: [...gone], runs: [...gone].reduce((n, id) => n + runsOf(id), 0) });
      },
    },
    latency: {
      // `?latencyMs=<ms>` slows the plan and rollups reads, so the loading state can be drawn.
      plan: () =>
        answer(
          "latency",
          () => {
            if (GOLDEN) return goldenPlan();
            const plan = planFor(latency.config, latency.stored);
            // Migrated, the path set reads as such: it names the definitions it became and is not edited (design 32 R1).
            return MIGRATED && PARAMS.has("paths") ? { ...plan, config: { ...plan.config, migrated: { at: "2026-10-24T10:00:00Z", definitions: [FLEET_MESH_ID] } } } : plan;
          },
          Number(PARAMS.get("latencyMs")) || LATENCY_MS,
        ),
      rollups: () =>
        answer("latency", () => rollupsFor(planFor(latency.config, latency.stored)), Number(PARAMS.get("rollupsMs")) || Number(PARAMS.get("latencyMs")) || LATENCY_MS),
      series: (source: string, target: string, window: LatencyWindow) =>
        answer("latency", () => seriesFor(planFor(latency.config, latency.stored), source, target, window)),
      // A save names the version it was read at, as the server requires.
      save: (config: LatencyProbeConfig) => {
        if (config.version !== latency.config.version) {
          return delay(undefined).then(() => {
            throw new ApiError(409, "request_failed", "latency probe configuration changed since it was read");
          });
        }
        latency = { config: { ...config, version: latency.config.version + 1, updated_by: "cdcd", updated_at: new Date().toISOString() }, stored: true };
        return delay(planFor(latency.config, true));
      },
    },
  },
  capabilities: {
    // Two of the gates production has; counts are invented.
    list: () =>
      delay({
        capabilities: [
          { capability: "exec", enforced: false, mutates: true, derived: true, allow_count: 30, refuse_count: 4 },
          { capability: "terminal", enforced: true, mutates: true, derived: true, allow_count: 32, refuse_count: 2 },
        ],
      }),
    setEnforced: (capability: string, enforced: boolean) => delay({ capability, enforced, mutates: true, derived: true, allow_count: 30, refuse_count: 4 }),
  },
  // Monitoring's Topology reads the relay to exit routes (dev/topologyFixture.ts).
  proxy: {
    lineChains: () => answer("chains", () => ({ chains: GOLDEN ? [] : lineChains() })),
  },
  plugins: {
    // vpn-core is installed in production; the node sheet links to its Lines.
    contributions: () => delay([{ id: "latticenet.vpn-core", name: "vpn-core", version: "0.9.0-alpha.1", status: "active", active: true, ui: { nav: [] } }]),
  },
} as unknown as typeof import("@/lib/api/index").api;
