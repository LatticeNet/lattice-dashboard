/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=upcoming LATTICE_HARNESS_PORT=5201 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5201/dev/upcoming.html                     (home)
 *   open http://127.0.0.1:5201/dev/upcoming.html#/upcoming           (full list)
 *   open http://127.0.0.1:5201/dev/upcoming.html#/inventory?group=renewal
 *   open http://127.0.0.1:5201/dev/upcoming.html#/platform/notifications
 *
 * `?fixture=` before the hash picks what `GET /api/expiring` answers:
 *   dense (default)  production on 2026-09-29, plus VPN users, a share and certificates
 *   empty            nothing runs out
 *   failing          500 on every read
 *   stale            the first read works, every later one fails (keeps the rows, says their age)
 *   old              a server that predates the endpoint: plain 404
 *   hidden           a session without proxy:read and monitor:read: those kinds are named in `hidden_kinds`
 * `?role=reader` drops inventory:admin, so a ?machine= link marks the card
 * instead of opening the editor.
 * `?reminders=off` puts the machines back the way production had them before
 * the default-on migration: reminders off everywhere.
 *
 * The fleet is production on 2026-09-29: 34 machines, 25 with a renewal date,
 * 20 of them within 30 days, the first on 10-06, four DMIT machines on 10-20
 * and four more machines on 10-27, prices in USD and CNY. Dates are relative
 * to today so the harness keeps that shape on any day.
 */
import { ApiError } from "@/lib/api/client";
import type {
  ExpiringItem,
  ExpiringResponse,
  MachineVendorView,
  MachineView,
  NotifyChannelView,
  NotifyRuleView,
  Principal,
} from "@/lib/api/index";
import { formatDay } from "@/views/fleet/inventoryEditorModel";
import { DEFAULT_REMIND_DAYS, nextReminder } from "@/views/fleet/reminderModel";
import { sumTotals } from "@/views/fleet/upcomingModel";

import { api as statusApi } from "./statusFakeApi";

export * from "@/lib/api/index";

