<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import {
  Bell,
  BellOff,
  BookOpen,
  Boxes,
  CalendarClock,
  ChevronRight,
  Cpu,
  ExternalLink,
  HardDrive,
  KeyRound,
  Link as LinkIcon,
  MemoryStick,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type MachineProfileInput,
  type MachineVendorView,
  type MachineView,
  type NotifyChannelView,
  type NotifyRuleView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useStepUp } from "@/composables/useStepUp";
import { useAuthStore } from "@/stores/auth";
import {
  formatBytes,
  formatMoney,
  formatRelativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  DEFAULT_INVENTORY_GROUP,
  INVENTORY_GROUPS,
  orderForGroup,
  orderMachines,
  parseInventoryGroup,
  type InventoryGroupBy,
} from "./inventoryGroupingModel";
import {
  advanceRenewal,
  daysBetween,
  formatDay,
  monthlyEquivalentCents,
  parseReminderDaysInput,
  rollForwardPast,
} from "./inventoryEditorModel";
import { DEFAULT_REMIND_DAYS, hasRenewalDate, nextReminder, ruleRoutesRenewals } from "./reminderModel";
import { nameParts } from "./nodesTableModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RenewalTone = "default" | "success" | "warning" | "destructive";
type BillingCategory = "renewalIncomplete" | "recurring" | "onetime" | "free" | "unpriced" | "unprofiled";
type GroupBy = InventoryGroupBy;

// Approx. days per month, used to normalise custom-day billing cycles to a
// monthly-equivalent figure (365.25 / 12).
const DAYS_PER_MONTH = 30.4375;
const COMMON_CURRENCIES = ["USD", "CNY", "CHY", "HKD", "JPY", "EUR", "GBP", "SGD", "USDT", "USDC"];
const NO_RENEWAL_CYCLE = "__none";
// Monthly divisor per named cycle; custom_days is handled separately.
const CYCLE_DIVISOR: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

// Trimmed string coercion. Guards against non-string reactive values: shadcn
// <Input type="number"> binds through defineModel<string|number>, so a numeric
// field can hold a real `number`, and calling `.trim()` on it used to throw
// "value.trim is not a function" on submit.
function s(value: unknown): string {
  return String(value ?? "").trim();
}

const auth = useAuthStore();
const { t } = useI18n();
const INVENTORY_GUIDE_URL = "https://latticenet.github.io/guide/operations#machine-inventory";
const NOTIFICATIONS_ROUTE = "/platform/notifications";
const warningPanelClass =
  "rounded-md border border-amber-400/60 bg-amber-500/15 p-3 text-xs text-foreground shadow-sm dark:border-amber-300/40 dark:bg-amber-400/15";

const machinesQuery = useAsyncData((signal) => api.machines.list({ signal }).then((r) => unwrap(r, "machines")), {
  pollInterval: 12000,
});
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});
const vendorsQuery = useAsyncData(
  (signal) => api.machineVendors.list({ signal }).then((r) => (Array.isArray(r) ? r : (r.vendors ?? []))),
  { pollInterval: 60000 },
);
const canManageNotifications = computed(() => auth.can("notify:admin"));
const notifyChannelsQuery = useAsyncData(
  (signal) => (canManageNotifications.value ? api.notify.channels({ signal }) : Promise.resolve([] as NotifyChannelView[])),
  { pollInterval: 30000 },
);
const notifyRulesQuery = useAsyncData(
  (signal) =>
    canManageNotifications.value
      ? api.notify.rules({ signal }).then((r) => unwrap(r, "rules"))
      : Promise.resolve([] as NotifyRuleView[]),
  { pollInterval: 30000 },
);

// ── View state ──────────────────────────────────────────────────────────────
const owned = useOwnedRoute();
// Search and grouping live in the address bar, so a reload and back/forward
// land on the same list. One way: read from the query, written only by the
// operator's change, so nothing rewrites the next page's keys while leaving.
const search = bindQueryParam<string>(owned, "q", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => (value.trim() ? value : undefined),
});
const groupBy = bindQueryParam<GroupBy>(owned, "group", {
  parse: (raw) => parseInventoryGroup(raw),
  format: (group) => (group === DEFAULT_INVENTORY_GROUP ? undefined : group),
});
/** One machine open in the sheet: its profile id, or its node id when it has no profile. */
const sheet = bindRouteOpen(owned);

// ── Edit dialog state ─────────────────────────────────────────────────────────
const editOpen = ref(false);
const editKey = ref("");
const pending = ref(false);
const deletePending = ref(false);
const deleteOpen = ref(false);
const renewPending = ref(false);
const linkRevealPending = ref("");

// ── Form model (populated when the edit dialog opens) ─────────────────────────
const profileId = ref("");
const nodeId = ref("");
const label = ref("");
const vendor = ref("");
const vendorProfileId = ref("");
const vendorUrl = ref("");
const vendorLogoUrl = ref("");
const vendorDescription = ref("");
const region = ref("");
const notes = ref("");
const priceMajor = ref("");
const currency = ref("USD");
const purchasedAt = ref("");
const needsRenewal = ref(false);
const renewalCycle = ref("");
const cycleDays = ref("");
const nextRenewal = ref("");
const autoRoll = ref(false);
const remindersEnabled = ref(false);
/**
 * Reminders are on by default for a machine with a renewal date (design 22).
 * A profile loaded without a date cannot have had them on, so its "off" is not
 * a choice: the box follows the date until the operator touches it.
 */
const remindersFollowDate = ref(false);
const remindDays = ref(DEFAULT_REMIND_DAYS.join(","));
const consoleUrl = ref("");
const detailUrl = ref("");
const clearConsoleUrl = ref(false);
const clearDetailUrl = ref(false);

const machines = computed(() => machinesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const vendors = computed(() => vendorsQuery.data.value ?? []);
const notifyChannels = computed(() => notifyChannelsQuery.data.value ?? []);
const notifyRules = computed(() => notifyRulesQuery.data.value ?? []);
const canAdminInventory = computed(() => auth.can("inventory:admin"));
const inventoryStepUp = useStepUp({
  required: t("fleet.inventory.stepUp.required"),
  failed: t("fleet.inventory.stepUp.failed"),
  passkeyFailed: t("fleet.inventory.stepUp.passkeyFailed"),
});
const stepUpOpen = inventoryStepUp.open;
const stepUpCode = inventoryStepUp.code;
const stepUpError = inventoryStepUp.error;
const stepUpPending = inventoryStepUp.pending;

const editMachine = computed(() =>
  machines.value.find((machine) => machineKey(machine) === editKey.value),
);
const editHasProfile = computed(() => !!profileId.value);
const calculatedNextRenewal = computed(() => calculateNextRenewalFromPurchase());
const customCycleValid = computed(
  () => renewalCycle.value !== "custom_days" || (Number.isInteger(Number(s(cycleDays.value))) && Number(s(cycleDays.value)) > 0),
);
const hasEffectiveNextRenewal = computed(() => !!(nextRenewal.value || calculatedNextRenewal.value));
const renewalSetupComplete = computed(
  () =>
    !needsRenewal.value ||
    (!!renewalCycle.value && customCycleValid.value && hasEffectiveNextRenewal.value),
);
/** Reminder offsets as typed; what is not a whole day in range is named, not dropped. */
const draftReminderDays = computed(() => parseReminderDaysInput(s(remindDays.value)));
const renewalBlocksSave = computed(
  () =>
    needsRenewal.value &&
    (!customCycleValid.value ||
      (autoRoll.value && !renewalCycle.value) ||
      (remindersEnabled.value && (!hasEffectiveNextRenewal.value || draftReminderDays.value.days.length === 0))),
);
const renewalDraftIncomplete = computed(() => needsRenewal.value && !renewalSetupComplete.value);
const canSave = computed(
  () => !!nodeId.value && canAdminInventory.value && !renewalBlocksSave.value,
);
const enabledNotifyChannels = computed(() => notifyChannels.value.filter((channel) => channel.enabled));
const enabledNotifyRules = computed(() => notifyRules.value.filter((rule) => rule.enabled));
const renewalNotificationReady = computed(() => {
  if (!canManageNotifications.value) return true;
  if (enabledNotifyChannels.value.length === 0) return false;
  if (enabledNotifyRules.value.length === 0) return true;
  return enabledNotifyRules.value.some((rule) => {
    const events = rule.event_types ?? [];
    return (
      events.length === 0 ||
      events.includes("*") ||
      events.includes("inventory.renewal") ||
      events.includes("generic")
    );
  });
});

const vendorByName = computed(() => {
  const out = new Map<string, MachineVendorView>();
  for (const item of vendors.value) {
    const key = normalizeVendorKey(item.name);
    if (key) out.set(key, item);
  }
  return out;
});

const selectedVendorProfile = computed(() => vendorByName.value.get(normalizeVendorKey(vendor.value)));
const vendorChoices = computed(() =>
  vendors.value
    .filter((item) => !!s(item.name))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

/**
 * The Node picker's items as one keyed list. reka-ui removes a Select option
 * by value when an item unmounts, so the separate fallback item this used to
 * render for a node missing from the list took the real node's option with it
 * as soon as the list loaded or refreshed, and the picker showed its
 * placeholder instead of the machine's node.
 */
const nodeChoices = computed(() => {
  const list = nodes.value.map((node) => ({ id: node.id, label: node.name || node.id }));
  if (nodeId.value && !list.some((choice) => choice.id === nodeId.value)) {
    list.push({ id: nodeId.value, label: editMachine.value?.node_name || nodeId.value });
  }
  return list;
});

const currencyOptions = computed(() => {
  const items = new Set<string>(COMMON_CURRENCIES);
  if (currency.value) items.add(normalizeCurrency(currency.value));
  for (const entry of spendByCurrency.value) items.add(normalizeCurrency(entry.currency));
  return [...items].filter(Boolean).sort((a, b) => a.localeCompare(b));
});
const renewalCycleSelect = computed({
  get: () => renewalCycle.value || NO_RENEWAL_CYCLE,
  set: (value: string) => {
    renewalCycle.value = value === NO_RENEWAL_CYCLE ? "" : value;
  },
});

// ── Cost model ────────────────────────────────────────────────────────────────
function machinePrice(machine: MachineView): number {
  return machine.price_cents ?? 0;
}

function renewalDate(machine?: MachineView): string {
  const date = formatDate(machine?.next_renewal);
  if (!date || date.startsWith("0001-")) return "";
  return date;
}

function hasRenewalIntent(machine: MachineView): boolean {
  return !!(
    machine.renewal_cycle ||
    renewalDate(machine) ||
    machine.auto_roll ||
    machine.reminders_enabled ||
    machine.remind_days_before?.length
  );
}

function renewalSetupIncomplete(machine: MachineView): boolean {
  if (!hasRenewalIntent(machine)) return false;
  return !machine.renewal_cycle || !renewalDate(machine);
}

function billingCategory(machine: MachineView): BillingCategory {
  if (!machine.id) return "unprofiled";
  if (renewalSetupIncomplete(machine)) return "renewalIncomplete";
  const price = machinePrice(machine);
  if (price > 0) return machine.renewal_cycle ? "recurring" : "onetime";
  // Price 0/unset: a machine that is being billed (has a renewal cycle or a
  // tracked renewal date) but has no price entered is "needs pricing"; a machine
  // with no billing signal at all is genuinely free.
  return hasRenewalIntent(machine) ? "unpriced" : "free";
}

// Monthly-equivalent cost in cents for a recurring machine; 0 otherwise.
function monthlyEquivCents(machine: MachineView): number {
  if (billingCategory(machine) !== "recurring") return 0;
  const price = machinePrice(machine);
  const cycle = machine.renewal_cycle;
  if (cycle === "custom_days") {
    const days = machine.cycle_days ?? 0;
    if (days <= 0) return price; // treat unknown span as monthly
    return (price * DAYS_PER_MONTH) / days;
  }
  const divisor = CYCLE_DIVISOR[cycle as string] ?? 1;
  return price / divisor;
}

type CurrencySpend = { currency: string; monthly: number; annual: number; count: number };

function aggregateSpend(list: MachineView[]): CurrencySpend[] {
  const acc = new Map<string, CurrencySpend>();
  for (const machine of list) {
    if (billingCategory(machine) !== "recurring") continue;
    const cur = machine.currency || "USD";
    const monthly = monthlyEquivCents(machine);
    const entry = acc.get(cur) ?? { currency: cur, monthly: 0, annual: 0, count: 0 };
    entry.monthly += monthly;
    entry.annual += monthly * 12;
    entry.count += 1;
    acc.set(cur, entry);
  }
  return [...acc.values()].sort((a, b) => b.monthly - a.monthly);
}

const spendByCurrency = computed<CurrencySpend[]>(() => aggregateSpend(machines.value));
// ── Fleet counters ────────────────────────────────────────────────────────────
const freeCount = computed(() => machines.value.filter((m) => billingCategory(m) === "free").length);

// ── Search + grouping ─────────────────────────────────────────────────────────
const filteredMachines = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return machines.value;
  return machines.value.filter((m) =>
    [m.label, m.node_name, m.node_id, m.vendor, m.region, m.host_facts?.hostname]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(q)),
  );
});

