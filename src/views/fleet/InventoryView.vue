<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
  Bell,
  BookOpen,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Cpu,
  Eye,
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
  Wallet,
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
  shortId,
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
  DialogClose,
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
const route = useRoute();
const router = useRouter();
const INVENTORY_GUIDE_URL = "https://latticenet.github.io/guide/operations#machine-inventory";
const NOTIFICATIONS_ROUTE = "/platform/notifications";
const FX_TARGET_KEY = "lattice:inventory:fx-target";
const FX_RATES_KEY = "lattice:inventory:fx-rates";
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
const search = ref("");
const groupBy = ref<GroupBy>(parseInventoryGroup(route.query.group));
// The grouping lives in the address bar (see inventoryGroupingModel), so the
// Renewal view survives a reload and back/forward restores it.
watch(groupBy, (group) => {
  const wanted = group === DEFAULT_INVENTORY_GROUP ? undefined : group;
  if (route.query.group === wanted) return;
  router.replace({ query: { ...route.query, group: wanted } }).catch(() => {});
});
watch(
  () => route.query.group,
  (value) => {
    groupBy.value = parseInventoryGroup(value);
  },
);

// ── Edit dialog state ─────────────────────────────────────────────────────────
const editOpen = ref(false);
const editKey = ref("");
const pending = ref(false);
const deletePending = ref(false);
const deleteOpen = ref(false);
const renewPending = ref(false);
const remindersPending = ref(false);
const remindersAllPending = ref(false);
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
const remindDays = ref("14,7,1");
const consoleUrl = ref("");
const detailUrl = ref("");
const clearConsoleUrl = ref(false);
const clearDetailUrl = ref(false);
const fxDialogOpen = ref(false);
const fxTarget = ref(loadFXTarget());
const fxRates = ref<Record<string, string>>(loadFXRates());
const fxTargetDraft = ref(fxTarget.value);
const fxRatesDraft = ref<Record<string, string>>({ ...fxRates.value });

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
  if (fxTarget.value) items.add(normalizeCurrency(fxTarget.value));
  if (fxTargetDraft.value) items.add(normalizeCurrency(fxTargetDraft.value));
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
const primarySpend = computed<CurrencySpend | undefined>(() => spendByCurrency.value[0]);
const primaryMonthlyLabel = computed(() => {
  const p = primarySpend.value;
  if (!p) return t("fleet.inventory.spend.none");
  return t("fleet.inventory.spend.perMonth", {
    amount: formatMoney(Math.round(p.monthly), p.currency),
  });
});
const spendCurrencyLabels = computed(() =>
  spendByCurrency.value.map((entry) =>
    t("fleet.inventory.spend.perMonth", {
      amount: formatMoney(Math.round(entry.monthly), entry.currency),
    }),
  ),
);
const totalSpendEstimate = computed(() => estimateTotalSpend(spendByCurrency.value));
const draftSpendEstimate = computed(() =>
  estimateTotalSpend(spendByCurrency.value, normalizeCurrency(fxTargetDraft.value) || "USD", fxRatesDraft.value),
);
const spendCardValue = computed(() => {
  if (spendByCurrency.value.length === 0) return t("fleet.inventory.spend.none");
  const target = normalizeCurrency(fxTarget.value) || "USD";
  const estimate = totalSpendEstimate.value;
  if (!estimate) return primaryMonthlyLabel.value;
  return t("fleet.inventory.spend.perMonth", {
    amount: formatMoney(estimate.monthlyCents, target),
  });
});
const spendCardHint = computed(() => {
  const parts = spendCurrencyLabels.value.slice(0, 3);
  const remaining = spendCurrencyLabels.value.length - parts.length;
  if (remaining > 0) parts.push(t("fleet.inventory.spend.moreCurrencies", { count: remaining }));
  if (freeCount.value > 0) parts.push(t("fleet.inventory.spend.free", { count: freeCount.value }));
  const missing = totalSpendEstimate.value?.missing ?? [];
  if (missing.length > 0) parts.push(t("fleet.inventory.spend.missingShort", { currencies: missing.join(", ") }));
  return parts.join(" · ");
});
const fxRateDraftRows = computed(() => buildFXRateRows(fxTargetDraft.value, fxRatesDraft.value));

