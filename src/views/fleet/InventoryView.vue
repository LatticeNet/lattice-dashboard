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
  DialogDescription,
  DialogFooter,
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
type BillingCategory = "renewalIncomplete" | "recurring" | "onetime" | "free" | "unpriced" | "unprofiled";
type GroupBy = "none" | "billing" | "vendor" | "region" | "renewal";

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
const FX_TARGET_KEY = "lattice:inventory:fx-target";
const FX_RATES_KEY = "lattice:inventory:fx-rates";
const warningPanelClass =
  "rounded-md border border-amber-400/60 bg-amber-500/15 p-3 text-xs text-foreground shadow-sm dark:border-amber-300/40 dark:bg-amber-400/15";

const machinesQuery = useAsyncData(() => api.machines.list().then((r) => unwrap(r, "machines")), {
  pollInterval: 12000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});
const vendorsQuery = useAsyncData(
  () => api.machineVendors.list().then((r) => (Array.isArray(r) ? r : (r.vendors ?? []))),
  { pollInterval: 60000 },
);
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
  () => renewalCycle.value !== "custom_days" || Number(s(cycleDays.value)) > 0,
);
const hasEffectiveNextRenewal = computed(() => !!(nextRenewal.value || calculatedNextRenewal.value));
const renewalSetupComplete = computed(
  () =>
    !needsRenewal.value ||
    (!!renewalCycle.value && customCycleValid.value && hasEffectiveNextRenewal.value),
);
const renewalBlocksSave = computed(
  () =>
    needsRenewal.value &&
    (!customCycleValid.value ||
      (autoRoll.value && !renewalCycle.value) ||
      (remindersEnabled.value && !hasEffectiveNextRenewal.value)),
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

const BILLING_ORDER: BillingCategory[] = ["renewalIncomplete", "recurring", "unpriced", "onetime", "free", "unprofiled"];

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
    return;
  }
  vendorProfileId.value = selected.id.startsWith("derived:") ? "" : selected.id;
  vendorUrl.value = selected.url || "";
  vendorLogoUrl.value = selected.logo_url || "";
  vendorDescription.value = selected.description || "";
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

watch(needsRenewal, (enabled) => {
  if (enabled) return;
  renewalCycle.value = "";
  cycleDays.value = "";
  nextRenewal.value = "";
  autoRoll.value = false;
  remindersEnabled.value = false;
});

watch([needsRenewal, renewalCycle], () => {
  if (!needsRenewal.value || !renewalCycle.value) autoRoll.value = false;
});