const DAY = 86_400_000;
const LATENCY_MS = 90;
const params = new URLSearchParams(window.location.search);
const FIXTURE = params.get("fixture") ?? "dense";
const REMINDERS_OFF = params.get("reminders") === "off";
/** `?role=reader`: a session with inventory:read but not inventory:admin. */
const READER = params.get("role") === "reader";

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function todayUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function dateIn(days: number): string {
  return new Date(todayUtc() + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── machines ────────────────────────────────────────────────────────────────

interface Entry {
  node: string;
  vendor?: string;
  region?: string;
  price?: number;
  currency?: "USD" | "CNY";
  cycle?: string;
  /** Days from today to the next renewal; omitted when none is tracked. */
  due?: number;
  auto?: boolean;
  /** The operator turned this machine's reminder off. */
  quiet?: boolean;
  unprofiled?: boolean;
}

const FLEET: Entry[] = [
  // Within 30 days: 20 machines, the first on day 7.
  { node: "cd-xuezhang-jp-nat", vendor: "xuezhang", region: "Tokyo", price: 3500, currency: "CNY", cycle: "monthly", due: 7 },
  { node: "cd-volcengine-shanghai", vendor: "火山云", region: "Shanghai", price: 2890, currency: "CNY", cycle: "monthly", due: 9, auto: true },
  { node: "cd-cloudcone-la", vendor: "CloudCone", region: "Los Angeles", price: 333, currency: "USD", cycle: "monthly", due: 11, auto: true },
  { node: "cd-xuezhang-canada-nat", vendor: "xuezhang", region: "Ontario", price: 3500, currency: "CNY", cycle: "monthly", due: 12 },
  { node: "cd-mkcloud-hr-iplc", vendor: "McCloud", region: "Hebei to Tokyo IPLC", price: 18800, currency: "CNY", cycle: "monthly", due: 14 },
  { node: "cd-aaitr-Frontier-nat", vendor: "AaiTr", region: "California", price: 3000, currency: "CNY", cycle: "monthly", due: 16, auto: true },
  { node: "cd-hk-turin-mini", vendor: "Turin", region: "Hong Kong", price: 800, currency: "USD", cycle: "monthly", due: 18, quiet: true },
  { node: "cd-bwg-dc6", vendor: "BandwagonHost", region: "Los Angeles", price: 4999, currency: "USD", cycle: "quarterly", due: 19, auto: true },
  { node: "openjobs-vpn-dmit-1", vendor: "DMIT", region: "Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 21, auto: true },
  { node: "openjobs-vpn-dmit-2", vendor: "DMIT", region: "Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 21, auto: true },
  { node: "openjobs-vpn-dmit-3", vendor: "DMIT", region: "Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 21, auto: true },
  { node: "openjobs-vpn-dmit-4", vendor: "DMIT", region: "Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 21, auto: true },
  { node: "cd-vircs-att-vds", vendor: "VIRCS", region: "US, AT&T", price: 4500, currency: "USD", cycle: "monthly", due: 23 },
  { node: "cd-legend-sg", vendor: "LegendVPS", region: "Singapore", price: 600, currency: "USD", cycle: "monthly", due: 25, auto: true },
  { node: "cd-aliyun-hk", vendor: "Aliyun", region: "Hong Kong", price: 3400, currency: "CNY", cycle: "monthly", due: 26 },
  { node: "openjobs-vpn-qqpw-cd2", vendor: "QQPW", region: "Honolulu", price: 3782, currency: "USD", cycle: "monthly", due: 28, auto: true },
  { node: "openjobs-vpn-qqpw-cd3", vendor: "QQPW", region: "Honolulu", price: 3782, currency: "USD", cycle: "monthly", due: 28, auto: true },
  { node: "cd-qqpw-vds-cd1", vendor: "QQPW", region: "Hawaii", price: 3500, currency: "USD", cycle: "monthly", due: 28, auto: true },
  { node: "cd-gomami-jpn", vendor: "Gomami", region: "Tokyo", price: 2900, currency: "USD", cycle: "monthly", due: 28, auto: true },
  { node: "cd-tencent-gz", vendor: "Tencent Cloud", region: "Guangzhou", price: 4500, currency: "CNY", cycle: "monthly", due: 29, auto: true, quiet: true },
  // Dated, further out.
  { node: "cd-dmit-eb-wee", vendor: "DMIT", region: "Los Angeles", price: 3990, currency: "USD", cycle: "annual", due: 58, auto: true },
  { node: "cd-legendVPS", vendor: "LegendVPS", region: "São Paulo", price: 3000, currency: "USD", cycle: "annual", due: 76, auto: true },
  { node: "cd-dmit-pro-malibu", vendor: "DMIT", region: "Los Angeles", price: 3990, currency: "USD", cycle: "annual", due: 93, auto: true },
  { node: "cd-aaitr-ATT", vendor: "AaiTr", region: "California", price: 80460, currency: "CNY", cycle: "semiannual", due: 98, auto: true },
  { node: "cd-AkkoCloud-UK", vendor: "AkkoCloud", region: "London", price: 29800, currency: "CNY", cycle: "annual", due: 293, auto: true },
  // No renewal date: one-time, free, home hardware, and a node nobody profiled.
  { node: "cd-hetzner-fsn", vendor: "Hetzner", region: "Falkenstein", price: 45000, currency: "USD" },
  { node: "cd-oracle-kix-arm", vendor: "Oracle", region: "Osaka" },
  { node: "cd-oracle-sjc-amd", vendor: "Oracle", region: "San Jose" },
  { node: "cd-homeserver", region: "Shanghai" },
  { node: "cd-mac-air", region: "Shanghai" },
  { node: "cd-nas-synology", region: "Shanghai" },
  { node: "openjobs-office-gw", vendor: "China Telecom", region: "Shenzhen" },
  { node: "cd-rpi-garage", region: "Shanghai" },
  { node: "cd-new-hkbn-hub", unprofiled: true },
];

function nodeId(index: number): string {
  return `node_${String(index + 1).padStart(3, "0")}`;
}

function toMachine(e: Entry, index: number): MachineView {
  const id = nodeId(index);
  if (e.unprofiled) return { node_id: id, node_name: e.node, online: false } as MachineView;
  const next = e.due === undefined ? undefined : dateIn(e.due);
  const dated = next !== undefined;
  return {
    id: `mch_${String(index + 1).padStart(3, "0")}`,
    node_id: id,
    node_name: e.node,
    label: e.node,
    online: true,
    host_facts: { hostname: e.node.toLowerCase(), os: "Debian 12", platform: "linux", arch: "amd64" },
    vendor: e.vendor,
    region: e.region,
    price_cents: e.price ?? 0,
    currency: e.currency ?? "USD",
    renewal_cycle: e.cycle ?? "",
    next_renewal: next,
    days_until_renewal: e.due,
    auto_roll: !!e.auto,
    remind_days_before: dated ? [...DEFAULT_REMIND_DAYS] : [],
    reminders_enabled: dated && !e.quiet && !REMINDERS_OFF,
    updated_at: new Date(Date.now() - (index + 1) * 2 * DAY).toISOString(),
  } as MachineView;
}

const machines: MachineView[] = FLEET.map(toMachine);

const vendors: MachineVendorView[] = [
  { id: "vnd_dmit", name: "DMIT", url: "https://www.dmit.io" },
  { id: "vnd_qqpw", name: "QQPW" },
];

// ── the expiring list ───────────────────────────────────────────────────────

function machineItems(): ExpiringItem[] {
  const today = formatDay(new Date());
  return machines
    .filter((m) => m.id && m.next_renewal && m.days_until_renewal !== undefined)
    .map((m) => {
      const days = m.days_until_renewal!;
      const next = nextReminder(m, today);
      const subtitle = [m.vendor, m.region].filter(Boolean).join(" · ");
      // The server omits optional fields instead of sending null, so the
      // fixture leaves the keys out too.
      const item: ExpiringItem = {
        kind: "machine_renewal",
        id: m.id!,
        title: m.label ?? m.node_name ?? m.node_id,
        due_at: m.next_renewal!,
        days,
        state: m.auto_roll ? "auto" : days < 0 ? "overdue" : days <= 7 ? "due" : "upcoming",
        cost_cents: m.price_cents ?? 0,
        currency: m.price_cents ? (m.currency ?? "") : "",
        reminder: next && next.offset >= 0 ? { enabled: !!m.reminders_enabled, next_offset_days: next.offset } : { enabled: !!m.reminders_enabled },
        href: `/inventory?machine=${m.id}`,
      };
      if (subtitle) item.subtitle = subtitle;
      return item;
    });
}

function otherItems(): ExpiringItem[] {
  const row = (kind: string, id: string, title: string, subtitle: string, days: number, href: string): ExpiringItem => ({
    kind,
    id,
    title,
    ...(subtitle ? { subtitle } : {}),
    due_at: dateIn(days),
    days,
    state: days < 0 ? "overdue" : days <= 7 ? "due" : "upcoming",
    cost_cents: 0,
    currency: "",
    href,
  });
  const users = "/plugins/latticenet.vpn-core/users";
  return [
    row("vpn_user", "pu_guest", "guest-oct-trip", "VPN user · 41% of 50 GB used", -2, users),
    row("vpn_user", "pu_shenzhen", "openjobs-shenzhen", "VPN user · 82% of 200 GB used", 5, users),
    row("vpn_user", "pu_family", "cdcd-family", "VPN user · 12% of 300 GB used", 40, users),
    row("tls_certificate", "mon_tls_sub", "sub.example.net", "TLS monitor · Let's Encrypt R11", 6, "/monitoring/mon_tls_sub"),
    // No subtitle: the server leaves the key out when it has nothing to say.
    row("tls_certificate", "mon_tls_console", "lattice.example.net", "", 45, "/monitoring/mon_tls_console"),
    row("share", "shr_cdcd", "/s/cdcd", "Share of for-cdcd-loon", 33, "/platform/publishing?origin=share&share=shr_cdcd"),
  ];
}

const HIDDEN_KINDS = new Set(["vpn_user", "tls_certificate"]);
let expiringReads = 0;

function expiring(within: number): Promise<ExpiringResponse> {
  expiringReads += 1;
  if (FIXTURE === "failing" || (FIXTURE === "stale" && expiringReads > 1)) {
    return delay(undefined).then(() => {
      throw new ApiError(500, "internal", "store: read expiring: context deadline exceeded", "req_7f3a91");
    });
  }
  if (FIXTURE === "old") {
    return delay(undefined).then(() => {
      throw new ApiError(404, "404", "404 page not found");
    });
  }
  const all = FIXTURE === "empty" ? [] : [...machineItems(), ...otherItems()];
  const inRange = all.filter((item) => item.days <= within);
  const items = (FIXTURE === "hidden" ? inRange.filter((item) => !HIDDEN_KINDS.has(item.kind)) : inRange).sort(
    (a, b) => a.days - b.days || a.title.localeCompare(b.title),
  );
  return delay({
    generated_at: new Date(Date.now() - 12_000).toISOString(),
    within_days: within,
    items,
    totals: sumTotals(items),
    // Kinds only: the server never says how many rows it left out.
    hidden_kinds: FIXTURE === "hidden" ? [...HIDDEN_KINDS] : [],
  });
}

// ── notifications ───────────────────────────────────────────────────────────

const channels: NotifyChannelView[] = [
  { id: "nch_bark_cdcd", name: "phone-cdcd", kind: "bark", config_keys: ["base_url", "key", "level"], enabled: true, created_at: dateIn(-60), updated_at: dateIn(-20) },
  { id: "nch_bark_routine", name: "phone-cdcd-routine", kind: "bark", config_keys: ["base_url", "key", "group"], enabled: true, created_at: dateIn(-40), updated_at: dateIn(-9) },
];

const rules: NotifyRuleView[] = [
  {
    id: "nrl_alerts",
    name: "Alerts",
    event_types: ["monitor.down", "proxy.quota", "proxy.expiry", "ssh.compromise_suspected"],
    channel_ids: ["nch_bark_cdcd"],
    title_template: "{{event_type}}: {{title}}",
    enabled: true,
    created_at: dateIn(-60),
    updated_at: dateIn(-20),
  },
  {
    id: "nrl_routine",
    name: "Recovered and routine",
    event_types: ["inventory.renewal", "monitor.recovered", "service.recovered", "ssh.login"],
    channel_ids: ["nch_bark_routine"],
    enabled: true,
    created_at: dateIn(-40),
    updated_at: dateIn(-9),
  },
  {
    id: "nrl_everything",
    name: "Everything (paused)",
    event_types: ["*"],
    channel_ids: ["nch_bark_cdcd"],
    enabled: false,
    created_at: dateIn(-90),
    updated_at: dateIn(-30),
  },
];

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: [
    "node:read",
    "approval:read",
    "task:read",
    "audit:read",
    "inventory:read",
    ...(READER ? [] : ["inventory:admin"]),
    "notify:admin",
    "notify:send",
    "proxy:read",
    "proxy:admin",
    "monitor:read",
  ],
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

export const api = {
  ...statusApi,
  auth: {
    me: () => delay(principal),
  },
  expiring: {
    list: (within = 60) => expiring(within),
  },
  machines: {
    list: () => {
      if (FIXTURE === "failing") return delay(undefined).then(() => { throw new ApiError(500, "internal", "store unavailable"); });
      return delay({ machines: machines.map((m) => ({ ...m })) });
    },
    runReminders: () => delay({ fired: [] }),
  },
  machineVendors: {
    list: () => delay({ vendors: vendors.map((v) => ({ ...v })) }),
  },
  notify: {
    channels: () => delay(channels.map((c) => ({ ...c }))),
    rules: () => delay({ rules: rules.map((r) => ({ ...r })) }),
  },
} as unknown as typeof import("@/lib/api/index").api;
