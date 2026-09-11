/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=inventory LATTICE_HARNESS_PORT=5186 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5186/dev/inventory.html
 *
 * Only the calls InventoryView makes are implemented; anything else is missing
 * from `api` and fails loudly. Writes change the in-memory list, so saving,
 * recording a renewal and deleting can be driven end to end.
 *
 * The fleet is the production shape on 2026-09-11 (25 recurring machines, a
 * Due soon bucket whose name order and date order disagree, mixed CHY and USD)
 * with the states the page has to tell apart added on top: one overdue, one
 * whose renewal setup is incomplete, one one-time purchase, one that needs a
 * price, free machines and a node nobody has profiled.
 */
import type {
  MachineProfileInput,
  MachineVendorInput,
  MachineVendorView,
  MachineView,
  Node,
  NotifyChannelView,
  Principal,
} from "@/lib/api/index";

export * from "@/lib/api/index";

const LATENCY_MS = 80;
const DAY = 86_400_000;

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

function daysUntil(iso?: string | null): number | undefined {
  if (!iso || iso.startsWith("0001-")) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.round((t - todayUtc()) / DAY);
}

interface Entry {
  node: string;
  label?: string;
  vendor?: string;
  region?: string;
  price?: number;
  currency?: string;
  cycle?: string;
  cycleDays?: number;
  /** Days from today to the next renewal; omitted when none is tracked. */
  due?: number;
  purchasedDaysAgo?: number;
  autoRoll?: boolean;
  reminders?: boolean;
  console?: boolean;
  detail?: boolean;
  notes?: string;
  /** No machine profile at all. */
  unprofiled?: boolean;
  offline?: boolean;
  os?: string;
}

