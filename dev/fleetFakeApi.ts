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
 * (the stale state). Writes change the in-memory state, so saving, disabling
 * and deleting can be driven end to end.
 *
 * Only the calls these pages make are implemented; anything else is missing
 * from `api` and fails loudly.
 */
import { ApiError } from "@/lib/api/client";
import type { AuditEvent, MachineProfileInput, MachineView, MonitorCreateInput, MonitorView, Principal } from "@/lib/api/index";
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
  monitorResults,
  sshGuardFor,
  taskCounts,
  tasksFor,
  ungrouped,
} from "./fleetFixture";

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

/** Answer, or fail the way `?fail=` asked for this read. */
function answer<T>(name: string, value: () => T, ms = LATENCY_MS): Promise<T> {
  const count = (reads.get(name) ?? 0) + 1;
  reads.set(name, count);
  const mode = FAIL.get(name) ?? FAIL.get("all");
  if (mode === "now" || (mode === "later" && count > 1)) {
    return delay(undefined, ms).then(() => {
      throw new ApiError(502, "bad_gateway", `${name} read failed: upstream timed out after 10s`);
    });
  }
  return delay(value(), ms);
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
    "ddns:admin",
    "sshguard:admin",
    "notify:admin",
    "proxy:read",
    "log:read",
  ],
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

let nodes = NODES.map((node) => ({ ...node }));
let machines = MACHINES.map((machine) => ({ ...machine }));
let monitors = MONITORS.map((monitor) => ({ ...monitor }));

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
  const excludeActions = (params.exclude_action ?? "").split(",").map((p) => p.trim().replace(/\*$/, "")).filter(Boolean);
  const excludeDecisions = new Set((params.exclude_decision ?? "").split(",").map((p) => p.trim()).filter(Boolean));
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
    me: () => delay(principal),
  },
  nodes: {
    list: () => answer("nodes", () => ({ nodes: nodes.map((n) => ({ ...n })) })),
    geo: () => answer("geo", () => ({ nodes: nodes.map((n) => ({ ...n })) })),
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
    reconfigureCommand: (input: { node_id: string }) => delay({ node_id: input.node_id, server_url: "https://lattice.example.net", command: "lattice-agent reconfigure --harness" }),
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
        const items = expiringItems(within);
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
    upsert: (input: { id?: string; name: string }) => delay({ ...(GROUPS.find((g) => g.id === input.id) ?? GROUPS[0]!), ...input }),
    delete: () => delay({ ok: true }),
  },
  sshGuard: {
    status: (ids?: string[]) =>
      delay({ ok: true, nodes: (ids ?? nodes.map((n) => n.id)).map(sshGuardFor).filter(Boolean), node: ids?.length === 1 ? sshGuardFor(ids[0]!) : undefined }),
  },
  machines: {
    list: () => answer("machines", () => ({ machines: machines.map((m) => ({ ...m })) })),
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
      machines = machines.map((m) => (m.id === id ? { ...m, next_renewal: next ?? iso(30 * DAY), days_until_renewal: 30 } : m));
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
  monitors: {
    list: () => answer("monitors", () => ({ monitors: monitors.map((m) => ({ ...m })) })),
    results: (id: string) => answer("monitors", () => ({ results: monitorResults(id) })),
    create: (input: MonitorCreateInput) => {
      const created = { ...input, id: `mon_${Date.now().toString(36)}`, enabled: true, created_at: new Date().toISOString() } as MonitorView;
      monitors = [...monitors, created];
      return delay(created);
    },
    delete: (id: string) => {
      monitors = monitors.filter((m) => m.id !== id);
      return delay({ ok: true });
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
  plugins: {
    // vpn-core is installed in production; the node sheet links to its Lines.
    contributions: () => delay([{ id: "latticenet.vpn-core", name: "vpn-core", version: "0.9.0-alpha.1", status: "active", active: true, ui: { nav: [] } }]),
  },
} as unknown as typeof import("@/lib/api/index").api;