type MachineGroup = {
  key: string;
  label: string;
  machines: MachineView[];
  spend: CurrencySpend[];
};

const BILLING_ORDER: BillingCategory[] = ["renewalIncomplete", "recurring", "unpriced", "onetime", "free", "unprofiled"];

const groups = computed<MachineGroup[]>(() => {
  const list = filteredMachines.value;
  if (list.length === 0) return [];

  const order = orderForGroup(groupBy.value);
  const build = (key: string, labelText: string, items: MachineView[]): MachineGroup => ({
    key,
    label: labelText,
    machines: orderMachines(items, order, displayName, (machine) => !!renewalDate(machine)),
    spend: aggregateSpend(items),
  });

  if (groupBy.value === "none") {
    return [build("all", t("fleet.inventory.group.ungrouped"), list)];
  }

  if (groupBy.value === "billing") {
    return BILLING_ORDER.map((cat) => {
      const items = list.filter((m) => billingCategory(m) === cat);
      if (items.length === 0) return undefined;
      return build(cat, t(`fleet.inventory.billing.${cat}`), items);
    }).filter((g): g is MachineGroup => !!g);
  }

  if (groupBy.value === "renewal") {
    const bucket = (m: MachineView): string => {
      if (renewalSetupIncomplete(m)) return "incomplete";
      if (!renewalDate(m)) return "notTracked";
      const days = m.days_until_renewal;
      if (days === undefined) return "upcoming";
      if (days < 0) return "overdue";
      if (days <= 14) return "dueSoon";
      return "upcoming";
    };
    const order = ["incomplete", "overdue", "dueSoon", "upcoming", "notTracked"];
    return order
      .map((key) => {
        const items = list.filter((m) => bucket(m) === key);
        if (items.length === 0) return undefined;
        return build(key, t(`fleet.inventory.renewalGroup.${key}`), items);
      })
      .filter((g): g is MachineGroup => !!g);
  }

  // vendor | region
  const field = groupBy.value;
  const unknownLabel =
    field === "vendor"
      ? t("fleet.inventory.group.unknownVendor")
      : t("fleet.inventory.group.unknownRegion");
  const acc = new Map<string, MachineView[]>();
  for (const machine of list) {
    const raw = field === "vendor" ? machine.vendor : machine.region;
    const key = s(raw) || "__unknown__";
    acc.set(key, [...(acc.get(key) ?? []), machine]);
  }
  return [...acc.entries()]
    .sort((a, b) => {
      if (a[0] === "__unknown__") return 1;
      if (b[0] === "__unknown__") return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    })
    .map(([key, items]) => build(key, key === "__unknown__" ? unknownLabel : key, items));
});

const groupOptions = INVENTORY_GROUPS;

// ── Deep links ────────────────────────────────────────────────────────────────
// ?machine=<profile id> (the link the Upcoming list gives a renewal) and
// ?node=<node id> (the node page's link) open that machine's sheet: once the
// list has loaded they are rewritten to ?open=, with replace, so a reload and
// Back keep the sheet and the old keys stop at the first read.
watch(
  [machines, () => owned.query().node, () => owned.query().machine],
  ([list, nodeQ, machineQ]) => {
    if (!owned.owns()) return;
    const nodeId = typeof nodeQ === "string" ? nodeQ : undefined;
    const profileId = typeof machineQ === "string" ? machineQ : undefined;
    if ((!nodeId && !profileId) || list.length === 0) return;
    const m = list.find((x) => (profileId ? x.id === profileId : x.node_id === nodeId));
    const query = { ...owned.query() };
    delete query.node;
    delete query.machine;
    if (m) query.open = sheetId(m);
    owned.replace(query);
  },
  { immediate: true },
);

/** The id a machine's sheet opens on. */
function sheetId(machine: MachineView): string {
  return machine.id || machine.node_id;
}

// ── Reminder indicator ─────────────────────────────────────────────────────
function reminderWhen(inDays: number, at: string): string {
  if (inDays <= 0) return t("fleet.inventory.list.whenToday");
  if (inDays === 1) return t("fleet.inventory.list.whenTomorrow");
  return t("fleet.inventory.list.whenDate", { date: at });
}

/** The row's reminder in one sentence: off, or when the next one goes out. */
function reminderHint(machine: MachineView): string {
  if (!machine.reminders_enabled) return t("fleet.inventory.list.reminderOffHint");
  const next = nextReminder(machine, formatDay(new Date()));
  if (!next) return t("fleet.inventory.list.reminderNone");
  const when = reminderWhen(next.inDays, next.at);
  if (next.offset >= 0) return t("fleet.inventory.list.reminderNext", { when, offset: next.offset, renewal: next.renewal });
  if (next.inDays > 0) return t("fleet.inventory.list.reminderNextAfterDate", { when, renewal: next.renewal });
  return t("fleet.inventory.list.reminderNextOverdue", { renewal: next.renewal, until: next.repeatsUntil });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function machineKey(machine: MachineView): string {
  return machine.id || `node:${machine.node_id}`;
}

function displayName(machine: MachineView): string {
  return machine.label || machine.node_name || machine.node_id;
}

function normalizeVendorKey(value?: string): string {
  return s(value).toLowerCase();
}

function normalizeCurrency(value: unknown): string {
  return s(value).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
}

function nodeInventoryFor(nodeID?: string) {
  if (!nodeID) return undefined;
  return nodes.value.find((node) => node.id === nodeID)?.inventory ?? undefined;
}

function vendorProfileFor(machine: MachineView): MachineVendorView | undefined {
  return machine.vendor_profile ?? vendorByName.value.get(normalizeVendorKey(machine.vendor));
}

function vendorHost(profile?: MachineVendorView): string {
  if (!profile?.url) return "";
  try {
    return new URL(profile.url).host.replace(/^www\./, "");
  } catch {
    return profile.url;
  }
}

function vendorSubtitle(profile?: MachineVendorView): string {
  if (!profile) return "";
  return vendorHost(profile) || (profile.id.startsWith("derived:") ? t("fleet.inventory.profile.vendorDerivedHint") : "");
}

function billingBadgeVariant(cat: BillingCategory): "secondary" | "success" | "warning" | "outline" {
  if (cat === "free") return "success";
  if (cat === "unpriced" || cat === "unprofiled") return "warning";
  if (cat === "onetime") return "outline";
  return "secondary";
}

function renewalTone(machine?: MachineView): RenewalTone {
  if (machine && renewalSetupIncomplete(machine)) return "warning";
  const days = machine?.days_until_renewal;
  if (days === undefined || !renewalDate(machine)) return "default";
  if (days < 0) return "destructive";
  if (days <= 14) return "warning";
  return "success";
}

function renewalLabel(machine?: MachineView): string {
  if (machine && renewalSetupIncomplete(machine)) return t("fleet.inventory.renewal.incomplete");
  const next = renewalDate(machine);
  if (!next) return t("fleet.inventory.renewal.notTracked");
  if (!machine) return t("fleet.inventory.renewal.notTracked");
  const days = machine.days_until_renewal;
  if (days === undefined) return next;
  if (days < 0) return t("fleet.inventory.renewal.overdue", { days: Math.abs(days) });
  if (days === 0) return t("fleet.inventory.renewal.dueToday");
  return t("fleet.inventory.renewal.daysLeft", { days });
}

function formatDate(input?: string): string {
  if (!input) return "";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function isoDate(input: string): string | undefined {
  if (!input) return undefined;
  return `${input}T00:00:00Z`;
}

function dateFromInput(input: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s(input));
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addRenewalCycle(base: Date): Date | undefined {
  if (renewalCycle.value === "monthly") return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()));
  if (renewalCycle.value === "quarterly") return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 3, base.getUTCDate()));
  if (renewalCycle.value === "semiannual") return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 6, base.getUTCDate()));
  if (renewalCycle.value === "annual") return new Date(Date.UTC(base.getUTCFullYear() + 1, base.getUTCMonth(), base.getUTCDate()));
  if (renewalCycle.value === "custom_days") {
    const days = Number(s(cycleDays.value));
    if (!Number.isInteger(days) || days <= 0) return undefined;
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  }
  return undefined;
}

function calculateNextRenewalFromPurchase(): string {
  // Not gated on needsRenewal: switching a machine to one-time keeps the
  // renewal draft so switching back restores it, and buildInput is what leaves
  // the draft out of a save.
  if (!renewalCycle.value) return "";
  const start = dateFromInput(purchasedAt.value);
  if (!start) return "";
  const today = dateFromInput(dateInput(new Date()))!;
  let next = start;
  let guard = 0;
  while (next < today && guard < 1000) {
    const advanced = addRenewalCycle(next);
    if (!advanced || advanced.getTime() === next.getTime()) return "";
    next = advanced;
    guard += 1;
  }
  return dateInput(next);
}

function useCalculatedRenewal(): void {
  if (calculatedNextRenewal.value) nextRenewal.value = calculatedNextRenewal.value;
}

// ── Editor: the draft read back, and the unsaved-change guard ─────────────────
const draftPriceCents = computed(() => parsePriceCents() ?? 0);
const draftCurrency = computed(() => normalizeCurrency(currency.value) || "USD");
const draftCycleDays = computed(() => Number(s(cycleDays.value)) || 0);
const draftNextRenewal = computed(() => (needsRenewal.value ? nextRenewal.value || calculatedNextRenewal.value : ""));

