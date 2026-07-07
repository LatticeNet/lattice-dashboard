<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { toast } from "vue-sonner";
import {
  Bell,
  BookOpen,
  Boxes,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Cpu,
  Eye,
  HardDrive,
  Link as LinkIcon,
  MemoryStick,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Wallet,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type MachineProfileInput,
  type MachineView,
  type NotifyChannelView,
  type NotifyRuleView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import {
  formatBytes,
  formatMoney,
  formatRelativeTime,
  shortId,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import StatCard from "@/components/common/StatCard.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type RenewalTone = "default" | "success" | "warning" | "destructive";
type BillingCategory = "recurring" | "onetime" | "free" | "unpriced" | "unprofiled";
type GroupBy = "none" | "billing" | "vendor" | "region" | "renewal";

// Approx. days per month, used to normalise custom-day billing cycles to a
// monthly-equivalent figure (365.25 / 12).
const DAYS_PER_MONTH = 30.4375;
// Monthly divisor per named cycle; custom_days is handled separately.
const CYCLE_DIVISOR: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

// Trimmed string coercion. Guards against non-string reactive values: shadcn
// <Input type="number"> binds through defineModel<string|number>, so a numeric
// field can hold a real `number` — calling `.trim()` on it used to throw
// "value.trim is not a function" on submit.
function s(value: unknown): string {
  return String(value ?? "").trim();
}

const auth = useAuthStore();
const { t } = useI18n();
const route = useRoute();
const INVENTORY_GUIDE_URL = "https://latticenet.github.io/guide/operations#machine-inventory";
const NOTIFICATIONS_ROUTE = "/platform/notifications";

const machinesQuery = useAsyncData(() => api.machines.list().then((r) => unwrap(r, "machines")), {
  pollInterval: 12000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});
const canManageNotifications = computed(() => auth.can("notify:send"));
const notifyChannelsQuery = useAsyncData(
  () => (canManageNotifications.value ? api.notify.channels() : Promise.resolve([] as NotifyChannelView[])),
  { pollInterval: 30000 },
);
const notifyRulesQuery = useAsyncData(
  () =>
    canManageNotifications.value
      ? api.notify.rules().then((r) => unwrap(r, "rules"))
      : Promise.resolve([] as NotifyRuleView[]),
  { pollInterval: 30000 },
);

// ── View state ──────────────────────────────────────────────────────────────
const search = ref("");
const groupBy = ref<GroupBy>("billing");

// ── Edit dialog state ─────────────────────────────────────────────────────────
const editOpen = ref(false);
const editKey = ref("");
const pending = ref(false);
const deletePending = ref(false);
const deleteOpen = ref(false);
const renewPending = ref(false);
const remindersPending = ref(false);
const remindersAllPending = ref(false);

// ── Form model (populated when the edit dialog opens) ─────────────────────────
const profileId = ref("");
const nodeId = ref("");
const label = ref("");
const vendor = ref("");
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
const remindDays = ref("14,7,1");
const consoleUrl = ref("");
const detailUrl = ref("");
const clearConsoleUrl = ref(false);
const clearDetailUrl = ref(false);

const machines = computed(() => machinesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const notifyChannels = computed(() => notifyChannelsQuery.data.value ?? []);
const notifyRules = computed(() => notifyRulesQuery.data.value ?? []);
const canAdminInventory = computed(() => auth.can("inventory:admin"));

const editMachine = computed(() =>
  machines.value.find((machine) => machineKey(machine) === editKey.value),
);
const editHasProfile = computed(() => !!profileId.value);
const calculatedNextRenewal = computed(() => calculateNextRenewalFromPurchase());
const customCycleValid = computed(
  () => renewalCycle.value !== "custom_days" || Number(s(cycleDays.value)) > 0,
);
const renewalFormValid = computed(
  () =>
    !needsRenewal.value ||
    (!!renewalCycle.value && customCycleValid.value && !!(nextRenewal.value || calculatedNextRenewal.value)),
);
const reminderFormValid = computed(() => !remindersEnabled.value || needsRenewal.value);
const canSave = computed(
  () => !!nodeId.value && canAdminInventory.value && renewalFormValid.value && reminderFormValid.value,
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

// ── Cost model ────────────────────────────────────────────────────────────────
function machinePrice(machine: MachineView): number {
  return machine.price_cents ?? 0;
}

function billingCategory(machine: MachineView): BillingCategory {
  if (!machine.id) return "unprofiled";
  const price = machinePrice(machine);
  if (price > 0) return machine.renewal_cycle ? "recurring" : "onetime";
  // Price 0/unset: a machine that is being billed (has a renewal cycle or a
  // tracked renewal date) but has no price entered is "needs pricing"; a machine
  // with no billing signal at all is genuinely free.
  return machine.renewal_cycle || machine.next_renewal ? "unpriced" : "free";
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
const primarySpend = computed<CurrencySpend | undefined>(() => spendByCurrency.value[0]);
const primaryMonthlyLabel = computed(() => {
  const p = primarySpend.value;
  if (!p) return t("fleet.inventory.spend.none");
  return t("fleet.inventory.spend.perMonth", {
    amount: formatMoney(Math.round(p.monthly), p.currency),
  });
});
const spendHint = computed(() => {
  const extra = spendByCurrency.value.length - 1;
  const parts: string[] = [];
  if (extra > 0) parts.push(t("fleet.inventory.spend.moreCurrencies", { count: extra }));
  if (freeCount.value > 0) parts.push(t("fleet.inventory.spend.free", { count: freeCount.value }));
  return parts.join(" · ");
});

// ── Fleet counters ────────────────────────────────────────────────────────────
const profiledCount = computed(() => machines.value.filter((m) => !!m.id).length);
const missingCount = computed(() => machines.value.filter((m) => !m.id).length);
const recurringCount = computed(
  () => machines.value.filter((m) => billingCategory(m) === "recurring").length,
);
const onetimeCount = computed(
  () => machines.value.filter((m) => billingCategory(m) === "onetime").length,
);
const freeCount = computed(() => machines.value.filter((m) => billingCategory(m) === "free").length);
const renewalSoonCount = computed(
  () =>
    machines.value.filter((m) => {
      const days = m.days_until_renewal;
      return days !== undefined && days >= 0 && days <= 14;
    }).length,
);
const overdueCount = computed(
  () =>
    machines.value.filter((m) => {
      const days = m.days_until_renewal;
      return !!m.next_renewal && days !== undefined && days < 0;
    }).length,
);
const trackedRenewalCount = computed(() => machines.value.filter((m) => !!m.next_renewal).length);
const remindersEnabledCount = computed(
  () => machines.value.filter((m) => m.reminders_enabled).length,
);

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

function sortMachines(list: MachineView[]): MachineView[] {
  return [...list].sort((a, b) => {
    const aProfile = !!a.id;
    const bProfile = !!b.id;
    if (aProfile !== bProfile) return aProfile ? -1 : 1;
    return displayName(a).localeCompare(displayName(b));
  });
}

type MachineGroup = {
  key: string;
  label: string;
  machines: MachineView[];
  spend: CurrencySpend[];
};

const BILLING_ORDER: BillingCategory[] = ["recurring", "onetime", "free", "unpriced", "unprofiled"];

const groups = computed<MachineGroup[]>(() => {
  const list = filteredMachines.value;
  if (list.length === 0) return [];

  const build = (key: string, labelText: string, items: MachineView[]): MachineGroup => ({
    key,
    label: labelText,
    machines: sortMachines(items),
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
      if (!m.next_renewal) return "notTracked";
      const days = m.days_until_renewal;
      if (days === undefined) return "upcoming";
      if (days < 0) return "overdue";
      if (days <= 14) return "dueSoon";
      return "upcoming";
    };
    const order = ["overdue", "dueSoon", "upcoming", "notTracked"];
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

const groupOptions: GroupBy[] = ["billing", "renewal", "vendor", "region", "none"];

// ── Deep-link (?node=<id>) opens that node's editor once the list loads ───────
const seededNodeQuery = ref<string | undefined>(undefined);
watch(
  [machines, () => route.query.node],
  ([list, nodeQ]) => {
    const id = typeof nodeQ === "string" ? nodeQ : undefined;
    if (!id || id === seededNodeQuery.value || list.length === 0) return;
    const m = list.find((x) => x.node_id === id);
    seededNodeQuery.value = id;
    if (m && canAdminInventory.value) openEdit(m);
  },
  { immediate: true },
);

// ── Helpers ───────────────────────────────────────────────────────────────────
function machineKey(machine: MachineView): string {
  return machine.id || `node:${machine.node_id}`;
}

function displayName(machine: MachineView): string {
  return machine.label || machine.node_name || machine.node_id;
}

function nodeInventoryFor(nodeID?: string) {
  if (!nodeID) return undefined;
  return nodes.value.find((node) => node.id === nodeID)?.inventory ?? undefined;
}

function billingBadgeVariant(cat: BillingCategory): "secondary" | "success" | "warning" | "outline" {
  if (cat === "free") return "success";
  if (cat === "unpriced" || cat === "unprofiled") return "warning";
  if (cat === "onetime") return "outline";
  return "secondary";
}

function renewalTone(machine?: MachineView): RenewalTone {
  const days = machine?.days_until_renewal;
  if (days === undefined || !machine?.next_renewal) return "default";
  if (days < 0) return "destructive";
  if (days <= 14) return "warning";
  return "success";
}

function renewalLabel(machine?: MachineView): string {
  if (!machine?.next_renewal) return t("fleet.inventory.renewal.notTracked");
  const days = machine.days_until_renewal;
  if (days === undefined) return formatDate(machine.next_renewal);
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
  if (!needsRenewal.value || !renewalCycle.value) return "";
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

// ── Edit dialog form lifecycle ────────────────────────────────────────────────
function loadForm(machine: MachineView) {
  profileId.value = machine.id || "";
  nodeId.value = machine.node_id;
  label.value = machine.label || "";
  vendor.value = machine.vendor || "";
  region.value = machine.region || "";
  notes.value = machine.notes || "";
  priceMajor.value = machine.price_cents ? (machine.price_cents / 100).toFixed(2) : "";
  currency.value = machine.currency || "USD";
  purchasedAt.value = formatDate(machine.purchased_at);
  needsRenewal.value = !!(
    machine.renewal_cycle ||
    machine.next_renewal ||
    machine.auto_roll ||
    machine.reminders_enabled
  );
  renewalCycle.value = machine.renewal_cycle || "";
  cycleDays.value = machine.cycle_days ? String(machine.cycle_days) : "";
  nextRenewal.value = formatDate(machine.next_renewal);
  autoRoll.value = !!machine.auto_roll;
  remindersEnabled.value = !!machine.reminders_enabled;
  remindDays.value = (machine.remind_days_before?.length ? machine.remind_days_before : [14, 7, 1]).join(
    ",",
  );
  consoleUrl.value = "";
  detailUrl.value = "";
  clearConsoleUrl.value = false;
  clearDetailUrl.value = false;
}

function openEdit(machine: MachineView) {
  editKey.value = machineKey(machine);
  loadForm(machine);
  editOpen.value = true;
}

function parsePriceCents(): number | undefined {
  const trimmed = s(priceMajor.value);
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
}

function parseReminderDays(): number[] {
  return [
    ...new Set(
      s(remindDays.value)
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 365),
    ),
  ].sort((a, b) => b - a);
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
    currency: s(currency.value),
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

watch(needsRenewal, (enabled) => {
  if (enabled) return;
  renewalCycle.value = "";
  cycleDays.value = "";
  nextRenewal.value = "";
  autoRoll.value = false;
  remindersEnabled.value = false;
});

watch([purchasedAt, renewalCycle, cycleDays, needsRenewal], () => {
  if (needsRenewal.value && !nextRenewal.value && calculatedNextRenewal.value) {
    nextRenewal.value = calculatedNextRenewal.value;
  }
});

async function refreshAll() {
  await Promise.all([machinesQuery.refresh(), nodesQuery.refresh()]);
}

async function saveProfile() {
  if (!canSave.value) return;
  pending.value = true;
  try {
    const input = buildInput();
    const saved = profileId.value
      ? await api.machines.update({ ...input, id: profileId.value })
      : await api.machines.create(input);
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
  if (!profileId.value) return;
  renewPending.value = true;
  try {
    const renewed = await api.machines.renew(
      profileId.value,
      autoRoll.value ? undefined : isoDate(nextRenewal.value),
    );
    toast.success(t("fleet.inventory.toast.renewalRecorded"));
    loadForm(renewed);
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.renewalFailed"));
  } finally {
    renewPending.value = false;
  }
}

async function runReminders(selectedOnly: boolean) {
  const flag = selectedOnly ? remindersPending : remindersAllPending;
  flag.value = true;
  try {
    const res = await api.machines.runReminders(selectedOnly ? profileId.value : undefined);
    toast.success(t("fleet.inventory.toast.remindersFired", { count: res.fired.length }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.reminderFailed"));
  } finally {
    flag.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('fleet.inventory.title')" :description="$t('fleet.inventory.description')">
      <template #status>
        <FreshnessLabel :last-updated="machinesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" as-child>
            <a :href="INVENTORY_GUIDE_URL" target="_blank" rel="noreferrer">
              <BookOpen class="size-4" aria-hidden="true" />
              {{ $t('common.actions.docs') }}
            </a>
          </Button>
          <Button variant="outline" size="sm" :disabled="machinesQuery.refreshing.value" @click="refreshAll">
            <RefreshCw :class="cn('size-4', machinesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
            {{ $t('common.actions.refresh') }}
          </Button>
          <Button
            v-if="canAdminInventory"
            variant="outline"
            size="sm"
            :disabled="remindersAllPending"
            @click="runReminders(false)"
          >
            <RefreshCw v-if="remindersAllPending" class="size-4 animate-spin" aria-hidden="true" />
            <Bell v-else class="size-4" aria-hidden="true" />
            {{ $t('fleet.inventory.facts.runAllReminders') }}
          </Button>
        </div>
      </template>
    </PageHeader>

    <!-- KPI board -->
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('fleet.inventory.stats.machines')" :value="machines.length" :icon="Boxes"
        :hint="$t('fleet.inventory.stats.profiledHint', { profiled: profiledCount, missing: missingCount })" />
      <StatCard :label="$t('fleet.inventory.stats.monthlySpend')" :value="primaryMonthlyLabel" :icon="Wallet"
        :hint="spendHint" />
      <StatCard :label="$t('fleet.inventory.stats.renewalRisk')" :value="renewalSoonCount" :icon="CalendarClock"
        :tone="overdueCount > 0 ? 'destructive' : renewalSoonCount > 0 ? 'warning' : 'success'"
        :hint="$t('fleet.inventory.stats.overdueHint', { count: overdueCount })" />
      <StatCard :label="$t('fleet.inventory.stats.coverage')" :value="`${profiledCount} / ${machines.length}`"
        :icon="CheckCircle2" :tone="missingCount > 0 ? 'warning' : 'success'"
        :hint="$t('fleet.inventory.stats.needsProfileHint', { count: missingCount })" />
    </div>

    <!-- Billing composition + spend-by-currency -->
    <Card>
      <CardHeader class="pb-3">
        <CardTitle class="flex items-center gap-2 text-base">
          <CircleDollarSign class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('fleet.inventory.summary.title') }}
        </CardTitle>
        <CardDescription>{{ $t('fleet.inventory.summary.description') }}</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
          <div class="rounded-lg border border-border bg-muted/20 p-3">
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.billing.recurring') }}</p>
            <p class="mt-1 text-xl font-semibold tabular">{{ recurringCount }}</p>
          </div>
          <div class="rounded-lg border border-border bg-muted/20 p-3">
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.billing.onetime') }}</p>
            <p class="mt-1 text-xl font-semibold tabular">{{ onetimeCount }}</p>
          </div>
          <div class="rounded-lg border border-border bg-muted/20 p-3">
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.billing.free') }}</p>
            <p class="mt-1 text-xl font-semibold tabular text-success">{{ freeCount }}</p>
          </div>
          <div class="rounded-lg border border-border bg-muted/20 p-3">
            <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.summary.renewals') }}</p>
            <p class="mt-1 text-xl font-semibold tabular">{{ trackedRenewalCount }} / {{ profiledCount }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ $t('fleet.inventory.summary.remindersEnabled', { count: remindersEnabledCount }) }}</p>
          </div>
        </div>

        <div class="rounded-lg border border-border p-3">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.spend.breakdown') }}</p>
          <div v-if="spendByCurrency.length" class="mt-2 space-y-2">
            <div v-for="entry in spendByCurrency" :key="entry.currency" class="space-y-1">
              <div class="flex items-center justify-between text-sm">
                <span class="font-medium">{{ entry.currency }}</span>
                <span class="tabular text-muted-foreground">
                  {{ $t('fleet.inventory.spend.perMonth', { amount: formatMoney(Math.round(entry.monthly), entry.currency) }) }}
                  · {{ $t('fleet.inventory.spend.perYear', { amount: formatMoney(Math.round(entry.annual), entry.currency) }) }}
                </span>
              </div>
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  class="h-full rounded-full bg-primary"
                  :style="{ width: `${primarySpend ? Math.max(4, (entry.monthly / primarySpend.monthly) * 100) : 0}%` }"
                />
              </div>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.spend.machineCount', { count: entry.count }) }}</p>
            </div>
          </div>
          <p v-else class="mt-2 text-sm text-muted-foreground">{{ $t('fleet.inventory.spend.none') }}</p>
        </div>
      </CardContent>
    </Card>

    <!-- Controls: search + group-by -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="relative w-full sm:max-w-xs">
        <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input v-model="search" class="pl-9" :placeholder="$t('fleet.inventory.search.placeholder')" />
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-muted-foreground">{{ $t('fleet.inventory.group.by') }}</span>
        <div class="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1" role="group" :aria-label="$t('fleet.inventory.group.by')">
          <button
            v-for="opt in groupOptions"
            :key="opt"
            type="button"
            :aria-pressed="groupBy === opt"
            :class="cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              groupBy === opt ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )"
            @click="groupBy = opt"
          >
            {{ $t(`fleet.inventory.group.${opt}`) }}
          </button>
        </div>
      </div>
    </div>

    <!-- Machine groups -->
    <DataState
      :loading="machinesQuery.loading.value"
      :error="machinesQuery.error.value"
      :has-data="machinesQuery.data.value !== undefined"
      :is-empty="machines.length === 0"
      :empty-title="$t('fleet.inventory.list.emptyTitle')"
      :empty-description="$t('fleet.inventory.list.emptyDescription')"
      @retry="machinesQuery.refresh"
    >
      <EmptyState
        v-if="groups.length === 0"
        :title="$t('fleet.inventory.list.noMatchTitle')"
        :description="$t('fleet.inventory.list.noMatchDescription')"
      />
      <div v-else class="space-y-6">
        <section v-for="group in groups" :key="group.key" class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold">{{ group.label }}</h3>
              <Badge variant="secondary">{{ group.machines.length }}</Badge>
            </div>
            <span v-if="group.spend.length" class="text-xs text-muted-foreground tabular">
              {{ groupSpendLabel(group.spend) }}
            </span>
          </div>

          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div
              v-for="machine in group.machines"
              :key="machineKey(machine)"
              class="flex flex-col rounded-lg border border-border p-4 transition-colors hover:border-primary/40"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex min-w-0 items-center gap-2">
                    <StatusDot :online="machine.online" :pulse="machine.online" />
                    <span class="truncate font-medium">{{ displayName(machine) }}</span>
                  </div>
                  <p class="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {{ shortId(machine.node_id, 14) }}
                    <template v-if="machine.host_facts?.hostname"> · {{ machine.host_facts.hostname }}</template>
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  class="shrink-0"
                  @click="openEdit(machine)"
                >
                  <component :is="canAdminInventory ? (machine.id ? Pencil : Plus) : Eye" class="size-3.5" aria-hidden="true" />
                  {{ canAdminInventory ? (machine.id ? $t('fleet.inventory.actions.edit') : $t('fleet.inventory.actions.addProfile')) : $t('fleet.inventory.actions.details') }}
                </Button>
              </div>

              <div class="mt-3 flex flex-wrap gap-1.5">
                <Badge :variant="billingBadgeVariant(billingCategory(machine))">
                  {{ $t(`fleet.inventory.billing.${billingCategory(machine)}`) }}
                </Badge>
                <Badge v-if="machine.vendor" variant="outline">{{ machine.vendor }}</Badge>
                <Badge
                  v-if="nodeInventoryFor(machine.node_id)?.purity_percent != null"
                  variant="success"
                >
                  {{ $t('lines.purityBadge', { percent: nodeInventoryFor(machine.node_id)?.purity_percent }) }}
                </Badge>
                <Badge
                  :variant="renewalTone(machine) === 'destructive' ? 'destructive' : renewalTone(machine) === 'warning' ? 'warning' : 'secondary'"
                >
                  {{ renewalLabel(machine) }}
                </Badge>
              </div>

              <div class="mt-3 grid gap-1.5 text-xs text-muted-foreground">
                <div class="flex items-center justify-between">
                  <span class="inline-flex items-center gap-1">
                    <CircleDollarSign class="size-3" aria-hidden="true" />
                    {{ formatPrice(machine) }}
                    <span v-if="machine.renewal_cycle" class="text-muted-foreground/70">· {{ formatCycle(machine) }}</span>
                  </span>
                  <span v-if="formatMonthlyEquiv(machine)" class="tabular">{{ formatMonthlyEquiv(machine) }}</span>
                </div>
                <div class="flex items-center justify-between">
                  <span>{{ machine.region || $t('fleet.inventory.list.regionUnset') }}</span>
                  <span v-if="machine.updated_at">{{ $t('fleet.inventory.list.updated', { time: formatRelativeTime(machine.updated_at) }) }}</span>
                </div>
              </div>

              <div v-if="machine.has_console_url || machine.has_detail_url || machine.reminders_enabled" class="mt-3 flex flex-wrap gap-1.5">
                <Badge v-if="machine.has_console_url" variant="info">
                  <LinkIcon class="size-3" aria-hidden="true" />
                  {{ $t('fleet.inventory.list.consoleLinkStored') }}
                </Badge>
                <Badge v-if="machine.has_detail_url" variant="info">
                  <LinkIcon class="size-3" aria-hidden="true" />
                  {{ $t('fleet.inventory.list.detailLinkStored') }}
                </Badge>
                <Badge v-if="machine.reminders_enabled" variant="outline">
                  <Bell class="size-3" aria-hidden="true" />
                  {{ $t('fleet.inventory.list.reminders') }}
                </Badge>
              </div>
            </div>
          </div>
        </section>
      </div>
    </DataState>

    <!-- Edit / create dialog — opens centred regardless of list scroll -->
    <Dialog v-model:open="editOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <Pencil class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ editMachine ? displayName(editMachine) : $t('fleet.inventory.profile.title') }}
          </DialogTitle>
          <DialogDescription>
            {{ editHasProfile ? $t('fleet.inventory.profile.editSubtitle') : $t('fleet.inventory.profile.createSubtitle') }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="editMachine?.host_facts" class="grid gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs sm:grid-cols-3">
          <div class="flex items-center gap-2">
            <HardDrive class="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span class="truncate">{{ editMachine.host_facts.os || editMachine.host_facts.platform || $t('fleet.inventory.facts.unknown') }}</span>
          </div>
          <div class="flex items-center gap-2">
            <Cpu class="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span class="truncate">{{ $t('fleet.inventory.facts.cpuCores', { value: editMachine.host_facts.cpu_cores || 0 }) }}</span>
          </div>
          <div class="flex items-center gap-2">
            <MemoryStick class="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span class="truncate">{{ formatBytes(editMachine.host_facts.memory_total) }}</span>
          </div>
        </div>

        <form v-if="canAdminInventory" class="space-y-4" @submit.prevent="saveProfile">
          <div class="grid gap-2">
            <Label for="machine-node">{{ $t('fleet.inventory.profile.node') }}</Label>
            <Select v-model="nodeId">
              <SelectTrigger id="machine-node">
                <SelectValue :placeholder="$t('fleet.inventory.profile.node')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name || node.id }}
                </SelectItem>
                <SelectItem v-if="nodeId && !nodes.some((node) => node.id === nodeId)" :value="nodeId">
                  {{ nodeId }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="machine-label">{{ $t('fleet.inventory.profile.label') }}</Label>
              <Input id="machine-label" v-model="label" placeholder="gmami-jp1" />
            </div>
            <div class="grid gap-2">
              <Label for="machine-vendor">{{ $t('fleet.inventory.profile.vendor') }}</Label>
              <Input id="machine-vendor" v-model="vendor" placeholder="DMIT" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="machine-region">{{ $t('fleet.inventory.profile.region') }}</Label>
              <Input id="machine-region" v-model="region" :placeholder="$t('fleet.inventory.profile.regionPlaceholder')" />
            </div>
            <div class="grid gap-2">
              <Label for="machine-currency">{{ $t('fleet.inventory.profile.currency') }}</Label>
              <Input id="machine-currency" v-model="currency" maxlength="3" placeholder="USD" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2 content-start">
              <Label for="machine-price">{{ $t('fleet.inventory.profile.price') }}</Label>
              <Input id="machine-price" v-model="priceMajor" type="number" min="0" step="0.01" placeholder="9.90" />
              <p class="min-h-4 text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.priceHint') }}</p>
            </div>
            <div class="grid gap-2 content-start">
              <Label for="machine-purchased">{{ $t('fleet.inventory.profile.purchasedAt') }}</Label>
              <Input id="machine-purchased" v-model="purchasedAt" type="date" />
              <p class="min-h-4 text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.purchasedAtHint') }}</p>
            </div>
          </div>

          <div class="rounded-md border border-border bg-muted/20 p-3">
            <label class="flex items-start gap-2 text-sm font-medium">
              <input v-model="needsRenewal" type="checkbox" class="mt-0.5 size-4 accent-primary" />
              <span>
                {{ $t('fleet.inventory.profile.needsRenewal') }}
                <span class="block text-xs font-normal text-muted-foreground">{{ $t('fleet.inventory.profile.needsRenewalHint') }}</span>
              </span>
            </label>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2 content-start">
              <Label for="machine-cycle">{{ $t('fleet.inventory.profile.renewalCycle') }}</Label>
              <!-- Native select retained: reka-ui Select cannot represent the empty-string
                   "None" reset value without losing the ability to clear back to undefined. -->
              <select
                id="machine-cycle"
                v-model="renewalCycle"
                :disabled="!needsRenewal"
                class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <option value="">{{ $t('fleet.inventory.profile.cycle.none') }}</option>
                <option value="monthly">{{ $t('fleet.inventory.profile.cycle.monthly') }}</option>
                <option value="quarterly">{{ $t('fleet.inventory.profile.cycle.quarterly') }}</option>
                <option value="semiannual">{{ $t('fleet.inventory.profile.cycle.semiannual') }}</option>
                <option value="annual">{{ $t('fleet.inventory.profile.cycle.annual') }}</option>
                <option value="custom_days">{{ $t('fleet.inventory.profile.cycle.customDays') }}</option>
              </select>
              <p class="min-h-4 text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.renewalCycleHint') }}</p>
            </div>
            <div class="grid gap-2 content-start">
              <Label for="machine-cycle-days">{{ $t('fleet.inventory.profile.cycleDays') }}</Label>
              <Input id="machine-cycle-days" v-model="cycleDays" type="number" min="1" :disabled="!needsRenewal || renewalCycle !== 'custom_days'" />
              <p class="min-h-4 text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.cycleDaysHint') }}</p>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div class="grid gap-2 content-start">
              <Label for="machine-renewal">{{ $t('fleet.inventory.profile.nextRenewal') }}</Label>
              <Input id="machine-renewal" v-model="nextRenewal" type="date" :disabled="!needsRenewal" />
              <p class="min-h-4 text-xs text-muted-foreground">
                {{ calculatedNextRenewal ? $t('fleet.inventory.profile.nextRenewalCalculated', { date: calculatedNextRenewal }) : $t('fleet.inventory.profile.nextRenewalHint') }}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              :disabled="!needsRenewal || !calculatedNextRenewal"
              @click="useCalculatedRenewal"
            >
              <CalendarClock class="size-4" aria-hidden="true" />
              {{ $t('fleet.inventory.profile.useCalculatedRenewal') }}
            </Button>
          </div>

          <div v-if="needsRenewal && !renewalFormValid" class="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning-foreground">
            {{ $t('fleet.inventory.profile.renewalInvalidHint') }}
          </div>

          <div class="grid gap-2">
            <Label for="machine-reminders">{{ $t('fleet.inventory.profile.remindersBefore') }}</Label>
            <Input id="machine-reminders" v-model="remindDays" placeholder="14,7,1" :disabled="!needsRenewal" />
            <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.remindersBeforeHint') }}</p>
          </div>

          <div class="grid gap-2 rounded-md border border-border p-3 text-sm">
            <label class="flex items-start gap-2">
              <input v-model="autoRoll" type="checkbox" class="mt-0.5 size-4 accent-primary" :disabled="!needsRenewal" />
              <span>
                {{ $t('fleet.inventory.profile.autoRoll') }}
                <span class="block text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.autoRollHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2">
              <input v-model="remindersEnabled" type="checkbox" class="mt-0.5 size-4 accent-primary" :disabled="!needsRenewal" />
              <span>
                {{ $t('fleet.inventory.profile.enableReminders') }}
                <span class="block text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.enableRemindersHint') }}</span>
              </span>
            </label>
            <div v-if="remindersEnabled && canManageNotifications && !renewalNotificationReady" class="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning-foreground">
              {{ $t('fleet.inventory.profile.reminderNoRoute') }}
              <RouterLink :to="NOTIFICATIONS_ROUTE" class="font-medium underline underline-offset-2">
                {{ $t('fleet.inventory.profile.configureNotifications') }}
              </RouterLink>
            </div>
            <p v-else-if="remindersEnabled && canManageNotifications" class="text-xs text-muted-foreground">
              {{ $t('fleet.inventory.profile.reminderRouteReady', { count: enabledNotifyChannels.length }) }}
            </p>
            <p v-else-if="remindersEnabled" class="text-xs text-muted-foreground">
              {{ $t('fleet.inventory.profile.reminderRouteUnknown') }}
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="machine-console">{{ $t('fleet.inventory.profile.consoleUrl') }}</Label>
              <Input id="machine-console" v-model="consoleUrl" :placeholder="$t('fleet.inventory.profile.consoleUrlPlaceholder')" />
              <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.writeOnlyUrlHint') }}</p>
              <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <input v-model="clearConsoleUrl" type="checkbox" class="size-4 accent-primary" />
                {{ $t('fleet.inventory.profile.clearConsoleUrl') }}
              </label>
            </div>
            <div class="grid gap-2">
              <Label for="machine-detail">{{ $t('fleet.inventory.profile.detailUrl') }}</Label>
              <Input id="machine-detail" v-model="detailUrl" :placeholder="$t('fleet.inventory.profile.detailUrlPlaceholder')" />
              <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.writeOnlyUrlHint') }}</p>
              <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <input v-model="clearDetailUrl" type="checkbox" class="size-4 accent-primary" />
                {{ $t('fleet.inventory.profile.clearDetailUrl') }}
              </label>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="machine-notes">{{ $t('fleet.inventory.profile.notes') }}</Label>
            <textarea
              id="machine-notes"
              v-model="notes"
              class="min-h-24 rounded-md border border-input bg-background p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              :placeholder="$t('fleet.inventory.profile.notesPlaceholder')"
            />
          </div>

          <div class="flex flex-wrap gap-2">
            <Button type="submit" :disabled="pending || !canSave">
              <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
              <Save v-else class="size-4" aria-hidden="true" />
              {{ editHasProfile ? $t('fleet.inventory.profile.saveProfile') : $t('fleet.inventory.profile.createProfile') }}
            </Button>
            <Button
              v-if="editHasProfile"
              type="button"
              variant="outline"
              :disabled="renewPending || !needsRenewal || (!autoRoll && !nextRenewal)"
              @click="renewProfile"
            >
              <RefreshCw v-if="renewPending" class="size-4 animate-spin" aria-hidden="true" />
              <CalendarClock v-else class="size-4" aria-hidden="true" />
              {{ $t('fleet.inventory.profile.recordRenewal') }}
            </Button>
            <Button
              v-if="editHasProfile"
              type="button"
              variant="outline"
              :disabled="remindersPending"
              @click="runReminders(true)"
            >
              <Bell class="size-4" aria-hidden="true" />
              {{ $t('fleet.inventory.profile.runReminders') }}
            </Button>
            <Button
              v-if="editHasProfile"
              type="button"
              variant="destructive"
              :disabled="deletePending"
              @click="deleteOpen = true"
            >
              <Trash2 class="size-4" aria-hidden="true" />
              {{ $t('common.actions.delete') }}
            </Button>
          </div>
        </form>

        <div v-else-if="editMachine" class="space-y-3">
          <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.vendor') }}</dt>
              <dd>{{ editMachine.vendor || '—' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.region') }}</dt>
              <dd>{{ editMachine.region || '—' }}</dd>
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
              <dd>{{ formatDate(editMachine.purchased_at) || '—' }}</dd>
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
        <EmptyState
          v-else
          :title="$t('fleet.inventory.profile.readOnlyTitle')"
          :description="$t('fleet.inventory.profile.readOnlyDescription')"
        />
      </DialogScrollContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('fleet.inventory.profile.deleteTitle')"
      :description="editMachine ? $t('fleet.inventory.confirm.delete', { name: displayName(editMachine) }) : ''"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletePending"
      @confirm="deleteProfile"
    />
  </div>
</template>