const FLEET: Entry[] = [
  { node: "cd-gomami-jpn", vendor: "Gomami", region: "Japan, Tokyo, Tokyo", price: 2900, currency: "USD", cycle: "monthly", due: 12, purchasedDaysAgo: 140, autoRoll: true, detail: true },
  { node: "cd-qqpw-vds-cd1", vendor: "QQPW", region: "US, Hawaii", price: 3500, currency: "USD", cycle: "monthly", due: 13, purchasedDaysAgo: 200, autoRoll: true, detail: true },
  { node: "cd-volcengine-shanghai", vendor: "火山云", region: "China, Shanghai", price: 2890, currency: "CHY", cycle: "monthly", due: 11, purchasedDaysAgo: 80, autoRoll: true, detail: true },
  { node: "cd-xuezhang-canada-nat", vendor: "xuezhang", region: "Canada, Ontario", price: 3500, currency: "CHY", cycle: "monthly", due: 4, purchasedDaysAgo: 300, autoRoll: true, console: true, detail: true },
  { node: "openjobs-vpn-dmit-1", vendor: "DMIT", region: "United States, California, Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 9, purchasedDaysAgo: 60, autoRoll: true, detail: true },
  { node: "openjobs-vpn-dmit-2", vendor: "DMIT", region: "United States, California, Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 9, purchasedDaysAgo: 60, autoRoll: true, detail: true },
  { node: "openjobs-vpn-dmit-3", vendor: "DMIT", region: "United States, California, Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 9, purchasedDaysAgo: 60, autoRoll: true, detail: true },
  { node: "openjobs-vpn-dmit-4", vendor: "DMIT", region: "United States, California, Los Angeles", price: 1298, currency: "USD", cycle: "monthly", due: 9, purchasedDaysAgo: 60, autoRoll: true, detail: true },
  { node: "openjobs-vpn-qqpw-cd2", vendor: "QQPW", region: "United States, Hawaii, Honolulu", price: 3782, currency: "USD", cycle: "monthly", due: 11, purchasedDaysAgo: 90, autoRoll: true, detail: true },
  { node: "openjobs-vpn-qqpw-cd3", vendor: "QQPW", region: "United States, Hawaii, Honolulu", price: 3782, currency: "USD", cycle: "monthly", due: 14, purchasedDaysAgo: 90, autoRoll: true, detail: true },
  { node: "cd-aaitr-ATT", vendor: "AaiTr", region: "US-California", price: 80460, currency: "CHY", cycle: "semiannual", due: 98, purchasedDaysAgo: 85, autoRoll: true, detail: true, notes: "https://www.aaitr.com/" },
  { node: "cd-aaitr-Frontier-nat", vendor: "AaiTr", region: "US-California", price: 3000, currency: "CHY", cycle: "monthly", due: 23, purchasedDaysAgo: 250, autoRoll: true, detail: true },
  { node: "cd-AkkoCloud-UK", vendor: "AkkoCloud", region: "UK-London", price: 29800, currency: "CHY", cycle: "annual", due: 293, purchasedDaysAgo: 72, autoRoll: true, console: true, detail: true },
  { node: "cd-dmit-eb-wee", vendor: "DMIT", region: "United States, California, Los Angeles", price: 3990, currency: "USD", cycle: "annual", due: 58, purchasedDaysAgo: 307, autoRoll: true, console: true, detail: true },
  { node: "cd-dmit-pro-malibu", vendor: "DMIT", region: "United States, California, Los Angeles", price: 3990, currency: "USD", cycle: "annual", due: 93, purchasedDaysAgo: 272, autoRoll: true, console: true, detail: true },
  { node: "cd-legendVPS", vendor: "LegendVPS", region: "SP", price: 3000, currency: "USD", cycle: "annual", due: 76, purchasedDaysAgo: 289, autoRoll: true, detail: true },
  { node: "cd-mkcloud-hr-iplc", vendor: "McCloud", region: "China, Hebei - JP, Tokyo", price: 18800, currency: "CHY", cycle: "monthly", due: 22, purchasedDaysAgo: 400, autoRoll: true, console: true, detail: true, reminders: true },
  { node: "cd-xuezhang-jp-nat", vendor: "xuezhang", region: "Japan, Tokyo", price: 3500, currency: "CHY", cycle: "monthly", due: 23, purchasedDaysAgo: 160, autoRoll: true, detail: true },
  // States on top of the production shape.
  { node: "cd-racknerd-la", vendor: "RackNerd", region: "US, Los Angeles", price: 1099, currency: "USD", cycle: "annual", due: -6, purchasedDaysAgo: 371, autoRoll: false, reminders: true, detail: true },
  { node: "cd-bandwagon-dc6", vendor: "BandwagonHost", region: "US, Los Angeles", price: 4999, currency: "USD", cycle: "quarterly", purchasedDaysAgo: 30 },
  { node: "cd-hetzner-fsn", vendor: "Hetzner", region: "Germany, Falkenstein", price: 45000, currency: "USD", purchasedDaysAgo: 500, notes: "Bought outright with the dedicated server auction." },
  { node: "cd-vultr-syd", vendor: "Vultr", region: "Australia, Sydney", cycle: "custom_days", cycleDays: 45, due: 31, purchasedDaysAgo: 14 },
  { node: "cd-homeserver", vendor: "", region: "China, Shanghai", os: "Debian 12" },
  { node: "cd-mac-air", region: "China, Shanghai", os: "macOS 15.6" },
  { node: "cd-oracle-kix-arm", vendor: "Oracle", region: "Japan, Osaka", notes: "Always Free tier." },
  { node: "cd-new-hkbn-hub", unprofiled: true, offline: true },
];

const VENDORS: MachineVendorView[] = [
  { id: "vnd_dmit", name: "DMIT", url: "https://www.dmit.io", description: "LA premium lines" },
  { id: "vnd_qqpw", name: "QQPW", url: "https://qqpw.example" },
  { id: "vnd_akko", name: "AkkoCloud", url: "https://akkocloud.com" },
  { id: "derived:gomami", name: "Gomami" },
  { id: "derived:aaitr", name: "AaiTr" },
  { id: "derived:volc", name: "火山云" },
  { id: "derived:xuezhang", name: "xuezhang" },
];

function nodeId(index: number): string {
  return `node_${String(index + 1).padStart(3, "0")}`;
}

function toMachine(e: Entry, index: number): MachineView {
  const id = nodeId(index);
  const hostFacts = { hostname: e.node.toLowerCase(), os: e.os ?? "Debian 12", platform: "linux", arch: "amd64", cpu_cores: 2, memory_total: 2 * 1024 ** 3 };
  if (e.unprofiled) {
    return { node_id: id, node_name: e.node, online: !e.offline, host_facts: hostFacts } as MachineView;
  }
  const next = e.due === undefined ? undefined : dateIn(e.due);
  return {
    id: `mch_${String(index + 1).padStart(3, "0")}`,
    node_id: id,
    node_name: e.node,
    label: e.label ?? e.node,
    online: !e.offline,
    host_facts: hostFacts,
    vendor: e.vendor,
    region: e.region,
    notes: e.notes,
    price_cents: e.price ?? 0,
    currency: e.currency ?? "USD",
    purchased_at: e.purchasedDaysAgo === undefined ? undefined : dateIn(-e.purchasedDaysAgo),
    renewal_cycle: e.cycle ?? "",
    cycle_days: e.cycleDays ?? 0,
    next_renewal: next,
    days_until_renewal: daysUntil(next),
    auto_roll: !!e.autoRoll,
    remind_days_before: e.reminders ? [14, 7, 1] : [],
    reminders_enabled: !!e.reminders,
    has_console_url: !!e.console,
    has_detail_url: !!e.detail,
    updated_at: new Date(Date.now() - (index + 1) * 3 * DAY).toISOString(),
  } as MachineView;
}

let machines: MachineView[] = FLEET.map(toMachine);
let vendors: MachineVendorView[] = [...VENDORS];

const nodes: Node[] = FLEET.map((e, index) => ({
  id: nodeId(index),
  name: e.node,
  online: !e.offline,
  status: e.offline ? "offline" : "online",
  tags: [],
  last_seen: new Date().toISOString(),
}) as unknown as Node);

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: ["node:read", "inventory:read", "inventory:admin", "notify:admin"],
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

const channels: NotifyChannelView[] = [
  { id: "ch_bark", name: "Bark", type: "bark", enabled: true } as unknown as NotifyChannelView,
];

function advance(next: string | undefined, cycle: string, cycleDays: number): string | undefined {
  if (!next) return undefined;
  const d = new Date(next);
  if (cycle === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  else if (cycle === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (cycle === "semiannual") d.setUTCMonth(d.getUTCMonth() + 6);
  else if (cycle === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (cycle === "custom_days" && cycleDays > 0) d.setTime(d.getTime() + cycleDays * DAY);
  else return next;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function applyInput(base: MachineView, input: MachineProfileInput): MachineView {
  const next = input.next_renewal ?? undefined;
  return {
    ...base,
    ...input,
    id: base.id ?? input.id ?? `mch_new_${Date.now()}`,
    label: input.label || undefined,
    next_renewal: next,
    days_until_renewal: daysUntil(next),
    purchased_at: input.purchased_at ?? undefined,
    has_console_url: input.clear_console_url ? false : !!(input.console_url || base.has_console_url),
    has_detail_url: input.clear_detail_url ? false : !!(input.detail_url || base.has_detail_url),
    updated_at: new Date().toISOString(),
  } as MachineView;
}

export const api = {
  auth: {
    me: () => delay(principal),
  },
  nodes: {
    list: () => delay({ nodes: nodes.map((n) => ({ ...n })) }),
  },
  machines: {
    list: () => delay({ machines: machines.map((m) => ({ ...m })) }),
    create: (input: MachineProfileInput) => {
      const index = machines.findIndex((m) => m.node_id === input.node_id);
      const saved = applyInput(machines[index] ?? ({ node_id: input.node_id, online: true } as MachineView), input);
      machines = machines.map((m, i) => (i === index ? saved : m));
      return delay({ ...saved });
    },
    update: (input: MachineProfileInput & { id: string }) => {
      const base = machines.find((m) => m.id === input.id);
      if (!base) return Promise.reject(new Error("machine profile not found"));
      const saved = applyInput(base, input);
      machines = machines.map((m) => (m === base ? saved : m));
      return delay({ ...saved });
    },
    delete: (id: string) => {
      machines = machines.map((m) =>
        m.id === id ? ({ node_id: m.node_id, node_name: m.node_name, online: m.online, host_facts: m.host_facts } as MachineView) : m,
      );
      return delay({ ok: true });
    },
    renew: (id: string, nextRenewal?: string) => {
      const base = machines.find((m) => m.id === id);
      if (!base) return Promise.reject(new Error("machine profile not found"));
      const next = nextRenewal ?? advance(base.next_renewal, String(base.renewal_cycle ?? ""), base.cycle_days ?? 0);
      const saved: MachineView = { ...base, next_renewal: next, days_until_renewal: daysUntil(next), updated_at: new Date().toISOString() };
      machines = machines.map((m) => (m === base ? saved : m));
      return delay({ ...saved });
    },
    runReminders: () => delay({ fired: [] }),
  },
  machineVendors: {
    list: () => delay({ vendors: vendors.map((v) => ({ ...v })) }),
    upsert: (input: MachineVendorInput) => {
      const id = input.id && !input.id.startsWith("derived:") ? input.id : `vnd_${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
      const saved: MachineVendorView = { ...input, id };
      vendors = [...vendors.filter((v) => v.id !== id && v.name !== input.name), saved];
      return delay({ vendor: saved });
    },
  },
  notify: {
    channels: () => delay(channels.map((c) => ({ ...c }))),
    rules: () => delay({ rules: [] }),
  },
} as unknown as typeof import("@/lib/api/index").api;