const draftMonthlyLabel = computed(() => {
  if (!needsRenewal.value || renewalCycle.value === "monthly") return "";
  const cents = monthlyEquivalentCents(draftPriceCents.value, renewalCycle.value, draftCycleDays.value);
  if (!cents) return "";
  return t("fleet.inventory.profile.monthlyEquivalent", { amount: formatMoney(Math.round(cents), draftCurrency.value) });
});

function renewalCountdown(day: string): string {
  const days = daysBetween(formatDay(new Date()), day);
  if (days === undefined) return "";
  if (days < 0) return t("fleet.inventory.renewal.overdue", { days: Math.abs(days) });
  if (days === 0) return t("fleet.inventory.renewal.dueToday");
  return t("fleet.inventory.renewal.daysLeft", { days });
}

/**
 * The form read back as one line, in the words the list's cards use ("Free",
 * "One-time", "not priced"), so what a save would write can be checked
 * without scrolling the form. It is the editor's proof line and changes as
 * the fields change.
 */
const draftSummary = computed(() => {
  const cents = draftPriceCents.value;
  const price = cents > 0 ? formatMoney(cents, draftCurrency.value) : t("fleet.inventory.price.notPriced");
  if (!needsRenewal.value) {
    return cents > 0 ? [price, t("fleet.inventory.billing.onetime")] : [t("fleet.inventory.billing.free")];
  }
  const parts = [price];
  if (renewalCycle.value === "custom_days") {
    parts.push(
      customCycleValid.value
        ? t("fleet.inventory.cycleLabel.customDays", { days: draftCycleDays.value })
        : t("fleet.inventory.profile.cycleDaysMissing"),
    );
  } else if (renewalCycle.value) {
    parts.push(t(`fleet.inventory.profile.cycle.${renewalCycle.value}`));
  }
  if (draftMonthlyLabel.value) parts.push(draftMonthlyLabel.value);
  const next = draftNextRenewal.value;
  if (next && renewalCycle.value) {
    const countdown = renewalCountdown(next);
    parts.push(`${t("fleet.inventory.profile.summaryNextRenewal", { date: next })}${countdown ? ` (${countdown})` : ""}`);
  } else {
    parts.push(t("fleet.inventory.renewal.incomplete"));
  }
  if (!remindersEnabled.value) {
    parts.push(t("fleet.inventory.profile.summaryRemindersOff"));
  } else if (draftReminderDays.value.days.length) {
    parts.push(t("fleet.inventory.profile.summaryRemindersOn", { days: draftReminderDays.value.days.join(", ") }));
  } else {
    parts.push(t("fleet.inventory.profile.summaryRemindersNoDays"));
  }
  return parts;
});

function fingerprintOf(input: MachineProfileInput, withoutNextRenewal = false): string {
  return JSON.stringify({
    ...input,
    next_renewal: withoutNextRenewal ? null : input.next_renewal,
    vendor_url: s(vendorUrl.value),
    vendor_logo_url: s(vendorLogoUrl.value),
    vendor_description: s(vendorDescription.value),
  });
}

/**
 * What a save would send, plus the vendor fields saved beside it.
 * `withoutNextRenewal` masks the one field Record renewal is allowed to carry.
 */
function formFingerprint(withoutNextRenewal = false): string {
  return fingerprintOf(buildInput(), withoutNextRenewal);
}

/**
 * Two baselines, taken once the watchers a form load sets off have run.
 *
 * `saved` is what the server holds: Save is enabled, and Record renewal waits,
 * when the form differs from it. `opened` is the form as it first appeared,
 * suggestions included: closing asks before discarding only when something
 * changed since then. They differ when the form fills in a next renewal the
 * profile never saved (a Setup needed machine). That date is a suggestion the
 * operator must be able to save as it stands, and to walk away from without a
 * prompt.
 */
const formSnapshot = ref<{ saved: string; savedWithoutNextRenewal: string; opened: string; savedNextRenewal: string }>();
const discardOpen = ref(false);

async function snapshotForm(machine: MachineView): Promise<void> {
  await nextTick();
  const current = buildInput();
  const savedNextRenewal = renewalDate(machine);
  const saved: MachineProfileInput = {
    ...current,
    next_renewal: needsRenewal.value && savedNextRenewal ? (isoDate(savedNextRenewal) ?? null) : null,
  };
  formSnapshot.value = {
    saved: fingerprintOf(saved),
    savedWithoutNextRenewal: fingerprintOf(saved, true),
    opened: fingerprintOf(current),
    savedNextRenewal,
  };
}

const formDirty = computed(() => !!formSnapshot.value && formFingerprint() !== formSnapshot.value.saved);
const draftBeyondNextRenewal = computed(
  () => !!formSnapshot.value && formFingerprint(true) !== formSnapshot.value.savedWithoutNextRenewal,
);
const editedSinceOpen = computed(() => !!formSnapshot.value && formFingerprint() !== formSnapshot.value.opened);

/** The next renewal on screen is one the form filled in, not one the profile has saved. */
const nextRenewalIsSuggestion = computed(
  () =>
    editHasProfile.value &&
    needsRenewal.value &&
    !!nextRenewal.value &&
    !!formSnapshot.value &&
    !formSnapshot.value.savedNextRenewal,
);

watch(editOpen, (open) => {
  if (open) return;
  formSnapshot.value = undefined;
  discardOpen.value = false;
});

/** Every way out of the editor comes through here: Escape, the overlay, the close button and Cancel. */
function requestEditOpen(open: boolean): void {
  if (!open && editedSinceOpen.value) {
    discardOpen.value = true;
    return;
  }
  editOpen.value = open;
}

function discardChanges(): void {
  discardOpen.value = false;
  editOpen.value = false;
}

/**
 * Focus lands on the dialog's heading, not its first field. The first field
 * is Label, and focusing an input that holds a value selects it, so the first
 * key typed would replace the machine's name; with nothing focused inside,
 * the focus trap has nothing to hold and Tab walks the page behind the overlay.
 */
function focusEditorOnOpen(event: Event): void {
  event.preventDefault();
  document.querySelector<HTMLElement>("[data-editor-title]")?.focus({ preventScroll: true });
}

/**
 * Recording a renewal writes to the saved profile and reloads the form from
 * the server's answer, so it waits until other edits are saved or discarded.
 * With auto-roll off it takes the date typed above, the one edit it may carry.
 */
const renewBlockedByDraft = computed(() => (autoRoll.value ? formDirty.value : draftBeyondNextRenewal.value));
const canRecordRenewal = computed(
  () =>
    editHasProfile.value &&
    needsRenewal.value &&
    customCycleValid.value &&
    !renewBlockedByDraft.value &&
    (autoRoll.value ? !!nextRenewal.value && !!renewalCycle.value : !!nextRenewal.value),
);

/**
 * With auto-roll off, recording a renewal keeps the date typed above. When
 * that date is today or already past, this is the first renewal after today,
 * rolled forward by the cycle, offered beside the preview.
 */
const renewRollForwardDate = computed(() => {
  if (autoRoll.value || !needsRenewal.value || !nextRenewal.value || renewBlockedByDraft.value) return undefined;
  return rollForwardPast(nextRenewal.value, renewalCycle.value, draftCycleDays.value, formatDay(new Date()));
});

const renewPreview = computed(() => {
  if (!editHasProfile.value || !needsRenewal.value) return "";
  if (renewBlockedByDraft.value) return t("fleet.inventory.profile.recordRenewalSaveFirst");
  const today = formatDay(new Date());
  if (autoRoll.value) {
    const to = advanceRenewal(nextRenewal.value, renewalCycle.value, draftCycleDays.value);
    if (!to) return "";
    const stillPast = (daysBetween(today, to) ?? 0) < 0;
    return stillPast
      ? t("fleet.inventory.profile.recordRenewalAutoRollStillPast", { from: nextRenewal.value, to })
      : t("fleet.inventory.profile.recordRenewalAutoRoll", { from: nextRenewal.value, to });
  }
  if (!nextRenewal.value) return "";
  return (daysBetween(today, nextRenewal.value) ?? 0) < 0
    ? t("fleet.inventory.profile.recordRenewalManualPast", { date: nextRenewal.value })
    : t("fleet.inventory.profile.recordRenewalManual", { date: nextRenewal.value });
});

const storedLinkCount = computed(
  () => (editMachine.value?.has_console_url ? 1 : 0) + (editMachine.value?.has_detail_url ? 1 : 0),
);

const vendorDetailsSummary = computed(() => {
  const url = s(vendorUrl.value);
  if (url) {
    try {
      return new URL(url).host.replace(/^www\./, "");
    } catch {
      return url;
    }
  }
  return s(vendorDescription.value) || s(vendorLogoUrl.value) ? "" : t("fleet.inventory.profile.vendorDetailsEmpty");
});

/** The segmented control's two states, in the same selection style the Nodes toggles use. */
function segmentClass(active: boolean): string {
  return cn(
    "rounded px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
    active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
  );
}

function formatPrice(machine: MachineView): string {
  const cat = billingCategory(machine);
  if (cat === "free") return t("fleet.inventory.billing.free");
  if (!machine.price_cents) return t("fleet.inventory.price.notPriced");
  return formatMoney(machine.price_cents, machine.currency || "USD");
}

function formatCycle(machine: MachineView): string {
  if (!machine.renewal_cycle) return t("fleet.inventory.cycleLabel.noCycle");
  if (machine.renewal_cycle === "custom_days")
    return t("fleet.inventory.cycleLabel.customDays", { days: machine.cycle_days || 0 });
  return t(`fleet.inventory.profile.cycle.${machine.renewal_cycle}`);
}

function formatMonthlyEquiv(machine: MachineView): string {
  if (billingCategory(machine) !== "recurring") return "";
  return t("fleet.inventory.spend.perMonth", {
    amount: formatMoney(Math.round(monthlyEquivCents(machine)), machine.currency || "USD"),
  });
}

function groupSpendLabel(spend: CurrencySpend[]): string {
  if (spend.length === 0) return "";
  return spend
    .map((entry) =>
      t("fleet.inventory.spend.perMonth", {
        amount: formatMoney(Math.round(entry.monthly), entry.currency),
      }),
    )
    .join(" · ");
}

function linkPendingKey(machine: MachineView, kind: "console" | "detail"): string {
  return `${machine.id || machine.node_id}:${kind}`;
}