function buildFXRateRows(targetValue: string, rates: Record<string, string>) {
  const target = normalizeCurrency(targetValue) || "USD";
  return spendByCurrency.value
    .filter((item) => normalizeCurrency(item.currency) !== target)
    .map((entry) => {
      const rate = fxRateFor(entry.currency, targetValue, rates);
      return {
        ...entry,
        currency: normalizeCurrency(entry.currency),
        target,
        rateValue: fxRateValue(entry.currency, targetValue, rates),
        missing: !rate,
        convertedMonthlyCents: rate ? Math.round(entry.monthly * rate) : undefined,
        convertedAnnualCents: rate ? Math.round(entry.annual * rate) : undefined,
      };
    });
}

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
      if (!renewalDate(m)) return false;
      const days = m.days_until_renewal;
      return days !== undefined && days >= 0 && days <= 14;
    }).length,
);
const overdueCount = computed(
  () =>
    machines.value.filter((m) => {
      if (!renewalDate(m)) return false;
      const days = m.days_until_renewal;
      return days !== undefined && days < 0;
    }).length,
);
const trackedRenewalCount = computed(() => machines.value.filter((m) => !!renewalDate(m)).length);
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

function normalizeVendorKey(value?: string): string {
  return s(value).toLowerCase();
}

function normalizeCurrency(value: unknown): string {
  return s(value).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
}

function loadFXTarget(): string {
  if (typeof localStorage === "undefined") return "USD";
  return normalizeCurrency(localStorage.getItem(FX_TARGET_KEY)) || "USD";
}

function loadFXRates(): Record<string, string> {
  if (typeof localStorage === "undefined") return { "USDT->USD": "1", "USDC->USD": "1" };
  try {
    const parsed = JSON.parse(localStorage.getItem(FX_RATES_KEY) || "{}") as Record<string, unknown>;
    const out: Record<string, string> = { "USDT->USD": "1", "USDC->USD": "1" };
    for (const [key, value] of Object.entries(parsed)) {
      const pair = normalizeFXRateKey(key);
      if (pair) out[pair] = s(value);
    }
    return out;
  } catch {
    return { "USDT->USD": "1", "USDC->USD": "1" };
  }
}

function persistFX() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FX_TARGET_KEY, normalizeCurrency(fxTarget.value) || "USD");
  localStorage.setItem(FX_RATES_KEY, JSON.stringify(fxRates.value));
}

function fxPairKey(source: string, target = normalizeCurrency(fxTarget.value) || "USD"): string {
  return `${normalizeCurrency(source)}->${normalizeCurrency(target) || "USD"}`;
}

function normalizeFXRateKey(key: string): string {
  const [source, target] = key.includes("->") ? key.split("->") : [key, "USD"];
  const src = normalizeCurrency(source);
  const dst = normalizeCurrency(target);
  return src && dst ? `${src}->${dst}` : "";
}

function fxRateValue(
  currencyCode: string,
  targetValue = fxTarget.value,
  rates: Record<string, string> = fxRates.value,
): string {
  const cur = normalizeCurrency(currencyCode);
  const target = normalizeCurrency(targetValue) || "USD";
  if (!cur || cur === target) return "1";
  const pair = fxPairKey(cur, target);
  if (rates[pair] != null) return rates[pair];
  // Compatibility with the original USD-targeted localStorage shape.
  if (target === "USD" && rates[cur] != null) return rates[cur];
  return "";
}

function openFXDialog() {
  fxTargetDraft.value = normalizeCurrency(fxTarget.value) || "USD";
  fxRatesDraft.value = { ...fxRates.value };
  fxDialogOpen.value = true;
}

function setDraftFXRate(currencyCode: string, value: string) {
  const cur = normalizeCurrency(currencyCode);
  const target = normalizeCurrency(fxTargetDraft.value) || "USD";
  if (!cur || cur === target) return;
  fxRatesDraft.value = { ...fxRatesDraft.value, [fxPairKey(cur, target)]: value };
}

function saveFXSettings() {
  fxTarget.value = normalizeCurrency(fxTargetDraft.value) || "USD";
  fxRates.value = { ...fxRatesDraft.value };
  persistFX();
  fxDialogOpen.value = false;
}

