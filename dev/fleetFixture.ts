/**
 * The fleet as production held it on 2026-09-30, for the Home and Fleet
 * harness (dev/fleet*.html): 34 nodes (32 online, 2 offline, 4 agent
 * versions), 34 machines billed in CHY and USD with 8 free, 3 groups, 0
 * monitors, 22 DDNS profiles (2 failing), 33 agent-update policies, 1,771
 * tasks (1 stalled). Counts come from FACTS.md; names follow production's
 * owner prefixes and tags, and everything a count does not pin (addresses,
 * CPU, coordinates, prices, which two DDNS profiles fail, the 24-hour task
 * figures, the flips) is invented and marked so.
 *
 * `?fleet=` picks the shape:
 *   prod (default)  the counts above
 *   dense           every state the pages must tell apart at once: a degraded,
 *                   a never-reported and a disabled node, three approvals
 *                   waiting, due and overdue renewals, a second stalled task
 *   empty           nothing enrolled (first run)
 * `?monitors=some` gives Monitoring an HTTP and a TLS monitor with results;
 * with `?topo=many` it adds a check run from three of the invented US nodes,
 * so the folded Topology draws a check bundle out of one country.
 * `?monitors=many` gives sixty, past the fifty the list once read one by one:
 * three failing and one whose results stopped arriving (names and targets
 * invented).
 *
 * Dates are relative to now so the shape holds on any day.
 */
import type {
  AgentUpdatePolicy,
  AuditEvent,
  DDNSView,
  ExpiringItem,
  GroupView,
  MachineView,
  MonitorLatest,
  MonitorResult,
  MonitorView,
  Node,
  NodeStatus,
  SSHGuardNodeStatus,
  TaskView,
} from "@/lib/api/index";