watch([needsRenewal, nextRenewal, calculatedNextRenewal], () => {
  if (!needsRenewal.value || !hasEffectiveNextRenewal.value) remindersEnabled.value = false;
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
    <datalist id="inventory-currencies">
      <option v-for="item in currencyOptions" :key="item" :value="item" />
    </datalist>
    <datalist id="inventory-vendors">
      <option v-for="item in vendors" :key="item.id" :value="item.name" />
    </datalist>

    <!-- KPI board -->
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('fleet.inventory.stats.machines')" :value="machines.length" :icon="Boxes"
        :hint="$t('fleet.inventory.stats.profiledHint', { profiled: profiledCount, missing: missingCount })" />
      <button
        type="button"
        class="group block h-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        :aria-label="$t('fleet.inventory.spend.configureRates')"
        @click="openFXDialog"
      >
        <Card class="relative h-full overflow-hidden py-0 transition-colors group-hover:bg-muted/20">
          <CardContent class="flex items-start gap-3 p-4">
            <div class="flex shrink-0 items-center justify-center rounded-lg bg-accent p-2 text-accent-foreground">
              <Wallet class="size-4" aria-hidden="true" />
            </div>
            <div class="min-w-0 flex-1 space-y-1 pr-16">
              <div class="flex min-w-0 items-center gap-2">
                <p class="text-sm text-muted-foreground">{{ $t('fleet.inventory.stats.monthlySpend') }}</p>
                <Badge v-if="totalSpendEstimate?.missing.length" variant="warning" class="shrink-0">
                  {{ $t('fleet.inventory.spend.missingRate') }}
                </Badge>
              </div>
              <div class="flex min-w-0 items-baseline gap-x-2">
                <p class="shrink-0 text-2xl font-semibold tabular leading-none text-foreground">
                  {{ spendCardValue }}
                </p>
                <p v-if="spendCardHint" class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {{ spendCardHint }}
                </p>
              </div>
            </div>
            <span
              class="pointer-events-none absolute right-3 top-3 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              {{ $t('fleet.inventory.spend.configureRates') }}
            </span>
          </CardContent>
        </Card>
      </button>
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
                <p class="text-xs font-medium">{{ entry.currency }} → {{ entry.target }}</p>
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
                <div class="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button variant="ghost" size="sm" as-child>
                    <RouterLink :to="{ name: 'node-detail', params: { id: machine.node_id } }">
                      {{ $t('fleet.inventory.actions.node') }}
                    </RouterLink>
                  </Button>
                  <Button variant="ghost" size="sm" as-child>
                    <RouterLink :to="{ path: '/plugins/latticenet.vpn-core/lines', query: { node: machine.node_id } }">
                      {{ $t('fleet.inventory.actions.vpn') }}
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
              <div class="grid gap-2">
                <Select v-model="vendor">
                  <SelectTrigger class="min-w-0">
                    <SelectValue :placeholder="$t('fleet.inventory.profile.vendorSelectPlaceholder')" />
                  </SelectTrigger>
                  <SelectContent class="max-w-[min(92vw,28rem)]">
                    <SelectItem
                      v-for="item in vendorChoices"
                      :key="item.id"
                      :value="item.name"
                      :text-value="item.name"
                    >
                      <span class="flex min-w-0 items-center gap-2">
                        <img
                          v-if="item.logo_url"
                          :src="item.logo_url"
                          alt=""
                          class="size-4 rounded-sm object-contain"
                        />
                        <span class="min-w-0">
                          <span class="block truncate">{{ item.name }}</span>
                          <span v-if="vendorSubtitle(item)" class="block truncate text-[11px] text-muted-foreground">
                            {{ vendorSubtitle(item) }}
                          </span>
                        </span>
                      </span>
                    </SelectItem>
                    <SelectItem v-if="vendor && !selectedVendorProfile" :value="vendor" :text-value="vendor">
                      {{ $t('fleet.inventory.profile.customVendor', { name: vendor }) }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Input id="machine-vendor" v-model="vendor" placeholder="DMIT" />
              </div>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.vendorNameHint') }}</p>
            </div>
          </div>

          <div v-if="vendor" class="grid gap-3 rounded-md border border-border bg-muted/20 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                  <img
                    v-if="vendorLogoUrl"
                    :src="vendorLogoUrl"
                    alt=""
                    class="max-h-6 max-w-6 rounded-sm object-contain"
                  />
                  <Boxes v-else class="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{{ $t('fleet.inventory.profile.vendorDirectory') }}</p>
                  <p class="truncate text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.vendorDirectoryHint') }}</p>
                </div>
              </div>
              <a
                v-if="selectedVendorProfile?.url"
                :href="selectedVendorProfile.url"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                {{ $t('fleet.inventory.profile.openVendor') }}
                <ExternalLink class="size-3" aria-hidden="true" />
              </a>
            </div>
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
              <textarea
                id="machine-vendor-description"
                v-model="vendorDescription"
                class="min-h-16 rounded-md border border-input bg-background p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                :placeholder="$t('fleet.inventory.profile.vendorDescriptionPlaceholder')"
              />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="machine-region">{{ $t('fleet.inventory.profile.region') }}</Label>
              <Input id="machine-region" v-model="region" :placeholder="$t('fleet.inventory.profile.regionPlaceholder')" />
            </div>
            <div class="grid gap-2">
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
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2 content-start">
              <Label for="machine-price">{{ $t('fleet.inventory.profile.price') }}</Label>
              <Input id="machine-price" v-model="priceMajor" type="number" min="0" step="0.01" placeholder="9.90" />
              <p class="min-h-4 text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.priceHint') }}</p>
            </div>
            <div class="grid gap-2 content-start">
              <Label for="machine-purchased">{{ $t('fleet.inventory.profile.purchasedAt') }}</Label>
              <div class="relative">
                <CalendarClock class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id="machine-purchased" v-model="purchasedAt" type="date" class="pl-9" />
              </div>
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
              <Select v-model="renewalCycleSelect" :disabled="!needsRenewal">
                <SelectTrigger id="machine-cycle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NO_RENEWAL_CYCLE">{{ $t('fleet.inventory.profile.cycle.none') }}</SelectItem>
                  <SelectItem value="monthly">{{ $t('fleet.inventory.profile.cycle.monthly') }}</SelectItem>
                  <SelectItem value="quarterly">{{ $t('fleet.inventory.profile.cycle.quarterly') }}</SelectItem>
                  <SelectItem value="semiannual">{{ $t('fleet.inventory.profile.cycle.semiannual') }}</SelectItem>
                  <SelectItem value="annual">{{ $t('fleet.inventory.profile.cycle.annual') }}</SelectItem>
                  <SelectItem value="custom_days">{{ $t('fleet.inventory.profile.cycle.customDays') }}</SelectItem>
                </SelectContent>
              </Select>
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
              <div class="relative">
                <CalendarClock class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input id="machine-renewal" v-model="nextRenewal" type="date" class="pl-9" :disabled="!needsRenewal" />
              </div>
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

          <div v-if="renewalBlocksSave" :class="warningPanelClass">
            {{ $t('fleet.inventory.profile.renewalInvalidHint') }}
          </div>
          <div v-else-if="renewalDraftIncomplete" :class="warningPanelClass">
            {{ $t('fleet.inventory.profile.renewalDraftHint') }}
          </div>

          <div class="grid gap-2">
            <Label for="machine-reminders">{{ $t('fleet.inventory.profile.remindersBefore') }}</Label>
            <Input id="machine-reminders" v-model="remindDays" placeholder="14,7,1" :disabled="!needsRenewal" />
            <p class="text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.remindersBeforeHint') }}</p>
          </div>

          <div class="grid gap-2 rounded-md border border-border p-3 text-sm">
            <label class="flex items-start gap-2">
              <input v-model="autoRoll" type="checkbox" class="mt-0.5 size-4 accent-primary" :disabled="!needsRenewal || !renewalCycle" />
              <span>
                {{ $t('fleet.inventory.profile.autoRoll') }}
                <span class="block text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.autoRollHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2">
              <input v-model="remindersEnabled" type="checkbox" class="mt-0.5 size-4 accent-primary" :disabled="!needsRenewal || !hasEffectiveNextRenewal" />
              <span>
                {{ $t('fleet.inventory.profile.enableReminders') }}
                <span class="block text-xs text-muted-foreground">{{ $t('fleet.inventory.profile.enableRemindersHint') }}</span>
              </span>
            </label>
            <div v-if="remindersEnabled && canManageNotifications && !renewalNotificationReady" :class="warningPanelClass">
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