function fxRateFor(
  currencyCode: string,
  targetValue = fxTarget.value,
  rates: Record<string, string> = fxRates.value,
): number | undefined {
  const cur = normalizeCurrency(currencyCode);
  const target = normalizeCurrency(targetValue) || "USD";
  if (!cur) return undefined;
  if (cur === target) return 1;
  const parsed = Number(s(fxRateValue(cur, target, rates)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function estimateTotalSpend(
  spend: CurrencySpend[],
  targetValue = fxTarget.value,
  rates: Record<string, string> = fxRates.value,
): { monthlyCents: number; annualCents: number; missing: string[] } | undefined {
  if (spend.length === 0) return undefined;
  let monthlyMajor = 0;
  const missing: string[] = [];
  for (const entry of spend) {
    const rate = fxRateFor(entry.currency, targetValue, rates);
    if (!rate) {
      missing.push(entry.currency);
      continue;
    }
    monthlyMajor += (entry.monthly / 100) * rate;
  }
  return {
    monthlyCents: Math.round(monthlyMajor * 100),
    annualCents: Math.round(monthlyMajor * 12 * 100),
    missing: [...new Set(missing)].sort(),
  };
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
  // A ?node= deep link opened the editor; left behind, it reopens the editor
  // on the next reload.
  if (route.query.node !== undefined) {
    router.replace({ query: { ...route.query, node: undefined } }).catch(() => {});
  }
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
  document.getElementById("machine-editor-title")?.focus({ preventScroll: true });
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
  remindDays.value = (machine.remind_days_before?.length ? machine.remind_days_before : [14, 7, 1]).join(
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

watch(fxTarget, () => {
  fxTarget.value = normalizeCurrency(fxTarget.value) || "USD";
  persistFX();
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
    <datalist id="inventory-currencies">
      <option v-for="item in currencyOptions" :key="item" :value="item" />
    </datalist>
    <datalist id="inventory-vendors">
      <option v-for="item in vendors" :key="item.id" :value="item.name" />
    </datalist>

    <!-- KPI board -->
    <!-- min-w-0 on every card: a grid item's minimum is its content, so at 375
         the spend card's longest line pushed the page 20px wider than the
         viewport instead of truncating. -->
    <div class="grid auto-rows-[8rem] gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
      <StatCard :label="$t('fleet.inventory.stats.machines')" :value="machines.length" :icon="Boxes"
        :hint="$t('fleet.inventory.stats.profiledHint', { profiled: profiledCount, missing: missingCount })"
        class="h-full py-0" hint-placement="bottom" />
      <button
        type="button"
        class="group block h-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        :aria-label="$t('fleet.inventory.spend.configureRates')"
        :title="$t('fleet.inventory.spend.configureRates')"
        @click="openFXDialog"
      >
        <Card class="relative h-full overflow-hidden py-0 transition-colors group-hover:bg-muted/20">
          <CardContent class="flex h-full items-start gap-3 p-4">
            <div class="flex shrink-0 items-center justify-center rounded-lg bg-accent p-2 text-accent-foreground">
              <Wallet class="size-4" aria-hidden="true" />
            </div>
            <div class="flex h-full min-w-0 flex-1 flex-col">
              <div class="flex min-w-0 items-center gap-2">
                <p class="text-sm text-muted-foreground">{{ $t('fleet.inventory.stats.monthlySpend') }}</p>
                <Badge v-if="totalSpendEstimate?.missing.length" variant="warning" class="shrink-0">
                  {{ $t('fleet.inventory.spend.missingRate') }}
                </Badge>
              </div>
              <p class="mt-1 truncate text-2xl font-semibold tabular leading-none text-foreground" :title="spendCardValue">
                {{ spendCardValue }}
              </p>
              <p v-if="spendCardHint" class="mt-auto truncate text-xs text-muted-foreground" :title="spendCardHint">
                {{ spendCardHint }}
              </p>
            </div>
          </CardContent>
        </Card>
      </button>
      <StatCard :label="$t('fleet.inventory.stats.renewalRisk')" :value="renewalSoonCount" :icon="CalendarClock"
        :tone="overdueCount > 0 ? 'destructive' : renewalSoonCount > 0 ? 'warning' : 'success'"
        :hint="$t('fleet.inventory.stats.overdueHint', { count: overdueCount })"
        class="h-full py-0" hint-placement="bottom" />
      <StatCard :label="$t('fleet.inventory.stats.coverage')" :value="`${profiledCount} / ${machines.length}`"
        :icon="CheckCircle2" :tone="missingCount > 0 ? 'warning' : 'success'"
        :hint="$t('fleet.inventory.stats.needsProfileHint', { count: missingCount })"
        class="h-full py-0" hint-placement="bottom" />
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

    <Dialog v-model:open="fxDialogOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <Wallet class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('fleet.inventory.spend.rateDialogTitle') }}
          </DialogTitle>
          <DialogDescription>
            {{ $t('fleet.inventory.spend.rateDialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <div class="grid gap-4">
          <div class="rounded-lg border border-border bg-muted/20 p-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="text-sm font-medium">{{ $t('fleet.inventory.spend.estimatedTotal') }}</p>
                <p v-if="draftSpendEstimate" class="mt-0.5 text-xs text-muted-foreground">
                  {{ $t('fleet.inventory.spend.perMonth', { amount: formatMoney(draftSpendEstimate.monthlyCents, fxTargetDraft) }) }}
                  · {{ $t('fleet.inventory.spend.perYear', { amount: formatMoney(draftSpendEstimate.annualCents, fxTargetDraft) }) }}
                </p>
                <p class="mt-1 text-[11px] text-muted-foreground">{{ $t('fleet.inventory.spend.rateCardHint') }}</p>
              </div>
              <div class="grid gap-1.5">
                <Label for="inventory-fx-target" class="text-xs text-muted-foreground">{{ $t('fleet.inventory.spend.target') }}</Label>
                <Select v-model="fxTargetDraft">
                  <SelectTrigger id="inventory-fx-target" size="sm" class="w-32">
                    <SelectValue :placeholder="$t('fleet.inventory.spend.target')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="cur in currencyOptions" :key="`target-${cur}`" :value="cur">
                      {{ cur }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p v-if="draftSpendEstimate?.missing.length" class="mt-3 rounded-md border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
              {{ $t('fleet.inventory.spend.missingRates', { currencies: draftSpendEstimate.missing.join(', ') }) }}
            </p>
          </div>

          <div v-if="fxRateDraftRows.length" class="grid gap-2">
            <div
              v-for="entry in fxRateDraftRows"
              :key="`rate-draft-${entry.currency}`"
              :class="cn(
                'grid gap-2 rounded-md border p-2.5 sm:grid-cols-[minmax(90px,auto)_minmax(0,1fr)_minmax(120px,auto)] sm:items-center',
                entry.missing ? 'border-amber-400/50 bg-amber-500/10' : 'border-border bg-muted/20',
              )"
            >
              <div class="min-w-0">
                <p class="text-xs font-medium">{{ $t('fleet.inventory.spend.pair', { source: entry.currency, target: entry.target }) }}</p>
                <p class="text-[11px] text-muted-foreground">
                  {{ $t('fleet.inventory.spend.perMonth', { amount: formatMoney(Math.round(entry.monthly), entry.currency) }) }}
                </p>
              </div>
              <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 text-xs text-muted-foreground">1 {{ entry.currency }} =</span>
                <Input
                  class="h-8 min-w-24 flex-1 text-xs tabular"
                  inputmode="decimal"
                  :aria-label="$t('fleet.inventory.spend.rateInput', { source: entry.currency, target: entry.target })"
                  :placeholder="entry.target"
                  :model-value="entry.rateValue"
                  @update:model-value="(value) => setDraftFXRate(entry.currency, String(value ?? ''))"
                />
                <span class="shrink-0 text-xs text-muted-foreground">{{ entry.target }}</span>
              </div>
              <div class="text-xs sm:text-right">
                <span v-if="entry.convertedMonthlyCents != null" class="font-medium tabular">
                  {{ $t('fleet.inventory.spend.perMonth', { amount: formatMoney(entry.convertedMonthlyCents, entry.target) }) }}
                </span>
                <Badge v-else variant="warning">{{ $t('fleet.inventory.spend.missingRate') }}</Badge>
              </div>
            </div>
          </div>
          <p v-else class="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            {{ $t('fleet.inventory.spend.singleCurrency') }}
          </p>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="button" @click="saveFXSettings">
            <Save class="size-4" aria-hidden="true" />
            {{ $t('fleet.inventory.spend.saveRates') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

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
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
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
                    <StatusDot :status="machine.online ? 'online' : 'offline'" :pulse="machine.online" />
                    <span class="truncate font-medium" :title="displayName(machine)">{{ displayName(machine) }}</span>
                  </div>
                  <p
                    class="mt-1 truncate font-mono text-xs text-muted-foreground"
                    :title="[machine.node_id, machine.host_facts?.hostname].filter(Boolean).join(' · ')"
                  >
                    {{ shortId(machine.node_id, 14) }}
                    <template v-if="machine.host_facts?.hostname"> · {{ machine.host_facts.hostname }}</template>
                  </p>
                </div>
                <div class="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button variant="ghost" size="sm" as-child>
                    <RouterLink :to="{ name: 'node-detail', params: { id: machine.node_id } }">
                      {{ $t('fleet.inventory.actions.node') }}
                    </RouterLink>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    @click="openEdit(machine)"
                  >
                    <component :is="canAdminInventory ? (machine.id ? Pencil : Plus) : Eye" class="size-3.5" aria-hidden="true" />
                    {{ canAdminInventory ? (machine.id ? $t('fleet.inventory.actions.edit') : $t('fleet.inventory.actions.addProfile')) : $t('fleet.inventory.actions.details') }}
                  </Button>
                </div>
              </div>

              <div class="mt-3 flex flex-wrap gap-1.5">
                <Badge :variant="billingBadgeVariant(billingCategory(machine))">
                  {{ $t(`fleet.inventory.billing.${billingCategory(machine)}`) }}
                </Badge>
                <a
                  v-if="machine.vendor && vendorProfileFor(machine)?.url"
                  :href="vendorProfileFor(machine)?.url"
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                >
                  <img
                    v-if="vendorProfileFor(machine)?.logo_url"
                    :src="vendorProfileFor(machine)?.logo_url"
                    alt=""
                    class="size-3 rounded-sm object-contain"
                  />
                  {{ machine.vendor }}
                  <ExternalLink class="size-3" aria-hidden="true" />
                </a>
                <Badge v-else-if="machine.vendor" variant="outline">{{ machine.vendor }}</Badge>
                <Badge
                  v-if="nodeInventoryFor(machine.node_id)?.purity_percent != null"
                  variant="success"
                >
                  {{ $t('fleet.inventory.purityBadge', { percent: nodeInventoryFor(machine.node_id)?.purity_percent }) }}
                </Badge>
                <!-- Left out when the billing chip already says "Renewal setup needed". -->
                <Badge
                  v-if="billingCategory(machine) !== 'renewalIncomplete'"
                  :variant="renewalTone(machine) === 'destructive' ? 'destructive' : renewalTone(machine) === 'warning' ? 'warning' : 'secondary'"
                >
                  {{ renewalLabel(machine) }}
                </Badge>
                <!-- The date beside the countdown: "12d left" says how soon, the
                     date says when, and a renewal view is read for both. -->
                <span
                  v-if="renewalDate(machine) && !renewalSetupIncomplete(machine) && machine.days_until_renewal !== undefined"
                  class="self-center font-mono text-xs tabular text-muted-foreground"
                >{{ renewalDate(machine) }}</span>
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
                <Button
                  v-if="machine.has_console_url && canAdminInventory"
                  type="button"
                  variant="outline"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  :disabled="!!linkRevealPending"
                  @click="revealMachineLink(machine, 'console')"
                >
                  <RefreshCw v-if="linkRevealPending === linkPendingKey(machine, 'console')" class="size-3 animate-spin" aria-hidden="true" />
                  <ExternalLink v-else class="size-3" aria-hidden="true" />
                  {{ $t('fleet.inventory.list.openConsole') }}
                </Button>
                <Badge v-else-if="machine.has_console_url" variant="info">
                  <LinkIcon class="size-3" aria-hidden="true" />
                  {{ $t('fleet.inventory.list.consoleLinkStored') }}
                </Badge>
                <Button
                  v-if="machine.has_detail_url && canAdminInventory"
                  type="button"
                  variant="outline"
                  size="sm"
                  class="h-7 px-2 text-xs"
                  :disabled="!!linkRevealPending"
                  @click="revealMachineLink(machine, 'detail')"
                >
                  <RefreshCw v-if="linkRevealPending === linkPendingKey(machine, 'detail')" class="size-3 animate-spin" aria-hidden="true" />
                  <ExternalLink v-else class="size-3" aria-hidden="true" />
                  {{ $t('fleet.inventory.list.openDetail') }}
                </Button>
                <Badge v-else-if="machine.has_detail_url" variant="info">
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
          <DialogTitle id="machine-editor-title" tabindex="-1" class="flex min-w-0 items-center gap-2 outline-none">
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
            <div class="grid gap-3 sm:grid-cols-2">
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
                <div class="grid gap-3 sm:grid-cols-2">
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
            <div class="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)]">
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
            <div v-if="needsRenewal" class="grid gap-3 sm:grid-cols-2">
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
            <h3 id="machine-section-renewal" class="font-mono text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
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
                />
                <div>
                  <label for="machine-reminders-enabled">{{ $t('fleet.inventory.profile.enableReminders') }}</label>
                  <p id="machine-reminders-enabled-hint" class="text-xs text-muted-foreground">
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
                  placeholder="14,7,1"
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
                :disabled="remindersPending || formDirty"
                @click="runReminders(true)"
              >
                <Bell class="size-4" aria-hidden="true" />
                {{ $t('fleet.inventory.profile.runReminders') }}
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
              <div class="grid gap-3 sm:grid-cols-2">
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
          <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
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