export const PARAMS = new URLSearchParams(window.location.search);
export const SHAPE = (PARAMS.get("fleet") ?? "prod") as "prod" | "dense" | "empty";
export const NOW = Date.now();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function todayUtc(): number {
  const now = new Date(NOW);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export function dateIn(days: number): string {
  return new Date(todayUtc() + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

type Place = [country: string, region: string, city: string, lat: number, lon: number];
const LA: Place = ["US", "California", "Los Angeles", 34.05, -118.24];
const SJ: Place = ["US", "California", "San Jose", 37.34, -121.89];
const HI: Place = ["US", "Hawaii", "Honolulu", 21.31, -157.86];
const TYO: Place = ["JP", "Tokyo", "Tokyo", 35.68, 139.69];
const OSA: Place = ["JP", "Osaka", "Osaka", 34.69, 135.5];
const HKG: Place = ["HK", "Hong Kong", "Hong Kong", 22.32, 114.17];
const SGP: Place = ["SG", "Singapore", "Singapore", 1.35, 103.82];
const SHA: Place = ["CN", "Shanghai", "Shanghai", 31.23, 121.47];
const HEB: Place = ["CN", "Hebei", "Langfang", 39.52, 116.7];
const FSN: Place = ["DE", "Saxony", "Falkenstein", 50.48, 12.37];
const HEL: Place = ["FI", "Uusimaa", "Helsinki", 60.17, 24.94];
const LON: Place = ["GB", "England", "London", 51.5, -0.12];
const SYD: Place = ["AU", "NSW", "Sydney", -33.87, 151.2];

interface Entry {
  name: string;
  tags: string[];
  place?: Place;
  version: string;
  status?: NodeStatus;
  /** Offline or otherwise out of the ordinary since this long ago. */
  sinceMs?: number;
  reason?: string;
  cpu?: number;
  os?: string;
  arch?: string;
  /** Monthly-ish price for the machine, in cents, with its currency and cycle. */
  price?: [cents: number, currency: "CHY" | "USD", cycle: string];
  /** Days until the next renewal. */
  due?: number;
  auto?: boolean;
  vendor?: string;
  quiet?: boolean;
  /** Agent runs tasks as root (invented). */
  root?: boolean;
  /** Agent refuses terminal sessions (invented). */
  noTerminal?: boolean;
}

// Tags follow FACTS.md (cd 16, Metix 13, VDS 12, HOME 11, 三网优化 8, Aaitr 6,
// openjobs-vpn 6, DMIT 6, NAT 5, OpenJobs-Data 5, AWS 5). Prices, dates,
// vendors, places and CPU are invented.
const FLEET: Entry[] = [
  { name: "[cd]-DMIT-pro-malibu", tags: ["cd", "VDS", "DMIT", "三网优化"], place: LA, version: "0.3.9", cpu: 41, price: [3990, "USD", "annual"], due: 93, auto: true, vendor: "DMIT" },
  { name: "[cd]-mac-air", tags: ["cd", "HOME"], place: SHA, version: "0.3.9", cpu: 23, os: "macOS 15.6", arch: "arm64" },
  { name: "[cd]-homeserver", tags: ["cd", "HOME", "NAT"], version: "0.3.9", cpu: 12, vendor: "China Telecom", root: true },
  { name: "[cd]-hetzner-fsn", tags: ["cd", "HOME"], place: FSN, version: "0.3.9", cpu: 14, price: [550, "USD", "monthly"], due: 9, auto: true, vendor: "Hetzner" },
  { name: "[cd]-hetzner-hel", tags: ["cd", "HOME"], place: HEL, version: "0.3.8", cpu: 10, price: [550, "USD", "monthly"], due: 9, auto: true, vendor: "Hetzner" },
  { name: "[cd]-racknerd-la", tags: ["cd", "VDS"], place: LA, version: "0.3.9", cpu: 21, os: "AlmaLinux 9", price: [3000, "USD", "annual"], due: 76, auto: true, vendor: "RackNerd" },
  { name: "[cd]-bandwagon-dc6", tags: ["cd", "VDS", "三网优化"], place: LA, version: "0.3.9", cpu: 33, price: [4999, "USD", "quarterly"], due: 19, auto: true, vendor: "BandwagonHost" },
  { name: "[cd]-vultr-syd", tags: ["cd", "HOME"], place: SYD, version: "0.3.9", cpu: 12, price: [600, "USD", "monthly"], due: 25, auto: true, vendor: "Vultr" },
  { name: "[cd]-linode-sgp", tags: ["cd", "HOME"], place: SGP, version: "0.3.9", cpu: 17, price: [2800, "USD", "monthly"], due: 25, auto: true, vendor: "Linode" },
  { name: "[cd]-Akkocloud-UK-London-KVM", tags: ["cd", "VDS"], place: LON, version: "0.3.9", cpu: 26, os: "Ubuntu 24.04", price: [29800, "CHY", "annual"], due: 293, auto: true, vendor: "AkkoCloud" },
  { name: "[cd]-Oracle-KIX-arm", tags: ["cd", "HOME"], place: OSA, version: "0.3.6", cpu: 5, arch: "arm64", vendor: "Oracle" },
  { name: "[cd]-gomami-hk-turin-mini", tags: ["cd", "三网优化"], place: HKG, version: "0.3.9", cpu: 22, price: [2900, "USD", "monthly"], due: 18, vendor: "Turin", quiet: true },
  { name: "[cd]-qqpw-vds-cd1", tags: ["cd", "VDS"], place: HI, version: "0.3.9", cpu: 31, price: [3500, "USD", "monthly"], due: 28, auto: true, vendor: "QQPW" },
  { name: "[cd]-volcengine-shanghai", tags: ["cd", "HOME"], place: SHA, version: "0.3.9", cpu: 18, price: [2890, "CHY", "monthly"], due: 11, auto: true, vendor: "火山云" },
  { name: "[cd]-xuezhang-jp-nat", tags: ["cd", "NAT", "HOME"], place: TYO, version: "0.3.9", cpu: 9, price: [3500, "CHY", "monthly"], due: 8, vendor: "xuezhang" },
  { name: "[cd]-cloudcone-la", tags: ["cd", "VDS", "HOME"], place: LA, version: "0.3.9", cpu: 7, price: [1999, "USD", "monthly"], due: 11, auto: true, vendor: "CloudCone" },
  { name: "[Metix]-DMIT-1", tags: ["Metix", "DMIT", "openjobs-vpn"], place: LA, version: "0.3.9", cpu: 12, price: [1298, "USD", "monthly"], due: 21, auto: true, vendor: "DMIT" },
  { name: "[Metix]-DMIT-2", tags: ["Metix", "DMIT", "openjobs-vpn"], place: LA, version: "0.3.9", cpu: 18, price: [1298, "USD", "monthly"], due: 21, auto: true, vendor: "DMIT" },
  { name: "[Metix]-DMIT-3", tags: ["Metix", "DMIT", "openjobs-vpn"], place: LA, version: "0.3.9", cpu: 7, price: [1298, "USD", "monthly"], due: 21, auto: true, vendor: "DMIT" },
  {
    name: "[Metix]-DMIT-4", tags: ["Metix", "DMIT", "openjobs-vpn"], place: LA, version: "0.3.8", status: "offline",
    sinceMs: 6 * DAY + 3 * HOUR, reason: "No report since the agent went quiet; the control plane stops trusting a node after 1m30s of silence.",
    price: [1298, "USD", "monthly"], due: 21, auto: true, vendor: "DMIT",
  },
  { name: "[Metix]-DMIT-eb-wee", tags: ["Metix", "DMIT", "VDS"], place: SJ, version: "0.3.9", cpu: 8, price: [2990, "USD", "monthly"], due: 58, auto: true, vendor: "DMIT" },
  { name: "[Metix]-Aaitr-ATT-VDS", tags: ["Metix", "Aaitr", "VDS", "三网优化"], place: LA, version: "0.3.9", cpu: 4, price: [80460, "CHY", "semiannual"], due: 98, auto: true, vendor: "AaiTr" },
  { name: "[Metix]-Aaitr-Frontier-VDS", tags: ["Metix", "Aaitr", "VDS", "三网优化"], place: LA, version: "0.3.9", cpu: 6, price: [3000, "CHY", "monthly"], due: 16, auto: true, vendor: "AaiTr" },
  { name: "[Metix]-Aaitr-Frontier-NAT", tags: ["Metix", "Aaitr", "NAT"], place: LA, version: "0.3.9", cpu: 3, os: "Alpine 3.20", price: [3000, "CHY", "monthly"], due: 16, auto: true, vendor: "AaiTr" },
  { name: "[Metix]-Aaitr-jp-softbank-NAT", tags: ["Metix", "Aaitr", "NAT", "三网优化"], place: TYO, version: "0.3.6", cpu: 2, os: "Alpine 3.20", price: [3500, "CHY", "monthly"], due: 12, vendor: "AaiTr" },
  { name: "[Metix]-VIRCS-ATT-VDS", tags: ["Metix", "VDS", "三网优化"], place: LA, version: "0.3.9", cpu: 11, price: [4500, "USD", "monthly"], due: 23, vendor: "VIRCS" },
  { name: "[Metix]-qqpw-cd2-VDS", tags: ["Metix", "openjobs-vpn", "VDS"], place: HI, version: "0.3.9", cpu: 31, price: [3782, "USD", "monthly"], due: 28, auto: true, vendor: "QQPW" },
  { name: "[Metix]-qqpw-cd3-VDS", tags: ["Metix", "openjobs-vpn", "VDS"], place: HI, version: "0.3.9", cpu: 28, price: [3782, "USD", "monthly"], due: 28, auto: true, vendor: "QQPW" },
  { name: "[Metix]-mkcloud-hr-iplc", tags: ["Metix", "三网优化", "HOME"], place: HEB, version: "0.3.9", cpu: 15, price: [310900, "CHY", "monthly"], due: 14, vendor: "McCloud" },
  { name: "[OpenJobs-Data]-TiDB-1", tags: ["OpenJobs-Data", "AWS", "VDS"], place: SGP, version: "0.3.9", cpu: 63, os: "Ubuntu 22.04", vendor: "AWS", noTerminal: true },
  { name: "[OpenJobs-Data]-TiDB-2", tags: ["OpenJobs-Data", "AWS"], place: SGP, version: "0.3.8", cpu: 58, os: "Ubuntu 22.04", vendor: "AWS", noTerminal: true },
  { name: "[OpenJobs-Data]-scripts", tags: ["OpenJobs-Data", "AWS"], place: SGP, version: "0.3.9", cpu: 19, os: "Ubuntu 22.04", vendor: "AWS" },
  {
    name: "[OpenJobs-Data]-tmp", tags: ["OpenJobs-Data", "AWS"], version: "0.3.3", status: "offline",
    sinceMs: 19 * DAY, reason: "No report since the agent went quiet; the control plane stops trusting a node after 1m30s of silence.",
    os: "Ubuntu 22.04", vendor: "AWS",
  },
  { name: "[OpenJobs-Data]-gpu-box", tags: ["OpenJobs-Data", "AWS", "HOME"], version: "0.3.9", cpu: 71, os: "Ubuntu 22.04", vendor: "AWS" },
];

/** Dense adds the states production did not have that day. */
function denseStatus(e: Entry): Pick<Entry, "status" | "sinceMs" | "reason"> | undefined {
  if (SHAPE !== "dense") return undefined;
  if (e.name === "[cd]-DMIT-pro-malibu") {
    return { status: "degraded", sinceMs: 35 * MINUTE, reason: "Reporting, but sing-box has been restarting for 35m (unit activating/auto-restart, 412 restarts)." };
  }
  if (e.name === "[OpenJobs-Data]-gpu-box") {
    return { status: "never_reported", sinceMs: 11 * HOUR, reason: "No report has arrived since enrollment 11h ago." };
  }
  if (e.name === "[cd]-Oracle-KIX-arm") {
    return { status: "disabled", sinceMs: 2 * DAY, reason: "Disabled by an operator; the agent token is refused until the node is enabled again." };
  }
  return undefined;
}

export function nodeId(index: number): string {
  return `node_${String(index + 1).padStart(3, "0")}`;
}

function toNode(e: Entry, index: number): Node {
  const override = denseStatus(e);
  const status: NodeStatus = override?.status ?? e.status ?? "online";
  const sinceMs = override?.sinceMs ?? e.sinceMs ?? (5 + (index % 9)) * DAY;
  const reason = override?.reason ?? e.reason ?? "Reporting; the last report arrived 3s ago.";
  const reporting = status === "online" || status === "degraded";
  const never = status === "never_reported";
  const memTotal = 8 * 1024 ** 3;
  const diskTotal = 80 * 1024 ** 3;
  const cpu = e.cpu ?? 10;
  const lastSeen = never ? "0001-01-01T00:00:00Z" : status === "offline" ? iso(-sinceMs) : iso(-3000);
  return {
    id: nodeId(index),
    name: e.name,
    tags: [...e.tags],
    role: "",
    public_ip: never ? undefined : `203.0.113.${10 + index}`,
    agent_version: never ? "" : e.version,
    online: reporting || status === "disabled",
    reachability: never ? "never" : reporting || status === "disabled" ? "online" : "offline",
    status,
    status_since: iso(-sinceMs),
    status_reason: reason,
    disabled: status === "disabled" || undefined,
    last_seen: lastSeen,
    metrics: never
      ? undefined
      : {
          cpu_percent: cpu,
          memory_used: Math.round(memTotal * Math.min(0.95, cpu / 100 + 0.2)),
          memory_total: memTotal,
          disk_used: Math.round(diskTotal * 0.4),
          disk_total: diskTotal,
          net_rx_speed: reporting ? 120_000 * (cpu + 1) : 0,
          net_tx_speed: reporting ? 90_000 * (cpu + 1) : 0,
          net_rx_bytes: 4_000_000_000_000,
          net_tx_bytes: 2_500_000_000_000,
          uptime_seconds: 86_400 * 12,
        },
    host_facts: never
      ? undefined
      : {
          hostname: e.name.replace(/^\[[^\]]+\]-/, "").toLowerCase(),
          os: e.os ?? "Debian 12",
          platform: e.os?.startsWith("macOS") ? "darwin" : "linux",
          arch: e.arch ?? "amd64",
          cpu_cores: 2,
        },
    geo: e.place
      ? { country: e.place[0], region: e.place[1], city: e.place[2], lat: e.place[3] + (index % 3) * 0.08, lon: e.place[4] + (index % 4) * 0.08, source: "auto" }
      : undefined,
    agent_runtime: reporting
      ? { allow_exec: true, allow_root_exec: e.root === true, no_exec: false, allow_terminal: !e.noTerminal, terminal_transport: "poll", ssh_alerts: true, singbox_discover: true, reported_at: iso(-3000) }
      : null,
    // Production: 33 of 34 nodes have no source policy.
    agent_source_allowlist: e.name === "[cd]-hetzner-fsn" ? ["https://github.com/LatticeNet/"] : [],
    group_ids: [],
  } as Node;
}

export const NODES: Node[] = SHAPE === "empty" ? [] : FLEET.map(toNode);

export function nodeByName(name: string): Node | undefined {
  return NODES.find((node) => node.name === name);
}

/* ------------------------------------------------------------------ */
/* Groups: three, as production has; membership invented               */
/* ------------------------------------------------------------------ */

function rollup(ids: string[]) {
  let online = 0;
  let offline = 0;
  let disabled = 0;
  for (const id of ids) {
    const node = NODES.find((n) => n.id === id);
    if (!node) continue;
    if (node.status === "disabled") disabled += 1;
    else if (node.status === "online" || node.status === "degraded") online += 1;
    else offline += 1;
  }
  return { total: ids.length, online, offline, disabled };
}

function idsWhere(test: (node: Node) => boolean): string[] {
  return NODES.filter(test).map((node) => node.id);
}

function group(id: string, name: string, color: string, order: number, members: string[], description: string): GroupView {
  return { id, name, slug: id.replace(/^grp_/, ""), color, order, members, resolved_members: members, rollup: rollup(members), description, created_at: iso(-90 * DAY), updated_at: iso(-12 * DAY) };
}

export const GROUPS: GroupView[] =
  SHAPE === "empty"
    ? []
    : [
        group("grp_openjobs_vpn", "openjobs-vpn exits", "blue", 0, idsWhere((n) => (n.tags ?? []).includes("openjobs-vpn")), "Exits the OpenJobs VPN users are routed through."),
        group("grp_cn_optimized", "三网优化 relays", "green", 1, idsWhere((n) => (n.tags ?? []).includes("三网优化")), "Relays on CN2 GIA and other China-optimized routes."),
        group("grp_data", "OpenJobs data", "amber", 2, idsWhere((n) => (n.tags ?? []).includes("OpenJobs-Data")), "The data team's AWS machines."),
      ];

for (const g of GROUPS) {
  for (const id of g.resolved_members) NODES.find((n) => n.id === id)?.group_ids?.push(g.id);
}

export function ungrouped() {
  const grouped = new Set(GROUPS.flatMap((g) => g.resolved_members));
  const members = NODES.map((n) => n.id).filter((id) => !grouped.has(id));
  return { resolved_members: members, rollup: rollup(members) };
}

/* ------------------------------------------------------------------ */
/* Machines                                                            */
/* ------------------------------------------------------------------ */

export const MACHINES: MachineView[] = FLEET.flatMap((e, index): MachineView[] => {
  if (SHAPE === "empty") return [];
  const id = nodeId(index);
  const node = NODES[index]!;
  const dueShift = SHAPE === "dense" && e.name === "[cd]-xuezhang-jp-nat" ? -10 : SHAPE === "dense" && e.name === "[Metix]-Aaitr-jp-softbank-NAT" ? -9 : 0;
  // Dense: DMIT-4, offline 6d, was due 7d ago and is billed by hand (an unpaid
  // renewal the node sheet names), and the GPU box has no machine profile.
  const unpaid = SHAPE === "dense" && e.name === "[Metix]-DMIT-4";
  if (SHAPE === "dense" && e.name === "[OpenJobs-Data]-gpu-box") {
    return [{ node_id: id, node_name: e.name, online: node.status === "online" || node.status === "degraded", host_facts: node.host_facts } as MachineView];
  }
  const due = unpaid ? -7 : e.due === undefined ? undefined : e.due + dueShift;
  const next = due === undefined ? undefined : dateIn(due);
  return [
    {
      id: `mch_${String(index + 1).padStart(3, "0")}`,
      node_id: id,
      node_name: e.name,
      label: e.name.replace(/^\[[^\]]+\]-/, ""),
      online: node.status === "online" || node.status === "degraded",
      host_facts: node.host_facts,
      vendor: e.vendor,
      region: e.place ? `${e.place[0]}, ${e.place[2]}` : undefined,
      price_cents: e.price?.[0] ?? 0,
      currency: e.price?.[1] ?? "USD",
      renewal_cycle: e.price?.[2] ?? "",
      next_renewal: next,
      days_until_renewal: due,
      auto_roll: !!e.auto && !unpaid,
      remind_days_before: next ? [14, 7, 3, 1, 0] : [],
      reminders_enabled: !!next && !e.quiet,
      has_console_url: !!e.vendor && e.vendor !== "AWS",
      purchased_at: iso(-200 * DAY),
      updated_at: iso(-(index + 1) * 2 * DAY),
    } as MachineView,
  ];
});

/* ------------------------------------------------------------------ */
/* What runs out                                                        */
/* ------------------------------------------------------------------ */

export function expiringItems(within: number, machines: readonly MachineView[] = MACHINES): ExpiringItem[] {
  const machineRows: ExpiringItem[] = machines.filter((m) => m.next_renewal && m.days_until_renewal !== undefined).map((m) => {
    const days = m.days_until_renewal!;
    const subtitle = [m.vendor, m.region].filter(Boolean).join(" · ");
    return {
      kind: "machine_renewal",
      id: m.id!,
      title: m.label ?? m.node_name ?? m.node_id,
      ...(subtitle ? { subtitle } : {}),
      due_at: m.next_renewal!,
      days,
      state: m.auto_roll ? "auto" : days < 0 ? "overdue" : days <= 7 ? "due" : "upcoming",
      cost_cents: m.price_cents ?? 0,
      currency: m.price_cents ? (m.currency ?? "") : "",
      reminder: { enabled: !!m.reminders_enabled },
      href: `/inventory?machine=${m.id}`,
    } as ExpiringItem;
  });
  const extra: ExpiringItem[] =
    SHAPE === "dense"
      ? [
          { kind: "vpn_user", id: "pu_shenzhen", title: "openjobs-shenzhen", due_at: dateIn(5), days: 5, state: "due", cost_cents: 0, currency: "", href: "/plugins/latticenet.vpn-core/users", used_bytes: 164 * 1024 ** 3, quota_bytes: 200 * 1024 ** 3 },
          { kind: "tls_certificate", id: "mon_tls_sub", title: "sub.example.net", subtitle: "sub.example.net:443", due_at: dateIn(6), days: 6, state: "due", cost_cents: 0, currency: "", href: "/monitoring/mon_tls_sub" },
        ]
      : [];
  return [...machineRows, ...extra].filter((item) => item.days <= within).sort((a, b) => a.days - b.days || a.title.localeCompare(b.title));
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

const dmit4 = () => nodeByName("[Metix]-DMIT-4")?.id ?? "node_020";
const racknerd = () => nodeByName("[cd]-racknerd-la")?.id ?? "node_006";

export function tasksFor(nodeIdValue: string): TaskView[] {
  const all: TaskView[] = [
    {
      id: "tsk_stalled_fanout",
      targets: [nodeByName("[Metix]-DMIT-3")?.id ?? "node_019", dmit4()],
      interpreter: "sh",
      status: "leased",
      script_size_bytes: 412,
      timeout_sec: 300,
      created_at: iso(-(6 * DAY + 3 * HOUR)),
      started_at: iso(-(6 * DAY + 3 * HOUR)),
      target_states: {
        [dmit4()]: { status: "stalled", attempts: 3, max_attempts: 3, lease_age_seconds: 6 * 86400 + 3 * 3600, stalled_reason: "The store stopped re-leasing after 3 attempts." },
      },
    } as TaskView,
    { id: "tsk_running", targets: [racknerd()], interpreter: "bash", status: "leased", script_size_bytes: 96, created_at: iso(-4 * MINUTE), started_at: iso(-4 * MINUTE), attempts: 1, max_attempts: 3, lease_age_seconds: 240 } as TaskView,
    { id: "tsk_done", targets: [racknerd()], interpreter: "sh", status: "finished", script_size_bytes: 88, created_at: iso(-3 * HOUR), finished_at: iso(-3 * HOUR + 2200) } as TaskView,
  ];
  return all.filter((task) => task.targets.includes(nodeIdValue));
}

export function taskCounts() {
  const generated_at = new Date().toISOString();
  if (SHAPE === "dense") return { queued: 3, running: 2, stalled: 2, failed_24h: 12, finished_24h: 44, total: 1779, generated_at };
  // failed_24h and finished_24h are invented; production's all-time figures are 243 failed of 1,771.
  return { queued: 0, running: 1, stalled: 1, failed_24h: 5, finished_24h: 31, total: 1771, generated_at };
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

/** Node flips in the last day (invented; production averaged 44 a day). */
function flipEvents(): AuditEvent[] {
  const out: AuditEvent[] = [];
  const flappers: [string, number][] = [
    ["[cd]-mac-air", 14],
    ["[Metix]-Aaitr-jp-softbank-NAT", 4],
    ["[cd]-homeserver", 2],
    ["[Metix]-DMIT-2", 1],
  ];
  if (SHAPE === "dense") flappers.push(["[cd]-gomami-hk-turin-mini", 6]);
  let n = 0;
  for (const [name, count] of flappers) {
    const node = nodeByName(name);
    if (!node) continue;
    for (let i = 0; i < count; i++) {
      const at = NOW - (i + 1) * (22 * HOUR) / (count + 1);
      out.push({ id: `aud_off_${n}`, at: new Date(at).toISOString(), actor_id: "system", node_id: node.id, action: "node.offline", decision: "allow" });
      out.push({ id: `aud_on_${n}`, at: new Date(at + 4 * MINUTE).toISOString(), actor_id: "system", node_id: node.id, action: "node.online", decision: "allow" });
      n += 1;
    }
  }
  return out;
}

function changeEvents(): AuditEvent[] {
  const at = (ms: number) => iso(-ms);
  const id = (name: string) => nodeByName(name)?.id;
  const rows: AuditEvent[] = [
    { id: "aud_c1", at: at(12 * MINUTE), actor_id: "cdcd", node_id: id("[cd]-racknerd-la"), action: "task.create", decision: "allow" },
    { id: "aud_c2", at: at(2 * HOUR), actor_id: "cdcd", node_id: id("[Metix]-DMIT-2"), action: "network.singbox-linemeta.approve", decision: "allow", metadata: { approval_id: "approval_9f2kx81mzq4tw7dn" } },
    { id: "aud_c3", at: at(5 * HOUR), actor_id: "cdcd", node_id: id("[cd]-mac-air"), action: "node.update", decision: "allow" },
    { id: "aud_c4", at: at(9 * HOUR), actor_id: "system", node_id: id("[cd]-hetzner-fsn"), action: "inventory.auto_roll", decision: "allow" },
    { id: "aud_c5", at: at(26 * HOUR), actor_id: "cdcd", action: "ddns.update", decision: "allow" },
    { id: "aud_c6", at: at(30 * HOUR), actor_id: "cdcd", node_id: id("[Metix]-Aaitr-ATT-VDS"), action: "agent.update.plan", decision: "allow" },
    { id: "aud_c7", at: at(31 * HOUR), actor_id: "cdcd", action: "auth.login", decision: "observe" },
    { id: "aud_c8", at: at(40 * HOUR), actor_id: "cdcd", node_id: id("[cd]-Oracle-KIX-arm"), action: "ssh.login", decision: "observe" },
  ];
  return rows;
}

export function auditEvents(): AuditEvent[] {
  if (SHAPE === "empty") return [];
  return [...flipEvents(), ...changeEvents()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/* ------------------------------------------------------------------ */
/* DDNS, agent updates, SSH Guard, monitors                            */
/* ------------------------------------------------------------------ */

export const DDNS: DDNSView[] = SHAPE === "empty"
  ? []
  : NODES.slice(0, 22).map((node, index) => {
      const failing = index === 2 || index === 13 || (SHAPE === "dense" && index === 7);
      return {
        id: `ddns_${String(index + 1).padStart(3, "0")}`,
        name: `${node.name.replace(/^\[[^\]]+\]-/, "").toLowerCase()}.dyn`,
        node_id: node.id,
        provider: "cloudflare",
        domains: [`${node.name.replace(/^\[[^\]]+\]-/, "").toLowerCase()}.dyn.example.net`],
        enable_ipv4: true,
        enable_ipv6: false,
        max_retries: 3,
        ttl: 60,
        has_credential: true,
        last_ipv4: node.public_ip,
        last_run_at: iso(-(failing ? 4 : 2) * MINUTE),
        last_error: failing ? (index === 2 ? "cloudflare: 403 Forbidden: Authentication error (code 10000)" : "resolve public ipv4: context deadline exceeded") : undefined,
        created_at: iso(-80 * DAY),
        updated_at: iso(-(failing ? 4 : 2) * MINUTE),
      } as DDNSView;
    });

export const AGENT_POLICIES: AgentUpdatePolicy[] = NODES.slice(0, 33).map((node) => ({
  node_id: node.id,
  enabled: true,
  auto_plan: node.name.startsWith("[cd]"),
  target_version: "0.3.9",
  binary_url: "https://github.com/LatticeNet/lattice-node-agent/releases/download/v0.3.9/lattice-agent-linux-amd64",
  sha256: "0".repeat(64),
  install_path: "/usr/local/bin/lattice-agent",
  service_name: "lattice-agent",
  created_at: iso(-60 * DAY),
  updated_at: iso(-3 * DAY),
}));

export function sshGuardFor(id: string): SSHGuardNodeStatus | undefined {
  const node = NODES.find((n) => n.id === id);
  if (!node) return undefined;
  const open = node.name.includes("homeserver") || node.name.includes("jp-softbank");
  return {
    node_id: id,
    node_name: node.name,
    enrolled: true,
    posture: open
      ? { state: "password_open", key_access: true, reason: "sshd accepts password login (PasswordAuthentication yes)." }
      : { state: "secured", key_access: true, key_evidence: "authorized_keys", reason: "Password login is off and an authorized key is present." },
    knock_gate: !open,
    stage: open ? "none" : "confirmed",
    stage_is_history: false,
    revert_armed: false,
    knock: { knowledge: open ? "no_knock" : "installed", revealable: !open, requires_step_up: true, interactive_only: true, note: "", confirmed: !open },
  } as unknown as SSHGuardNodeStatus;
}

function someMonitors(): MonitorView[] {
  return [
    { id: "mon_console", name: "Lattice console", type: "http", target: "https://lattice.example.net/healthz", interval_sec: 60, timeout_sec: 10, assign_all: false, node_ids: NODES.slice(0, 3).map((n) => n.id), enabled: true, created_at: iso(-20 * DAY) },
    { id: "mon_tls_sub", name: "sub.example.net", type: "tls", target: "sub.example.net:443", interval_sec: 3600, timeout_sec: 10, threshold_days: 14, assign_all: false, node_ids: [], enabled: true, created_at: iso(-20 * DAY) },
    { id: "mon_hk_tcp", name: "HK relay port", type: "tcp", target: "203.0.113.21:443", interval_sec: 30, timeout_sec: 5, assign_all: false, node_ids: NODES.slice(3, 5).map((n) => n.id), enabled: true, created_at: iso(-3 * DAY) },
    // dev/latencyFixture.ts: node_x000 and node_x009 are in Los Angeles, node_x001 in San Jose.
    ...(PARAMS.get("topo") === "many"
      ? [{ id: "mon_bulk_us", name: "US edge health", type: "http", target: "https://edge.example.net/healthz", interval_sec: 60, timeout_sec: 10, assign_all: false, node_ids: ["node_x000", "node_x001", "node_x009"], enabled: true, created_at: iso(-2 * DAY) }]
      : []),
  ];
}

/** One relay-port watch per node, round the fleet, until there are sixty. */
function manyMonitors(): MonitorView[] {
  const out = someMonitors();
  for (let i = 0; out.length < 60; i++) {
    const node = NODES[i % NODES.length]!;
    const port = 17000 + i;
    out.push({ id: `mon_port_${i}`, name: `${node.name} relay ${port}`, type: "tcp", target: `${node.public_ip ?? `198.51.100.${i}`}:${port}`, interval_sec: 30, timeout_sec: 5, assign_all: false, node_ids: [node.id], enabled: true, created_at: iso(-(i + 1) * HOUR) });
  }
  return out;
}

export const MONITORS: MonitorView[] =
  SHAPE === "empty" ? [] : PARAMS.get("monitors") === "some" ? someMonitors() : PARAMS.get("monitors") === "many" ? manyMonitors() : [];

/** In `?monitors=many`: failing for the last four checks, and gone quiet half an hour ago. */
const FAILING_PORTS = new Set(["mon_port_7", "mon_port_41", "mon_port_52"]);
const QUIET_PORTS = new Set(["mon_port_55"]);

export function monitorResults(monitorId: string): MonitorResult[] {
  const monitor = MONITORS.find((m) => m.id === monitorId);
  if (!monitor) return [];
  const out: MonitorResult[] = [];
  // The control plane dials a tls monitor itself, hourly: its results carry no node.
  const tls = monitor.type === "tls";
  const nodes = tls ? [""] : (monitor.node_ids ?? []);
  const quiet = QUIET_PORTS.has(monitorId) ? 30 * MINUTE : 0;
  for (let i = 0; i < 24; i++) {
    for (const node of nodes) {
      const failing = (monitorId === "mon_hk_tcp" && i < 3 && node === nodes[0]) || (FAILING_PORTS.has(monitorId) && i < 4);
      out.push({
        monitor_id: monitorId,
        node_id: node,
        at: iso(-quiet - i * (tls ? 60 : 5) * MINUTE),
        success: !failing,
        latency_ms: failing ? undefined : monitorId === "mon_console" ? 118 + ((i * 7) % 23) : 42 + ((i * 5) % 17),
        error: failing ? `dial tcp ${monitor.target}: i/o timeout` : undefined,
        cert_not_after: monitor.type === "tls" ? dateIn(SHAPE === "dense" ? 6 : 44) : undefined,
      });
    }
  }
  return out;
}

/**
 * Each node's newest result with the run it ends, as the server sends it on
 * the monitors list.
 */
export function monitorLatest(monitorId: string): MonitorLatest[] {
  const byNode = new Map<string, MonitorResult[]>();
  for (const result of monitorResults(monitorId)) {
    const rows = byNode.get(result.node_id) ?? [];
    rows.push(result);
    byNode.set(result.node_id, rows);
  }
  return [...byNode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rows]) => {
      rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const newest = rows[0]!;
      let run = 1;
      while (run < rows.length && rows[run]!.success === newest.success) run++;
      return {
        node_id: newest.node_id,
        at: newest.at,
        success: newest.success,
        latency_ms: newest.latency_ms,
        error: newest.error,
        cert_not_after: newest.cert_not_after,
        received_at: newest.at,
        fail_streak: newest.success ? 0 : run,
        since: rows[run - 1]!.at,
      };
    });
}