async function revealMachineLink(machine: MachineView, kind: "console" | "detail") {
  if (!machine.id || !canAdminInventory.value) return;
  const key = linkPendingKey(machine, kind);
  if (linkRevealPending.value) return;
  linkRevealPending.value = key;
  try {
    const grant = await inventoryStepUp.request();
    const revealed = await api.machines.revealLink(machine.id, kind, grant);
    window.open(revealed.url, "_blank", "noopener,noreferrer");
    toast.success(t("fleet.inventory.toast.linkOpened"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.linkRevealFailed"));
  } finally {
    linkRevealPending.value = "";
  }
}

// ── Edit dialog form lifecycle ────────────────────────────────────────────────
/**
 * The vendor directory fields as they were last filled in from a saved vendor.
 * When the name stops matching that vendor, the fields still holding those
 * values are cleared, so typing past "DMIT" to "DMIT Cloud" or to another name
 * does not carry DMIT's URL and notes to a different vendor. A field the
 * operator changed since the fill is theirs and stays.
 */
const vendorAutofill = ref<{ url: string; logo: string; description: string }>();

function rememberVendorAutofill() {
  vendorAutofill.value = { url: vendorUrl.value, logo: vendorLogoUrl.value, description: vendorDescription.value };
}

function loadForm(machine: MachineView) {
  profileId.value = machine.id || "";
  nodeId.value = machine.node_id;
  label.value = machine.label || "";
  vendor.value = machine.vendor || "";
  const vendorProfile = vendorProfileFor(machine);
  vendorProfileId.value = vendorProfile && !vendorProfile.id.startsWith("derived:") ? vendorProfile.id : "";
  vendorUrl.value = vendorProfile?.url || "";
  vendorLogoUrl.value = vendorProfile?.logo_url || "";
  vendorDescription.value = vendorProfile?.description || "";
  rememberVendorAutofill();
  region.value = machine.region || "";
  notes.value = machine.notes || "";
  priceMajor.value = machine.price_cents ? (machine.price_cents / 100).toFixed(2) : "";
  currency.value = normalizeCurrency(machine.currency) || "USD";
  purchasedAt.value = formatDate(machine.purchased_at);
  needsRenewal.value = !!(
    machine.renewal_cycle ||
    machine.next_renewal ||
    machine.auto_roll ||
    machine.reminders_enabled ||
    machine.remind_days_before?.length
  );
  renewalCycle.value = machine.renewal_cycle || "";
  cycleDays.value = machine.cycle_days ? String(machine.cycle_days) : "";
  nextRenewal.value = formatDate(machine.next_renewal);
  autoRoll.value = !!machine.auto_roll;
  remindersEnabled.value = !!machine.reminders_enabled;
  remindersFollowDate.value = !hasRenewalDate(machine);
  remindDays.value = (machine.remind_days_before?.length ? machine.remind_days_before : DEFAULT_REMIND_DAYS).join(
    ",",
  );
  consoleUrl.value = "";
  detailUrl.value = "";
  clearConsoleUrl.value = false;
  clearDetailUrl.value = false;
}

function syncVendorDetailsFromSelection() {
  const selected = selectedVendorProfile.value;
  if (!selected) {
    vendorProfileId.value = "";
    const filled = vendorAutofill.value;
    if (filled) {
      if (vendorUrl.value === filled.url) vendorUrl.value = "";
      if (vendorLogoUrl.value === filled.logo) vendorLogoUrl.value = "";
      if (vendorDescription.value === filled.description) vendorDescription.value = "";
      vendorAutofill.value = undefined;
    }
    return;
  }
  vendorProfileId.value = selected.id.startsWith("derived:") ? "" : selected.id;
  vendorUrl.value = selected.url || "";
  vendorLogoUrl.value = selected.logo_url || "";
  vendorDescription.value = selected.description || "";
  rememberVendorAutofill();
}

function openEdit(machine: MachineView) {
  editKey.value = machineKey(machine);
  loadForm(machine);
  editOpen.value = true;
  void snapshotForm(machine);
}

function parsePriceCents(): number | undefined {
  const trimmed = s(priceMajor.value);
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
}

function parseReminderDays(): number[] {
  return draftReminderDays.value.days;
}

function buildInput(): MachineProfileInput {
  const effectiveNextRenewal = needsRenewal.value
    ? nextRenewal.value || calculatedNextRenewal.value
    : "";
  return {
    id: profileId.value || undefined,
    node_id: nodeId.value,
    label: s(label.value),
    vendor: s(vendor.value),
    region: s(region.value),
    notes: s(notes.value),
    price_cents: parsePriceCents() ?? 0,
    currency: normalizeCurrency(currency.value) || "USD",
    purchased_at: isoDate(purchasedAt.value) ?? null,
    renewal_cycle: needsRenewal.value ? renewalCycle.value : "",
    cycle_days: needsRenewal.value && renewalCycle.value === "custom_days" ? Number(s(cycleDays.value) || 0) : 0,
    next_renewal: needsRenewal.value ? isoDate(effectiveNextRenewal) ?? null : null,
    auto_roll: needsRenewal.value && autoRoll.value,
    remind_days_before: needsRenewal.value ? parseReminderDays() : [],
    reminders_enabled: needsRenewal.value && remindersEnabled.value,
    console_url: s(consoleUrl.value) || undefined,
    detail_url: s(detailUrl.value) || undefined,
    clear_console_url: clearConsoleUrl.value,
    clear_detail_url: clearDetailUrl.value,
  };
}

async function saveVendorMetadataIfNeeded() {
  const name = s(vendor.value);
  if (!name) return;
  const selected = selectedVendorProfile.value;
  const hasDetails = !!(s(vendorUrl.value) || s(vendorLogoUrl.value) || s(vendorDescription.value));
  const selectedIsExplicit = !!selected && !selected.id.startsWith("derived:");
  if (!hasDetails && !selectedIsExplicit && !vendorProfileId.value) return;
  const res = await api.machineVendors.upsert({
    id: vendorProfileId.value || (selectedIsExplicit ? selected?.id : undefined),
    name,
    url: s(vendorUrl.value),
    logo_url: s(vendorLogoUrl.value),
    description: s(vendorDescription.value),
  });
  vendorProfileId.value = res.vendor.id;
  await vendorsQuery.refresh();
}

// Switching a machine to one-time keeps the renewal draft instead of wiping
// it, so switching back restores what was there; buildInput sends none of it
// while the machine is one-time. Auto-roll and reminders still clear when what
// they depend on goes away: a cycle, a date.
watch(renewalCycle, (cycle) => {
  if (!cycle) autoRoll.value = false;
});

watch([nextRenewal, calculatedNextRenewal], () => {
  if (!hasEffectiveNextRenewal.value) remindersEnabled.value = false;
  else if (remindersFollowDate.value) remindersEnabled.value = true;
});

watch([purchasedAt, renewalCycle, cycleDays, needsRenewal], () => {
  if (needsRenewal.value && !nextRenewal.value && calculatedNextRenewal.value) {
    nextRenewal.value = calculatedNextRenewal.value;
  }
});

watch(vendor, (next, prev) => {
  if (normalizeVendorKey(next) === normalizeVendorKey(prev)) return;
  syncVendorDetailsFromSelection();
});


async function refreshAll() {
  await Promise.all([machinesQuery.refresh(), nodesQuery.refresh(), vendorsQuery.refresh()]);
}

async function saveProfile() {
  if (!canSave.value) return;
  pending.value = true;
  try {
    const input = buildInput();
    const saved = profileId.value
      ? await api.machines.update({ ...input, id: profileId.value })
      : await api.machines.create(input);
    try {
      await saveVendorMetadataIfNeeded();
    } catch (vendorError) {
      toast.warning(vendorError instanceof Error ? vendorError.message : t("fleet.inventory.toast.vendorSaveFailed"));
    }
    toast.success(
      profileId.value
        ? t("fleet.inventory.toast.profileUpdated")
        : t("fleet.inventory.toast.profileCreated"),
    );
    editKey.value = machineKey(saved);
    loadForm(saved);
    editOpen.value = false;
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.saveFailed"));
  } finally {
    pending.value = false;
  }
}

/**
 * What a profile delete takes with it, from the saved profile (design 23,
 * 3.8: irreversible inside Lattice names what stops). The node itself stays.
 */
const deleteProfileImpact = computed(() => {
  const machine = editMachine.value;
  if (!machine?.id) return [];
  const out: string[] = [];
  const monthly = monthlyEquivCents(machine);
  if (monthly > 0) {
    out.push(t("fleet.inventory.profile.deleteImpact.cost", { amount: formatMoney(Math.round(monthly), machine.currency || "USD") }));
  }
  const date = renewalDate(machine);
  if (date) {
    out.push(machine.reminders_enabled ? t("fleet.inventory.profile.deleteImpact.renewalReminders", { date }) : t("fleet.inventory.profile.deleteImpact.renewal", { date }));
  }
  if (machine.has_console_url || machine.has_detail_url) out.push(t("fleet.inventory.profile.deleteImpact.links"));
  if (machine.notes?.trim()) out.push(t("fleet.inventory.profile.deleteImpact.notes"));
  return out;
});

async function deleteProfile() {
  if (!profileId.value) return;
  deletePending.value = true;
  try {
    await api.machines.delete(profileId.value);
    toast.success(t("fleet.inventory.toast.profileDeleted"));
    deleteOpen.value = false;
    editOpen.value = false;
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}

async function renewProfile() {
  // The button is disabled on the same condition; checked here as well so no
  // other caller can record a renewal over unsaved edits.
  if (!profileId.value || !canRecordRenewal.value) return;
  renewPending.value = true;
  try {
    const renewed = await api.machines.renew(
      profileId.value,
      autoRoll.value ? undefined : isoDate(nextRenewal.value),
    );
    toast.success(t("fleet.inventory.toast.renewalRecorded"));
    loadForm(renewed);
    void snapshotForm(renewed);
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.renewalFailed"));
  } finally {
    renewPending.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* Machines as a grouped table (design 23, 4.2)                        */
/* ------------------------------------------------------------------ */

const proof = useProof(machinesQuery);

/** The head states each currency rather than converting only what it has a rate for. */
const proofSegments = computed<ProofSegment[]>(() => {
  const out: ProofSegment[] = [{ key: "machines", text: t("fleet.inventory.proof.machines", { n: machines.value.length }, machines.value.length) }];
  for (const entry of spendByCurrency.value) {
    out.push({ key: `spend-${entry.currency}`, text: t("fleet.inventory.spend.perMonth", { amount: formatMoney(Math.round(entry.monthly), entry.currency) }), tone: "strong" });
  }
  const within30 = machines.value.filter((m) => renewalDate(m) && m.days_until_renewal !== undefined && m.days_until_renewal >= 0 && m.days_until_renewal <= 30).length;
  if (within30 > 0) out.push({ key: "renew30", text: t("fleet.inventory.proof.renew30", { n: within30 }), to: { query: { group: "renewal" } } });
  if (freeCount.value > 0) out.push({ key: "free", text: t("fleet.inventory.spend.free", { count: freeCount.value }), tone: "muted" });
  return out;
});

const overdueMachines = computed(() =>
  machines.value.filter((m) => !m.auto_roll && renewalDate(m) && m.days_until_renewal !== undefined && m.days_until_renewal < 0),
);
const incompleteMachines = computed(() => machines.value.filter((m) => renewalSetupIncomplete(m)));

const attention = computed<AttentionItem[]>(() => {
  const out: AttentionItem[] = [];
  const names = (list: MachineView[]) => {
    const shown = list.slice(0, 3).map(displayName).join(", ");
    return list.length > 3 ? `${shown} +${list.length - 3}` : shown;
  };
  if (overdueMachines.value.length) {
    out.push({
      key: "overdue",
      tone: "danger",
      claim: t("fleet.inventory.attention.overdue", { n: overdueMachines.value.length }, overdueMachines.value.length),
      proof: names(overdueMachines.value),
      action: { label: t("fleet.inventory.attention.open"), run: () => sheet.open(sheetId(overdueMachines.value[0]!)) },
    });
  }
  if (incompleteMachines.value.length) {
    out.push({
      key: "incomplete",
      tone: "warning",
      claim: t("fleet.inventory.attention.incomplete", { n: incompleteMachines.value.length }, incompleteMachines.value.length),
      proof: names(incompleteMachines.value),
      action: { label: t("fleet.inventory.attention.open"), run: () => sheet.open(sheetId(incompleteMachines.value[0]!)) },
    });
  }
  return out;
});

/** Rows in group order, each group ordered the way the old card wall ordered it. */
const tableRows = computed(() => groups.value.flatMap((group) => group.machines));
const groupOfRow = computed(() => {
  const map = new Map<string, string>();
  for (const group of groups.value) for (const machine of group.machines) map.set(machineKey(machine), group.key);
  return map;
});
const groupByKey = computed(() => new Map(groups.value.map((group) => [group.key, group])));
const groupKeyFn = computed(() => (groupBy.value === "none" ? undefined : (machine: MachineView) => groupOfRow.value.get(machineKey(machine)) ?? ""));
const groupOrderKeys = computed(() => groups.value.map((group) => group.key));
const collapsedGroups = ref(new Set<string>());

function renewalSortValue(machine: MachineView): number {
  return renewalDate(machine) && machine.days_until_renewal !== undefined ? machine.days_until_renewal : Number.MAX_SAFE_INTEGER;
}

const columns = computed<DataTableColumn<MachineView>[]>(() => [
  { key: "name", label: t("fleet.inventory.table.machine"), sortable: true, value: (m) => displayName(m).toLowerCase() },
  { key: "vendor", label: t("fleet.inventory.table.provider"), sortable: true, value: (m) => m.vendor ?? "" },
  { key: "region", label: t("fleet.inventory.table.region"), sortable: true, value: (m) => m.region ?? "" },
  { key: "price", label: t("fleet.inventory.table.price"), sortable: true, value: (m) => machinePrice(m) },
  { key: "monthly", label: t("fleet.inventory.table.monthly"), align: "right", sortable: true, value: (m) => monthlyEquivCents(m) },
  { key: "renewal", label: t("fleet.inventory.table.renewal"), sortable: true, value: renewalSortValue },
  // 44 px on a phone: the menu trigger, no padding around it (a 68 px column left 43 px for the rest).
  { key: "actions", label: "", class: "w-12 max-md:w-11 max-md:px-0", pin: "end" },
]);

function menuFor(machine: MachineView): RowMenuItem[] {
  return [
    {
      key: "edit",
      label: machine.id ? t("fleet.inventory.actions.edit") : t("fleet.inventory.actions.addProfile"),
      icon: machine.id ? Pencil : Plus,
      hidden: !canAdminInventory.value,
      run: () => openEdit(machine),
    },
    { key: "node", label: t("fleet.inventory.actions.node"), icon: ChevronRight, to: { name: "node-detail", params: { id: machine.node_id } } },
    {
      key: "console",
      label: t("fleet.inventory.list.openConsole"),
      icon: ExternalLink,
      hidden: !machine.has_console_url || !canAdminInventory.value,
      disabled: !!linkRevealPending.value,
      run: () => void revealMachineLink(machine, "console"),
    },
    {
      key: "detail",
      label: t("fleet.inventory.list.openDetail"),
      icon: ExternalLink,
      hidden: !machine.has_detail_url || !canAdminInventory.value,
      disabled: !!linkRevealPending.value,
      run: () => void revealMachineLink(machine, "detail"),
    },
  ];
}

const openMachine = computed(() =>
  sheet.openId.value ? machines.value.find((m) => m.id === sheet.openId.value || (!m.id && m.node_id === sheet.openId.value)) : undefined,
);
const sheetState = computed(() => {
  if (!sheet.openId.value) return "loading" as const;
  if (machinesQuery.data.value === undefined) {
    return machinesQuery.error.value && !machinesQuery.loading.value ? ("failed" as const) : ("loading" as const);
  }
  if (!openMachine.value) return "gone" as const;
  return machinesQuery.error.value ? ("stale" as const) : ("ready" as const);
});

/* ------------------------------------------------------------------ */
/* Preview reminders (design 23, 3.8: sends show what goes out)         */
/* ------------------------------------------------------------------ */

const previewOpen = ref(false);
const sendPending = ref(false);
const todayDay = computed(() => formatDay(new Date()));
/**
 * The profile the preview covers: one machine from its editor, or every
 * machine from the header. The send asks the server for the same scope, so
 * what the dialog lists is what the button pushes.
 */
const previewProfileId = ref<string | undefined>();
const previewMachine = computed(() => (previewProfileId.value ? machines.value.find((m) => m.id === previewProfileId.value) : undefined));
const previewPool = computed(() => machines.value.filter((m) => !!m.id && (!previewProfileId.value || m.id === previewProfileId.value)));

function openPreview(id?: string): void {
  previewProfileId.value = id;
  previewOpen.value = true;
}

/** The reminders that fire today by the rules the server evaluates. */
const firingToday = computed(() =>
  previewPool.value
    .map((m) => ({ machine: m, next: nextReminder(m, todayDay.value) }))
    .filter((entry): entry is { machine: MachineView; next: NonNullable<typeof entry.next> } => !!entry.next && entry.next.inDays === 0),
);
/** The next reminder after today, so an empty preview still says when one goes out. */
const nextFiring = computed(() =>
  previewPool.value
    .map((m) => ({ machine: m, next: nextReminder(m, todayDay.value) }))
    .filter((entry): entry is { machine: MachineView; next: NonNullable<typeof entry.next> } => !!entry.next && entry.next.inDays > 0)
    .sort((a, b) => a.next.inDays - b.next.inDays)[0],
);
const renewalRoutes = computed(() =>
  enabledNotifyRules.value
    .filter((rule) => ruleRoutesRenewals(rule))
    .map((rule) => {
      const channels = (rule.channel_ids ?? []).map((id) => notifyChannels.value.find((channel) => channel.id === id)?.name ?? id);
      return `${channels.join(", ")} (${rule.name})`;
    }),
);

function firingLine(entry: { machine: MachineView; next: { offset: number; renewal: string } }): string {
  const when = entry.next.offset < 0
    ? t("fleet.inventory.preview.overdueLine", { date: entry.next.renewal })
    : entry.next.offset === 0
      ? t("fleet.inventory.preview.todayLine", { date: entry.next.renewal })
      : t("fleet.inventory.preview.beforeLine", { n: entry.next.offset, date: entry.next.renewal }, entry.next.offset);
  const cost = machinePrice(entry.machine) > 0 ? ` · ${formatMoney(machinePrice(entry.machine), entry.machine.currency || "USD")}` : "";
  return `${displayName(entry.machine)}: ${when}${cost}`;
}

async function sendReminders(): Promise<void> {
  sendPending.value = true;
  try {
    const res = await api.machines.runReminders(previewProfileId.value);
    toast.success(t("fleet.inventory.toast.remindersFired", { count: res.fired.length }, res.fired.length));
    previewOpen.value = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.reminderFailed"));
  } finally {
    sendPending.value = false;
  }
}
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.inventory.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.inventory.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button v-if="canAdminInventory" variant="outline" size="sm" type="button" :disabled="machinesQuery.data.value !== undefined && machines.length === 0" @click="openPreview()">
          <Bell class="size-4" aria-hidden="true" />
          {{ $t('fleet.inventory.preview.open') }}
        </Button>
        <Button variant="outline" size="sm" as-child>
          <a :href="INVENTORY_GUIDE_URL" target="_blank" rel="noreferrer">
            <BookOpen class="size-4" aria-hidden="true" />
            {{ $t('common.actions.docs') }}
          </a>
        </Button>
        <Button variant="outline" size="sm" type="button" :disabled="machinesQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', machinesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>
    <datalist id="inventory-currencies">
      <option v-for="item in currencyOptions" :key="item" :value="item" />
    </datalist>
    <datalist id="inventory-vendors">
      <option v-for="item in vendors" :key="item.id" :value="item.name" />
    </datalist>

    <AttentionList :items="attention" />

    <!-- What the list shows: search and grouping, both in the address. -->
    <div v-if="machines.length > 0 || search" class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-0 flex-[1_1_16rem]">
        <Search class="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          v-model="search"
          type="search"
          class="ps-9"
          :placeholder="$t('fleet.inventory.search.placeholder')"
          :aria-label="$t('fleet.inventory.search.placeholder')"
        />
      </div>
      <div class="inline-flex max-w-full overflow-x-auto rounded-md border border-input bg-background p-0.5" role="group" :aria-label="$t('fleet.inventory.group.by')">
        <button
          v-for="option in groupOptions"
          :key="option"
          type="button"
          :class="cn(
            'whitespace-nowrap rounded px-2.5 py-1 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-10',
            groupBy === option ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
          )"
          :aria-pressed="groupBy === option"
          @click="groupBy = option"
        >
          {{ $t(`fleet.inventory.group.${option}`) }}
        </button>
      </div>
    </div>

    <DataTable
      v-model:collapsed-groups="collapsedGroups"
      state-key="machines"
      :columns="columns"
      :rows="tableRows"
      :row-key="(machine) => machineKey(machine)"
      :loading="machinesQuery.loading.value"
      :error="machinesQuery.error.value ?? null"
      :has-data="machinesQuery.data.value !== undefined"
      :expression-filter="false"
      :show-summary="false"
      :group-key="groupKeyFn"
      :group-order="groupOrderKeys"
      :row-click="(machine, el) => sheet.open(sheetId(machine), el)"
      :active-row-id="openMachine ? machineKey(openMachine) : null"
      @retry="machinesQuery.refresh"
    >
      <template #empty>
        <EmptyState
          v-if="search"
          :icon="Search"
          :title="$t('fleet.inventory.list.noMatchTitle')"
          :description="$t('fleet.inventory.list.noMatchDescription')"
        />
        <!-- No nodes at all is not a scope problem: say where machines come from. -->
        <EmptyState
          v-else-if="nodesQuery.data.value !== undefined && nodes.length === 0"
          :icon="Boxes"
          :title="$t('fleet.inventory.list.noNodesTitle')"
          :description="$t('fleet.inventory.list.noNodesDescription')"
        >
          <Button variant="outline" size="sm" as-child>
            <RouterLink :to="{ name: 'nodes' }">{{ $t('fleet.inventory.list.goToNodes') }}</RouterLink>
          </Button>
        </EmptyState>
        <EmptyState v-else :icon="Boxes" :title="$t('fleet.inventory.list.emptyTitle')" :description="$t('fleet.inventory.list.emptyDescription')" />
      </template>

      <template #group="{ group }">
        <span class="font-medium text-foreground">{{ groupByKey.get(group.key)?.label ?? group.key }}</span>
        <span class="tabular text-muted-foreground">{{ group.rows.length }}</span>
        <span v-if="groupByKey.get(group.key)?.spend.length" class="tabular text-foreground">
          {{ groupSpendLabel(groupByKey.get(group.key)!.spend) }}
        </span>
      </template>

      <template #cell-name="{ row }">
        <span class="flex min-w-0 items-center gap-2">
          <StatusDot :status="row.online ? 'online' : 'offline'" />
          <span class="flex min-w-0 font-medium" :title="row.node_name || row.node_id">
            <span class="truncate">{{ nameParts(displayName(row))[0] }}</span><span class="shrink-0">{{ nameParts(displayName(row))[1] }}</span>
          </span>
          <span v-if="!row.id" class="shrink-0 text-xs text-muted-foreground">{{ $t('fleet.inventory.billing.unprofiled') }}</span>
        </span>
      </template>
      <template #cell-vendor="{ row }">
        <span class="text-sm">{{ row.vendor || '' }}</span>
      </template>
      <template #cell-region="{ row }">
        <span class="text-sm text-muted-foreground">{{ row.region || '' }}</span>
      </template>
      <template #cell-price="{ row }">
        <span class="whitespace-nowrap text-sm">
          <span class="font-mono text-xs tabular">{{ formatPrice(row) }}</span>
          <span v-if="row.renewal_cycle" class="text-xs text-muted-foreground"> · {{ formatCycle(row) }}</span>
        </span>
      </template>
      <template #cell-monthly="{ row }">
        <!-- A free machine says so; a blank cell read as a value not entered. -->
        <span v-if="billingCategory(row) === 'free' && !formatMonthlyEquiv(row)" class="whitespace-nowrap text-xs text-muted-foreground">{{ $t('fleet.inventory.billing.free') }}</span>
        <span v-else class="whitespace-nowrap font-mono text-xs tabular">{{ formatMonthlyEquiv(row) }}</span>
      </template>
      <template #cell-renewal="{ row }">
        <span class="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
          <span v-if="renewalDate(row)" class="font-mono tabular text-muted-foreground">{{ renewalDate(row) }}</span>
          <span
            :class="cn(
              renewalTone(row) === 'destructive' && 'font-medium text-destructive',
              renewalTone(row) === 'warning' && 'font-medium text-warning-text',
              (renewalTone(row) === 'default' || renewalTone(row) === 'success') && 'text-muted-foreground',
            )"
          >{{ renewalLabel(row) }}</span>
          <template v-if="row.id && hasRenewalDate(row)">
            <Bell v-if="row.reminders_enabled" class="size-3.5 text-muted-foreground" aria-hidden="true" />
            <BellOff v-else class="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span class="sr-only">{{ reminderHint(row) }}</span>
          </template>
        </span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu :name="displayName(row)" :items="menuFor(row)" />
      </template>
    </DataTable>

    <!-- One machine: cost, renewal, reminder, provider and links. The editor opens from here. -->
    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openMachine ? displayName(openMachine) : sheet.openId.value ?? ''"
      :subtitle="openMachine ? [openMachine.node_name, openMachine.host_facts?.hostname].filter(Boolean).join(' · ') : undefined"
      :state="sheetState"
      :error="machinesQuery.error.value?.message ?? null"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('fleet.inventory.sheet.goneTitle')"
      :gone-description="$t('fleet.inventory.sheet.goneDescription')"
      @close="sheet.close"
      @retry="machinesQuery.refresh"
    >
      <div v-if="openMachine" class="space-y-5 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <Badge :variant="billingBadgeVariant(billingCategory(openMachine))">{{ $t(`fleet.inventory.billing.${billingCategory(openMachine)}`) }}</Badge>
          <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot :status="openMachine.online ? 'online' : 'offline'" />
            {{ openMachine.online ? $t('common.nodeStatus.online') : $t('common.nodeStatus.offline') }}
          </span>
        </div>
        <dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.table.price') }}</dt>
          <dd>
            <span class="font-mono text-xs">{{ formatPrice(openMachine) }}</span>
            <span v-if="openMachine.renewal_cycle" class="text-muted-foreground"> · {{ formatCycle(openMachine) }}</span>
            <span v-if="formatMonthlyEquiv(openMachine)" class="block text-xs text-muted-foreground">{{ formatMonthlyEquiv(openMachine) }}</span>
          </dd>
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.table.renewal') }}</dt>
          <dd>
            <span v-if="renewalDate(openMachine)" class="font-mono text-xs">{{ renewalDate(openMachine) }} · </span>
            <span :class="renewalTone(openMachine) === 'destructive' ? 'text-destructive' : renewalTone(openMachine) === 'warning' ? 'text-warning-text' : undefined">{{ renewalLabel(openMachine) }}</span>
            <span v-if="openMachine.auto_roll" class="block text-xs text-muted-foreground">{{ $t('fleet.inventory.sheet.autoRoll') }}</span>
          </dd>
          <template v-if="openMachine.id && hasRenewalDate(openMachine)">
            <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.sheet.reminder') }}</dt>
            <dd class="inline-flex items-start gap-1.5">
              <Bell v-if="openMachine.reminders_enabled" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <BellOff v-else class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{{ reminderHint(openMachine) }}</span>
            </dd>
          </template>
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.table.provider') }}</dt>
          <dd class="min-w-0">
            <a
              v-if="openMachine.vendor && vendorProfileFor(openMachine)?.url"
              :href="vendorProfileFor(openMachine)?.url"
              target="_blank"
              rel="noreferrer"
              class="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {{ openMachine.vendor }}
              <ExternalLink class="size-3" aria-hidden="true" />
            </a>
            <span v-else>{{ openMachine.vendor || $t('fleet.inventory.group.unknownVendor') }}</span>
          </dd>
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.table.region') }}</dt>
          <dd>{{ openMachine.region || $t('fleet.inventory.list.regionUnset') }}</dd>
          <template v-if="nodeInventoryFor(openMachine.node_id)?.purity_percent != null">
            <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.sheet.purity') }}</dt>
            <dd>{{ $t('fleet.inventory.purityBadge', { percent: nodeInventoryFor(openMachine.node_id)?.purity_percent }) }}</dd>
          </template>
          <template v-if="openMachine.notes">
            <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.sheet.notes') }}</dt>
            <dd class="whitespace-pre-wrap text-muted-foreground">{{ openMachine.notes }}</dd>
          </template>
          <template v-if="openMachine.updated_at">
            <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.sheet.updated') }}</dt>
            <dd class="text-xs text-muted-foreground">{{ formatRelativeTime(openMachine.updated_at) }}</dd>
          </template>
        </dl>
        <div v-if="openMachine.has_console_url || openMachine.has_detail_url" class="flex flex-wrap gap-2">
          <Button
            v-if="openMachine.has_console_url && canAdminInventory"
            type="button"
            variant="outline"
            size="sm"
            :disabled="!!linkRevealPending"
            @click="revealMachineLink(openMachine, 'console')"
          >
            <RefreshCw v-if="linkRevealPending === linkPendingKey(openMachine, 'console')" class="size-3.5 animate-spin" aria-hidden="true" />
            <ExternalLink v-else class="size-3.5" aria-hidden="true" />
            {{ $t('fleet.inventory.list.openConsole') }}
          </Button>
          <span v-else-if="openMachine.has_console_url" class="text-xs text-muted-foreground">{{ $t('fleet.inventory.list.consoleLinkStored') }}</span>
          <Button
            v-if="openMachine.has_detail_url && canAdminInventory"
            type="button"
            variant="outline"
            size="sm"
            :disabled="!!linkRevealPending"
            @click="revealMachineLink(openMachine, 'detail')"
          >
            <RefreshCw v-if="linkRevealPending === linkPendingKey(openMachine, 'detail')" class="size-3.5 animate-spin" aria-hidden="true" />
            <ExternalLink v-else class="size-3.5" aria-hidden="true" />
            {{ $t('fleet.inventory.list.openDetail') }}
          </Button>
          <span v-else-if="openMachine.has_detail_url" class="text-xs text-muted-foreground">{{ $t('fleet.inventory.list.detailLinkStored') }}</span>
        </div>
        <RouterLink
          :to="{ name: 'node-detail', params: { id: openMachine.node_id } }"
          class="inline-block text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          {{ $t('fleet.inventory.sheet.nodePage') }}
        </RouterLink>
      </div>
      <template v-if="canAdminInventory && openMachine" #actions>
        <Button size="sm" type="button" data-edit-button @click="openEdit(openMachine)">
          <component :is="openMachine.id ? Pencil : Plus" class="size-3.5" aria-hidden="true" />
          {{ openMachine.id ? $t('fleet.inventory.actions.edit') : $t('fleet.inventory.actions.addProfile') }}
        </Button>
      </template>
    </ObjectSheet>

    <!-- Edit / create dialog.
         A fixed header and footer around a scrolling form, so the machine's
         name, what a save would write, and Save stay on screen however long
         the form gets. Sections run in the order an operator fills them in;
         Renewal exists only for a recurring machine; the rarely touched parts
         (vendor directory details, stored links) are folded. Every way out
         goes through requestEditOpen, which asks before unsaved edits are
         thrown away. -->
    <Dialog :open="editOpen" @update:open="requestEditOpen">
      <!-- Focus goes to the title on open (focusEditorOnOpen): inside the
           dialog so the trap holds, and not on the first field, which would
           select the machine's label. -->
      <DialogContent
        class="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        @open-auto-focus="focusEditorOnOpen"
      >
        <DialogHeader class="gap-1.5 border-b border-border px-5 pt-5 pr-12 pb-4 text-left sm:px-6">
          <!-- No id here: reka names the dialog by its own title id, and
               overriding it left the dialog unnamed (and warning). -->
          <DialogTitle data-editor-title tabindex="-1" class="flex min-w-0 items-center gap-2 outline-none">
            <Pencil class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="truncate">{{ editMachine ? displayName(editMachine) : $t('fleet.inventory.profile.title') }}</span>
          </DialogTitle>
          <DialogDescription>
            {{ editHasProfile ? $t('fleet.inventory.profile.editSubtitle') : $t('fleet.inventory.profile.createSubtitle') }}
          </DialogDescription>
          <p
            v-if="editMachine?.host_facts"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground tabular"
          >
            <span class="inline-flex items-center gap-1">
              <HardDrive class="size-3" aria-hidden="true" />
              {{ editMachine.host_facts.os || editMachine.host_facts.platform || $t('fleet.inventory.facts.unknown') }}
            </span>
            <span class="inline-flex items-center gap-1">
              <Cpu class="size-3" aria-hidden="true" />
              {{ $t('fleet.inventory.facts.cpuCores', { value: editMachine.host_facts.cpu_cores || 0 }) }}
            </span>
            <span class="inline-flex items-center gap-1">
              <MemoryStick class="size-3" aria-hidden="true" />
              {{ formatBytes(editMachine.host_facts.memory_total) }}
            </span>
          </p>
          <!-- The proof line: the draft read back in the list's own words. -->
          <p
            v-if="canAdminInventory"
            class="font-mono text-xs text-foreground tabular"
            aria-live="polite"
            data-testid="machine-draft-summary"
          >
            {{ draftSummary.join(' · ') }}
          </p>
        </DialogHeader>

        <form
          v-if="canAdminInventory"
          id="machine-profile-form"
          class="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6"
          @submit.prevent="saveProfile"
        >
          <section class="space-y-3" aria-labelledby="machine-section-machine">
            <h3 id="machine-section-machine" class="font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {{ $t('fleet.inventory.profile.sectionMachine') }}
            </h3>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="machine-label">{{ $t('fleet.inventory.profile.label') }}</Label>
                <Input id="machine-label" v-model="label" placeholder="gmami-jp1" />
              </div>
              <div class="grid gap-2">
                <Label for="machine-region">{{ $t('fleet.inventory.profile.region') }}</Label>
                <Input id="machine-region" v-model="region" :placeholder="$t('fleet.inventory.profile.regionPlaceholder')" />
              </div>
            </div>
            <div class="grid gap-2">
              <Label for="machine-node">{{ $t('fleet.inventory.profile.node') }}</Label>
              <Select v-model="nodeId">
                <SelectTrigger id="machine-node">
                  <SelectValue :placeholder="$t('fleet.inventory.profile.node')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="choice in nodeChoices" :key="choice.id" :value="choice.id">
                    {{ choice.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          <section class="space-y-3" aria-labelledby="machine-section-vendor">
            <h3 id="machine-section-vendor" class="font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {{ $t('fleet.inventory.profile.sectionVendor') }}
            </h3>
            <div class="grid gap-2">
              <Label for="machine-vendor">{{ $t('fleet.inventory.profile.vendor') }}</Label>
              <div class="flex min-w-0 items-center gap-2">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30">
                  <img v-if="vendorLogoUrl" :src="vendorLogoUrl" alt="" class="max-h-6 max-w-6 rounded-sm object-contain" />
                  <Boxes v-else class="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <!-- One control. Saved vendors are suggestions on a text field,
                     so choosing one and typing a new name are the same action;
                     the old picker plus a second name field said it twice. -->
                <Input
                  id="machine-vendor"
                  v-model="vendor"
                  class="min-w-0 flex-1"
                  list="machine-vendor-options"
                  autocomplete="off"
                  placeholder="DMIT"
                />
                <datalist id="machine-vendor-options">
                  <option v-for="item in vendorChoices" :key="item.id" :value="item.name">{{ vendorSubtitle(item) }}</option>
                </datalist>
                <Button v-if="selectedVendorProfile?.url" variant="ghost" size="sm" as-child>
                  <a :href="selectedVendorProfile.url" target="_blank" rel="noreferrer">
                    {{ $t('fleet.inventory.profile.openVendor') }}
                    <ExternalLink class="size-3" aria-hidden="true" />
                  </a>
                </Button>
              </div>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.vendorNameHint') }}</p>
            </div>
            <details v-if="vendor" class="group rounded-md border border-border">
              <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
                <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
                <span class="font-medium">{{ $t('fleet.inventory.profile.vendorDetails') }}</span>
                <span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{{ vendorDetailsSummary }}</span>
              </summary>
              <div class="grid gap-3 border-t border-border px-3 py-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.vendorDirectoryHint') }}</p>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div class="grid gap-2">
                    <Label for="machine-vendor-url">{{ $t('fleet.inventory.profile.vendorUrl') }}</Label>
                    <Input id="machine-vendor-url" v-model="vendorUrl" placeholder="https://example.com" />
                  </div>
                  <div class="grid gap-2">
                    <Label for="machine-vendor-logo">{{ $t('fleet.inventory.profile.vendorLogoUrl') }}</Label>
                    <Input id="machine-vendor-logo" v-model="vendorLogoUrl" placeholder="https://example.com/logo.png" />
                  </div>
                </div>
                <div class="grid gap-2">
                  <Label for="machine-vendor-description">{{ $t('fleet.inventory.profile.vendorDescription') }}</Label>
                  <Textarea
                    id="machine-vendor-description"
                    v-model="vendorDescription"
                    class="min-h-16"
                    :placeholder="$t('fleet.inventory.profile.vendorDescriptionPlaceholder')"
                  />
                </div>
              </div>
            </details>
          </section>

          <section class="space-y-3" aria-labelledby="machine-section-billing">
            <h3 id="machine-section-billing" class="font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              {{ $t('fleet.inventory.profile.sectionBilling') }}
            </h3>
            <div class="grid gap-2">
              <span id="machine-billing-mode" class="text-sm font-medium">{{ $t('fleet.inventory.profile.modeLabel') }}</span>
              <!-- Switching to one-time keeps the renewal draft (see the
                   watchers), so this toggle can be flipped back without loss. -->
              <div
                class="inline-flex w-fit rounded-md border border-input bg-background p-0.5"
                role="radiogroup"
                aria-labelledby="machine-billing-mode"
              >
                <button type="button" role="radio" :aria-checked="!needsRenewal" :class="segmentClass(!needsRenewal)" @click="needsRenewal = false">
                  {{ $t('fleet.inventory.profile.modeOneTime') }}
                </button>
                <button type="button" role="radio" :aria-checked="needsRenewal" :class="segmentClass(needsRenewal)" @click="needsRenewal = true">
                  {{ $t('fleet.inventory.profile.modeRecurring') }}
                </button>
              </div>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)]">
              <div class="grid content-start gap-2">
                <Label for="machine-price">{{ $t('fleet.inventory.profile.price') }}</Label>
                <Input id="machine-price" v-model="priceMajor" type="number" min="0" step="0.01" placeholder="9.90" />
              </div>
              <div class="grid content-start gap-2">
                <Label for="machine-currency">{{ $t('fleet.inventory.profile.currency') }}</Label>
                <Select v-model="currency">
                  <SelectTrigger id="machine-currency">
                    <SelectValue placeholder="USD" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="cur in currencyOptions" :key="`profile-currency-${cur}`" :value="cur">
                      {{ cur }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid content-start gap-2">
                <Label for="machine-purchased">{{ $t('fleet.inventory.profile.purchasedAt') }}</Label>
                <div class="relative">
                  <CalendarClock class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input id="machine-purchased" v-model="purchasedAt" type="date" class="pl-9" />
                </div>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              {{ needsRenewal ? $t('fleet.inventory.profile.priceHint') : $t('fleet.inventory.profile.priceHintOneTime') }}
              <span v-if="draftMonthlyLabel" class="font-mono text-foreground tabular">{{ draftMonthlyLabel }}</span>
            </p>
            <div v-if="needsRenewal" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="grid content-start gap-2">
                <Label for="machine-cycle">{{ $t('fleet.inventory.profile.renewalCycle') }}</Label>
                <Select v-model="renewalCycleSelect">
                  <SelectTrigger id="machine-cycle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="NO_RENEWAL_CYCLE">{{ $t('fleet.inventory.profile.cycleNotSet') }}</SelectItem>
                    <SelectItem value="monthly">{{ $t('fleet.inventory.profile.cycle.monthly') }}</SelectItem>
                    <SelectItem value="quarterly">{{ $t('fleet.inventory.profile.cycle.quarterly') }}</SelectItem>
                    <SelectItem value="semiannual">{{ $t('fleet.inventory.profile.cycle.semiannual') }}</SelectItem>
                    <SelectItem value="annual">{{ $t('fleet.inventory.profile.cycle.annual') }}</SelectItem>
                    <SelectItem value="custom_days">{{ $t('fleet.inventory.profile.cycle.customDays') }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-if="renewalCycle === 'custom_days'" class="grid content-start gap-2">
                <Label for="machine-cycle-days">{{ $t('fleet.inventory.profile.cycleDays') }}</Label>
                <Input
                  id="machine-cycle-days"
                  v-model="cycleDays"
                  type="number"
                  min="1"
                  step="1"
                  :aria-invalid="!customCycleValid || undefined"
                  :aria-describedby="customCycleValid ? undefined : 'machine-cycle-days-error'"
                />
                <p v-if="!customCycleValid" id="machine-cycle-days-error" class="text-xs text-destructive">
                  {{ $t('fleet.inventory.profile.cycleDaysInvalid') }}
                </p>
              </div>
            </div>
          </section>

          <section v-if="needsRenewal" class="space-y-3" aria-labelledby="machine-section-renewal">
            <h3 id="machine-section-renewal" tabindex="-1" class="scroll-mt-4 font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase outline-none">
              {{ $t('fleet.inventory.profile.sectionRenewal') }}
            </h3>
            <div class="grid gap-2">
              <Label for="machine-renewal">{{ $t('fleet.inventory.profile.nextRenewal') }}</Label>
              <div class="flex flex-wrap items-center gap-2">
                <div class="relative w-full sm:w-56">
                  <CalendarClock class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input id="machine-renewal" v-model="nextRenewal" type="date" class="pl-9" />
                </div>
                <Button
                  v-if="calculatedNextRenewal && calculatedNextRenewal !== nextRenewal"
                  type="button"
                  variant="ghost"
                  size="sm"
                  @click="useCalculatedRenewal"
                >
                  {{ $t('fleet.inventory.profile.useCalculatedDate', { date: calculatedNextRenewal }) }}
                </Button>
              </div>
              <!-- Said in place: Save is enabled for this date though nobody typed it. -->
              <p v-if="nextRenewalIsSuggestion" class="text-xs text-warning-text">
                {{ $t('fleet.inventory.profile.nextRenewalSuggested') }}
              </p>
              <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.nextRenewalHint') }}</p>
            </div>

            <!-- A label per checkbox and the hint linked by aria-describedby, so
                 the accessible name is the option, not the option and its
                 explanation run together. -->
            <div class="flex items-start gap-2 text-sm">
              <Checkbox
                id="machine-auto-roll"
                v-model="autoRoll"
                class="mt-0.5"
                :disabled="!renewalCycle"
                aria-describedby="machine-auto-roll-hint"
              />
              <div>
                <label for="machine-auto-roll">{{ $t('fleet.inventory.profile.autoRoll') }}</label>
                <p id="machine-auto-roll-hint" class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.autoRollHint') }}</p>
              </div>
            </div>

            <div class="grid gap-2">
              <div class="flex items-start gap-2 text-sm">
                <Checkbox
                  id="machine-reminders-enabled"
                  v-model="remindersEnabled"
                  class="mt-0.5"
                  :disabled="!hasEffectiveNextRenewal"
                  aria-describedby="machine-reminders-enabled-hint"
                  @update:model-value="remindersFollowDate = false"
                />
                <div>
                  <label for="machine-reminders-enabled">{{ $t('fleet.inventory.profile.enableReminders') }}</label>
                  <p id="machine-reminders-enabled-hint" class="text-xs text-muted-foreground">
                    {{ $t('fleet.inventory.profile.remindersDefault') }}
                    {{ $t('fleet.inventory.profile.enableRemindersHint') }}
                  </p>
                </div>
              </div>
              <div v-if="remindersEnabled" class="grid gap-2 pl-6">
                <Label for="machine-reminders">{{ $t('fleet.inventory.profile.remindersBefore') }}</Label>
                <Input
                  id="machine-reminders"
                  v-model="remindDays"
                  class="sm:w-56"
                  placeholder="14,7,3,1,0"
                  :aria-invalid="draftReminderDays.days.length === 0 || undefined"
                  aria-describedby="machine-reminders-hint"
                />
                <p v-if="draftReminderDays.days.length === 0" id="machine-reminders-hint" class="text-xs text-destructive">
                  {{ $t('fleet.inventory.profile.reminderDaysEmpty') }}
                </p>
                <p v-else-if="draftReminderDays.ignored.length" id="machine-reminders-hint" class="text-xs text-warning-text">
                  {{ $t('fleet.inventory.profile.reminderDaysIgnored', { values: draftReminderDays.ignored.join(', ') }) }}
                </p>
                <p v-else id="machine-reminders-hint" class="text-xs text-muted-foreground">
                  {{ $t('fleet.inventory.profile.remindersBeforeHint') }}
                </p>
                <div v-if="canManageNotifications && !renewalNotificationReady" :class="warningPanelClass">
                  {{ $t('fleet.inventory.profile.reminderNoRoute') }}
                  <RouterLink :to="NOTIFICATIONS_ROUTE" class="font-medium underline underline-offset-2">
                    {{ $t('fleet.inventory.profile.configureNotifications') }}
                  </RouterLink>
                </div>
                <p v-else-if="canManageNotifications" class="text-xs text-muted-foreground">
                  {{ $t('fleet.inventory.profile.reminderRouteReady', { count: enabledNotifyChannels.length }) }}
                </p>
                <p v-else class="text-xs text-muted-foreground">
                  {{ $t('fleet.inventory.profile.reminderRouteUnknown') }}
                </p>
              </div>
            </div>

            <div v-if="renewalBlocksSave" :class="warningPanelClass">
              {{ $t('fleet.inventory.profile.renewalInvalidHint') }}
            </div>
            <div v-else-if="renewalDraftIncomplete" :class="warningPanelClass">
              {{ $t('fleet.inventory.profile.renewalDraftHint') }}
            </div>

            <!-- Record renewal lives beside the fields it changes, and says what
                 it will do before it does it. -->
            <div v-if="editHasProfile" class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
              <p class="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="machine-renew-preview">{{ renewPreview }}</p>
              <Button
                v-if="renewRollForwardDate"
                type="button"
                variant="ghost"
                size="sm"
                @click="nextRenewal = renewRollForwardDate"
              >
                {{ $t('fleet.inventory.profile.useRolledForwardDate', { date: renewRollForwardDate }) }}
              </Button>
              <Button type="button" variant="outline" size="sm" :disabled="renewPending || !canRecordRenewal" @click="renewProfile">
                <RefreshCw v-if="renewPending" class="size-4 animate-spin" aria-hidden="true" />
                <CalendarClock v-else class="size-4" aria-hidden="true" />
                {{ $t('fleet.inventory.profile.recordRenewal') }}
              </Button>
              <Button
                v-if="remindersEnabled"
                type="button"
                variant="ghost"
                size="sm"
                :disabled="formDirty"
                @click="openPreview(profileId)"
              >
                <Bell class="size-4" aria-hidden="true" />
                {{ $t('fleet.inventory.preview.open') }}
              </Button>
            </div>
          </section>

          <details class="group rounded-md border border-border">
            <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
              <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
              <span class="font-medium">{{ $t('fleet.inventory.profile.links') }}</span>
              <span class="font-mono text-xs text-muted-foreground">
                {{ storedLinkCount ? $t('fleet.inventory.profile.linksStored', { count: storedLinkCount }) : $t('fleet.inventory.profile.linksNone') }}
              </span>
            </summary>
            <div class="grid gap-3 border-t border-border px-3 py-3">
              <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.writeOnlyUrlHint') }}</p>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="grid content-start gap-2">
                  <Label for="machine-console">{{ $t('fleet.inventory.profile.consoleUrl') }}</Label>
                  <Input id="machine-console" v-model="consoleUrl" :placeholder="$t('fleet.inventory.profile.consoleUrlPlaceholder')" />
                  <label v-if="editMachine?.has_console_url" class="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox v-model="clearConsoleUrl" />
                    {{ $t('fleet.inventory.profile.clearConsoleUrl') }}
                  </label>
                </div>
                <div class="grid content-start gap-2">
                  <Label for="machine-detail">{{ $t('fleet.inventory.profile.detailUrl') }}</Label>
                  <Input id="machine-detail" v-model="detailUrl" :placeholder="$t('fleet.inventory.profile.detailUrlPlaceholder')" />
                  <label v-if="editMachine?.has_detail_url" class="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox v-model="clearDetailUrl" />
                    {{ $t('fleet.inventory.profile.clearDetailUrl') }}
                  </label>
                </div>
              </div>
            </div>
          </details>

          <div class="grid gap-2">
            <Label for="machine-notes">{{ $t('fleet.inventory.profile.notes') }}</Label>
            <Textarea
              id="machine-notes"
              v-model="notes"
              :placeholder="$t('fleet.inventory.profile.notesPlaceholder')"
            />
          </div>
        </form>

        <div v-else-if="editMachine" class="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-5 sm:px-6">
          <dl class="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.vendor') }}</dt>
              <dd>{{ editMachine.vendor || $t('common.misc.none') }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.region') }}</dt>
              <dd>{{ editMachine.region || $t('common.misc.none') }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.price') }}</dt>
              <dd>
                {{ formatPrice(editMachine) }}
                <span v-if="editMachine.renewal_cycle" class="text-muted-foreground">· {{ formatCycle(editMachine) }}</span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.purchasedAt') }}</dt>
              <dd>{{ formatDate(editMachine.purchased_at) || $t('common.misc.none') }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.facts.renewal') }}</dt>
              <dd>{{ renewalLabel(editMachine) }}</dd>
            </div>
            <div v-if="editMachine.notes" class="sm:col-span-2">
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.notes') }}</dt>
              <dd class="whitespace-pre-wrap">{{ editMachine.notes }}</dd>
            </div>
          </dl>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.readOnlyDescription') }}</p>
        </div>
        <div v-else class="px-5 py-5 sm:px-6">
          <EmptyState
            :title="$t('fleet.inventory.profile.readOnlyTitle')"
            :description="$t('fleet.inventory.profile.readOnlyDescription')"
          />
        </div>

        <DialogFooter class="flex-row items-center justify-between gap-2 border-t border-border px-5 py-3 sm:justify-between sm:px-6">
          <Button
            v-if="canAdminInventory && editHasProfile"
            type="button"
            variant="ghost"
            class="text-destructive hover:bg-destructive/10 hover:text-destructive"
            :disabled="deletePending"
            @click="deleteOpen = true"
          >
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
          <span v-else aria-hidden="true"></span>
          <div class="flex items-center gap-2">
            <span v-if="formDirty" class="hidden text-xs text-muted-foreground sm:inline">{{ $t('fleet.inventory.profile.unsavedChanges') }}</span>
            <Button type="button" variant="outline" @click="requestEditOpen(false)">
              {{ canAdminInventory ? $t('common.actions.cancel') : $t('common.actions.close') }}
            </Button>
            <Button
              v-if="canAdminInventory"
              type="submit"
              form="machine-profile-form"
              :disabled="pending || !canSave || (editHasProfile && !formDirty)"
            >
              <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
              <Save v-else class="size-4" aria-hidden="true" />
              {{ editHasProfile ? $t('fleet.inventory.profile.saveChanges') : $t('fleet.inventory.profile.createProfile') }}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="discardOpen"
      :title="$t('fleet.inventory.profile.discardTitle', { name: editMachine ? displayName(editMachine) : $t('fleet.inventory.profile.title') })"
      :description="$t('fleet.inventory.profile.discardDescription')"
      :confirm-label="$t('fleet.inventory.profile.discardConfirm')"
      :cancel-label="$t('fleet.inventory.profile.keepEditing')"
      variant="destructive"
      @confirm="discardChanges"
    />

    <Dialog v-model:open="stepUpOpen">
      <DialogScrollContent class="sm:max-w-md" @escape-key-down.prevent="inventoryStepUp.cancel">
        <DialogHeader>
          <DialogTitle>{{ $t('fleet.inventory.stepUp.title') }}</DialogTitle>
          <DialogDescription>{{ $t('fleet.inventory.stepUp.description') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="inventoryStepUp.submitTotp">
          <div class="grid gap-2">
            <Label for="inventory-step-up-code">{{ $t('fleet.inventory.stepUp.code') }}</Label>
            <Input
              id="inventory-step-up-code"
              v-model="stepUpCode"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="8"
              placeholder="123456"
            />
            <p v-if="stepUpError" class="text-xs text-destructive">{{ stepUpError }}</p>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" @click="inventoryStepUp.cancel">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="button" variant="outline" :disabled="!!stepUpPending || !inventoryStepUp.supportsPasskey" @click="inventoryStepUp.submitPasskey">
              <RefreshCw v-if="stepUpPending === 'passkey'" class="size-4 animate-spin" aria-hidden="true" />
              <KeyRound v-else class="size-4" aria-hidden="true" />
              {{ $t('fleet.inventory.stepUp.passkey') }}
            </Button>
            <Button type="submit" :disabled="!!stepUpPending || !stepUpCode.trim()">
              <RefreshCw v-if="stepUpPending === 'totp'" class="size-4 animate-spin" aria-hidden="true" />
              <LinkIcon v-else class="size-4" aria-hidden="true" />
              {{ $t('fleet.inventory.stepUp.submit') }}
            </Button>
          </div>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Preview reminders: what a send would push, then the send behind a typed count (design 23, 3.8).
         After the editor in the template, so it stacks above the editor it opens from. -->
    <ConfirmDialog
      v-model:open="previewOpen"
      :title="previewMachine ? $t('fleet.inventory.preview.titleOne', { name: displayName(previewMachine) }) : $t('fleet.inventory.preview.title')"
      :description="firingToday.length
        ? $t('fleet.inventory.preview.description', { n: firingToday.length }, firingToday.length)
        : previewMachine ? $t('fleet.inventory.preview.nothingOne', { name: displayName(previewMachine) }) : $t('fleet.inventory.preview.nothing')"
      :impact="firingToday.length ? firingToday.map(firingLine) : undefined"
      :impact-title="$t('fleet.inventory.preview.impactTitle')"
      :typed-confirm="firingToday.length ? String(firingToday.length) : undefined"
      :confirm-label="$t('fleet.inventory.preview.send', { n: firingToday.length }, firingToday.length)"
      :cancel-label="$t('common.actions.close')"
      :confirm-disabled="firingToday.length === 0"
      :pending="sendPending"
      @confirm="sendReminders"
    >
      <div class="space-y-1.5 text-xs text-muted-foreground">
        <p v-if="!canManageNotifications">{{ $t('fleet.inventory.preview.routesUnknown') }}</p>
        <p v-else-if="renewalRoutes.length">{{ $t('fleet.inventory.preview.routes', { routes: renewalRoutes.join('; ') }) }}</p>
        <p v-else class="text-warning-text">{{ $t('fleet.inventory.preview.noRoute') }}</p>
        <p v-if="nextFiring">{{ $t('fleet.inventory.preview.next', { name: displayName(nextFiring.machine), date: nextFiring.next.at, n: nextFiring.next.inDays }, nextFiring.next.inDays) }}</p>
        <p v-if="firingToday.length">{{ $t('fleet.inventory.preview.dedupe') }}</p>
      </div>
    </ConfirmDialog>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('fleet.inventory.profile.deleteTitle')"
      :description="editMachine ? $t('fleet.inventory.confirm.delete', { name: displayName(editMachine) }) : ''"
      :impact="deleteProfileImpact"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletePending"
      @confirm="deleteProfile"
    />
  </div>
</template>
