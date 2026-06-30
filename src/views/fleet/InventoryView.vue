<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { toast } from "vue-sonner";
import {
  Bell,
  BookOpen,
  Boxes,
  CalendarClock,
  CheckCircle2,
  DollarSign,
  HardDrive,
  Link,
  Pencil,
  RefreshCw,
  Save,
  Server,
  Trash2,
} from "lucide-vue-next";
import { api, unwrap, type MachineProfileInput, type MachineView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import {
  formatBytes,
  formatDateTime,
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

const auth = useAuthStore();
const { t } = useI18n();
const route = useRoute();
const INVENTORY_GUIDE_URL = "https://latticenet.github.io/guide/operations#machine-inventory";

const machinesQuery = useAsyncData(() => api.machines.list().then((r) => unwrap(r, "machines")), {
  pollInterval: 12000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const selectedKey = ref("");
const pending = ref(false);
const deletePending = ref(false);
const deleteOpen = ref(false);
const renewPending = ref(false);
const remindersPending = ref(false);

const profileId = ref("");
const nodeId = ref("");
const label = ref("");
const vendor = ref("");
const region = ref("");
const notes = ref("");
const priceMajor = ref("");
const currency = ref("USD");
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
const canAdminInventory = computed(() => auth.can("inventory:admin"));
const selectedMachine = computed(() =>
  machines.value.find((machine) => machineKey(machine) === selectedKey.value),
);

const sortedMachines = computed(() =>
  [...machines.value].sort((a, b) => {
    const aProfile = !!a.id;
    const bProfile = !!b.id;
    if (aProfile !== bProfile) return aProfile ? -1 : 1;
    return displayName(a).localeCompare(displayName(b));
  }),
);

const profiledCount = computed(() => machines.value.filter((machine) => !!machine.id).length);
const missingCount = computed(() => machines.value.filter((machine) => !machine.id).length);
const renewalSoonCount = computed(() =>
  machines.value.filter((machine) => {
    const days = machine.days_until_renewal;
    return days !== undefined && days >= 0 && days <= 14;
  }).length,
);
const totalCostCents = computed(() =>
  machines.value.reduce((sum, machine) => sum + (machine.price_cents ?? 0), 0),
);
const totalCostCurrency = computed(() => {
  const currencies = new Set(
    machines.value
      .filter((machine) => (machine.price_cents ?? 0) > 0)
      .map((machine) => machine.currency || "USD"),
  );
  if (currencies.size === 0) return "USD";
  if (currencies.size === 1) return [...currencies][0];
  return "USD";
});
const totalCostLabel = computed(() => {
  const currencies = new Set(
    machines.value
      .filter((machine) => (machine.price_cents ?? 0) > 0)
      .map((machine) => machine.currency || "USD"),
  );
  if (currencies.size > 1) return t("fleet.inventory.cost.mixed");
  return formatMoney(totalCostCents.value, totalCostCurrency.value);
});
const canSave = computed(() => !!nodeId.value && canAdminInventory.value);
const selectedHasProfile = computed(() => !!profileId.value);
const selectedRenewalTone = computed<RenewalTone>(() => renewalTone(selectedMachine.value));
const pricedCount = computed(() => machines.value.filter((machine) => (machine.price_cents ?? 0) > 0).length);
const trackedRenewalCount = computed(() => machines.value.filter((machine) => !!machine.next_renewal).length);
const remindersEnabledCount = computed(() => machines.value.filter((machine) => machine.reminders_enabled).length);
const storedLinkCount = computed(() =>
  machines.value.filter((machine) => machine.has_console_url || machine.has_detail_url).length,
);
const vendorSummary = computed(() => topValueSummary((machine) => machine.vendor));
const regionSummary = computed(() => topValueSummary((machine) => machine.region));

watch(
  machines,
  (list) => {
    if (list.length === 0) {
      selectedKey.value = "";
      resetForm();
      return;
    }
    const first = sortedMachines.value[0];
    if (first && (!selectedKey.value || !list.some((machine) => machineKey(machine) === selectedKey.value))) {
      selectMachine(first);
    }
  },
  { immediate: true },
);

watch(selectedMachine, (machine) => {
  if (machine) loadForm(machine);
});

// Deep-link: /inventory?node=<id> selects that node's machine row once the list
// loads (e.g. arriving from a node's "Inventory" cross-link). Seeds once per id
// so the 12s machines poll never clobbers a later manual selection.
const seededNodeQuery = ref<string | undefined>(undefined);
watch(
  [machines, () => route.query.node],
  ([list, nodeQ]) => {
    const id = typeof nodeQ === "string" ? nodeQ : undefined;
    if (!id || id === seededNodeQuery.value || list.length === 0) return;
    const m = list.find((x) => x.node_id === id);
    seededNodeQuery.value = id;
    if (m) selectMachine(m);
  },
  { immediate: true },
);

function machineKey(machine: MachineView): string {
  return machine.id || `node:${machine.node_id}`;
}

function displayName(machine: MachineView): string {
  return machine.label || machine.node_name || machine.node_id;
}

function profileLabel(machine: MachineView): string {
  if (machine.id) return t("fleet.inventory.badge.profiled");
  return t("fleet.inventory.badge.needsProfile");
}

function profileVariant(machine: MachineView): "success" | "warning" {
  return machine.id ? "success" : "warning";
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

function parsePriceCents(): number | undefined {
  const trimmed = priceMajor.value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100);
}

function parseReminderDays(): number[] {
  return [...new Set(
    remindDays.value
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 365),
  )].sort((a, b) => b - a);
}

function formatPrice(machine: MachineView): string {
  if (!machine.price_cents) return t("fleet.inventory.price.notPriced");
  return formatMoney(machine.price_cents, machine.currency || "USD");
}

function formatCycle(machine: MachineView): string {
  if (!machine.renewal_cycle) return t("fleet.inventory.cycleLabel.noCycle");
  if (machine.renewal_cycle === "custom_days")
    return t("fleet.inventory.cycleLabel.customDays", { days: machine.cycle_days || 0 });
  return machine.renewal_cycle;
}

function topValueSummary(selector: (machine: MachineView) => string | undefined): string {
  const counts = new Map<string, number>();
  for (const machine of machines.value) {
    const value = selector(machine)?.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([value, count]) => `${value} ${count}`)
    .join(" · ");
}

function selectMachine(machine: MachineView) {
  selectedKey.value = machineKey(machine);
  loadForm(machine);
}

function resetForm() {
  profileId.value = "";
  nodeId.value = "";
  label.value = "";
  vendor.value = "";
  region.value = "";
  notes.value = "";
  priceMajor.value = "";
  currency.value = "USD";
  renewalCycle.value = "";
  cycleDays.value = "";
  nextRenewal.value = "";
  autoRoll.value = false;
  remindersEnabled.value = false;
  remindDays.value = "14,7,1";
  consoleUrl.value = "";
  detailUrl.value = "";
  clearConsoleUrl.value = false;
  clearDetailUrl.value = false;
}

function loadForm(machine: MachineView) {
  profileId.value = machine.id || "";
  nodeId.value = machine.node_id;
  label.value = machine.label || "";
  vendor.value = machine.vendor || "";
  region.value = machine.region || "";
  notes.value = machine.notes || "";
  priceMajor.value = machine.price_cents ? String((machine.price_cents / 100).toFixed(2)) : "";
  currency.value = machine.currency || "USD";
  renewalCycle.value = machine.renewal_cycle || "";
  cycleDays.value = machine.cycle_days ? String(machine.cycle_days) : "";
  nextRenewal.value = formatDate(machine.next_renewal);
  autoRoll.value = !!machine.auto_roll;
  remindersEnabled.value = !!machine.reminders_enabled;
  remindDays.value = (machine.remind_days_before?.length ? machine.remind_days_before : [14, 7, 1]).join(",");
  consoleUrl.value = "";
  detailUrl.value = "";
  clearConsoleUrl.value = false;
  clearDetailUrl.value = false;
}

function buildInput(): MachineProfileInput {
  return {
    id: profileId.value || undefined,
    node_id: nodeId.value,
    label: label.value.trim() || undefined,
    vendor: vendor.value.trim() || undefined,
    region: region.value.trim() || undefined,
    notes: notes.value.trim() || undefined,
    price_cents: parsePriceCents(),
    currency: currency.value.trim() || undefined,
    renewal_cycle: renewalCycle.value || undefined,
    cycle_days: renewalCycle.value === "custom_days" ? Number(cycleDays.value || 0) : undefined,
    next_renewal: isoDate(nextRenewal.value),
    auto_roll: autoRoll.value,
    remind_days_before: parseReminderDays(),
    reminders_enabled: remindersEnabled.value,
    console_url: consoleUrl.value.trim() || undefined,
    detail_url: detailUrl.value.trim() || undefined,
    clear_console_url: clearConsoleUrl.value,
    clear_detail_url: clearDetailUrl.value,
  };
}

function refreshAll() {
  machinesQuery.refresh();
  nodesQuery.refresh();
}

async function saveProfile() {
  if (!canSave.value) return;
  pending.value = true;
  try {
    const input = buildInput();
    const saved = profileId.value
      ? await api.machines.update({ ...input, id: profileId.value })
      : await api.machines.create(input);
    toast.success(profileId.value ? t("fleet.inventory.toast.profileUpdated") : t("fleet.inventory.toast.profileCreated"));
    selectedKey.value = machineKey(saved);
    loadForm(saved);
    refreshAll();
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
    profileId.value = "";
    deleteOpen.value = false;
    refreshAll();
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
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.renewalFailed"));
  } finally {
    renewPending.value = false;
  }
}

async function runReminders(selectedOnly = false) {
  remindersPending.value = true;
  try {
    const res = await api.machines.runReminders(selectedOnly ? profileId.value : undefined);
    toast.success(t("fleet.inventory.toast.remindersFired", { count: res.fired.length }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.reminderFailed"));
  } finally {
    remindersPending.value = false;
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
        </div>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('fleet.inventory.stats.machines')" :value="machines.length" :icon="Boxes" />
      <StatCard :label="$t('fleet.inventory.stats.profiled')" :value="profiledCount" :icon="CheckCircle2" tone="success" />
      <StatCard :label="$t('fleet.inventory.stats.needsProfile')" :value="missingCount" :icon="Pencil" :tone="missingCount > 0 ? 'warning' : 'success'" />
      <StatCard :label="$t('fleet.inventory.stats.renewalRisk')" :value="renewalSoonCount" :icon="CalendarClock" :tone="renewalSoonCount > 0 ? 'warning' : 'success'" :hint="$t('fleet.inventory.stats.listedCost', { cost: totalCostLabel })" />
    </div>

    <Card>
      <CardHeader class="pb-3">
        <CardTitle class="flex items-center gap-2 text-base">
          <Boxes class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('fleet.inventory.summary.title') }}
        </CardTitle>
        <CardDescription>{{ $t('fleet.inventory.summary.description') }}</CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-lg border border-border bg-muted/20 p-3">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.summary.coverage') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ profiledCount }} / {{ machines.length }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ vendorSummary || $t('fleet.inventory.summary.noVendors') }}</p>
        </div>
        <div class="rounded-lg border border-border bg-muted/20 p-3">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.summary.billing') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ totalCostLabel }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ $t('fleet.inventory.summary.pricedMachines', { count: pricedCount }) }}</p>
        </div>
        <div class="rounded-lg border border-border bg-muted/20 p-3">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.summary.renewals') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ trackedRenewalCount }} / {{ profiledCount }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ $t('fleet.inventory.summary.remindersEnabled', { count: remindersEnabledCount }) }}</p>
        </div>
        <div class="rounded-lg border border-border bg-muted/20 p-3">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.inventory.summary.operations') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ storedLinkCount }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ regionSummary || $t('fleet.inventory.summary.noRegions') }}</p>
        </div>
      </CardContent>
    </Card>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Server class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('fleet.inventory.list.title') }}
          </CardTitle>
          <CardDescription>{{ $t('fleet.inventory.list.description', { profiled: profiledCount, missing: missingCount }) }}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="machinesQuery.loading.value"
            :error="machinesQuery.error.value"
            :has-data="machinesQuery.data.value !== undefined"
            :is-empty="machines.length === 0"
            :empty-title="$t('fleet.inventory.list.emptyTitle')"
            :empty-description="$t('fleet.inventory.list.emptyDescription')"
            @retry="machinesQuery.refresh"
          >
            <div class="space-y-3">
              <button
                v-for="machine in sortedMachines"
                :key="machineKey(machine)"
                type="button"
                :class="cn(
                  'w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-muted/35',
                  selectedKey === machineKey(machine) && 'border-primary bg-primary/5',
                )"
                @click="selectMachine(machine)"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex min-w-0 items-center gap-2">
                      <StatusDot :online="machine.online" :pulse="machine.online" />
                      <span class="truncate font-medium">{{ displayName(machine) }}</span>
                    </div>
                    <p class="mt-1 font-mono text-xs text-muted-foreground">
                      {{ shortId(machine.node_id, 16) }}
                      <template v-if="machine.host_facts?.hostname"> - {{ machine.host_facts.hostname }}</template>
                    </p>
                  </div>
                  <div class="flex flex-wrap justify-end gap-1.5">
                    <Badge :variant="profileVariant(machine)">{{ profileLabel(machine) }}</Badge>
                    <Badge v-if="machine.vendor" variant="outline">{{ machine.vendor }}</Badge>
                    <Badge :variant="renewalTone(machine) === 'destructive' ? 'destructive' : renewalTone(machine) === 'warning' ? 'warning' : 'secondary'">
                      {{ renewalLabel(machine) }}
                    </Badge>
                  </div>
                </div>

                <div class="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                  <span class="inline-flex items-center gap-1">
                    <DollarSign class="size-3" aria-hidden="true" />
                    {{ formatPrice(machine) }}
                  </span>
                  <span>{{ formatCycle(machine) }}</span>
                  <span>{{ machine.region || $t('fleet.inventory.list.regionUnset') }}</span>
                  <span v-if="machine.updated_at">{{ $t('fleet.inventory.list.updated', { time: formatRelativeTime(machine.updated_at) }) }}</span>
                </div>

                <div class="mt-3 flex flex-wrap gap-1.5">
                  <Badge v-if="machine.has_console_url" variant="info">
                    <Link class="size-3" aria-hidden="true" />
                    {{ $t('fleet.inventory.list.consoleLinkStored') }}
                  </Badge>
                  <Badge v-if="machine.has_detail_url" variant="info">
                    <Link class="size-3" aria-hidden="true" />
                    {{ $t('fleet.inventory.list.detailLinkStored') }}
                  </Badge>
                  <Badge v-if="machine.reminders_enabled" variant="outline">
                    <Bell class="size-3" aria-hidden="true" />
                    {{ $t('fleet.inventory.list.reminders') }}
                  </Badge>
                </div>
                <p v-if="machine.notes" class="mt-2 line-clamp-2 text-xs text-muted-foreground">
                  {{ $t('fleet.inventory.list.notes') }}: {{ machine.notes }}
                </p>
              </button>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Pencil class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('fleet.inventory.profile.title') }}
          </CardTitle>
          <CardDescription>
            <template v-if="selectedMachine">{{ displayName(selectedMachine) }}</template>
            <template v-else>{{ $t('fleet.inventory.profile.selectPrompt') }}</template>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form v-if="selectedMachine && canAdminInventory" class="space-y-4" @submit.prevent="saveProfile">
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
                  <SelectItem
                    v-if="nodeId && !nodes.some((node) => node.id === nodeId)"
                    :value="nodeId"
                  >
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
              <div class="grid gap-2">
                <Label for="machine-price">{{ $t('fleet.inventory.profile.price') }}</Label>
                <Input id="machine-price" v-model="priceMajor" type="number" min="0" step="0.01" placeholder="9.90" />
              </div>
              <div class="grid gap-2">
                <Label for="machine-renewal">{{ $t('fleet.inventory.profile.nextRenewal') }}</Label>
                <Input id="machine-renewal" v-model="nextRenewal" type="date" />
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="machine-cycle">{{ $t('fleet.inventory.profile.renewalCycle') }}</Label>
                <!-- Native select retained: reka-ui Select cannot represent the
                     empty-string "None" reset value without losing the ability
                     to clear the cycle back to undefined. -->
                <select
                  id="machine-cycle"
                  v-model="renewalCycle"
                  class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <option value="">{{ $t('fleet.inventory.profile.cycle.none') }}</option>
                  <option value="monthly">{{ $t('fleet.inventory.profile.cycle.monthly') }}</option>
                  <option value="quarterly">{{ $t('fleet.inventory.profile.cycle.quarterly') }}</option>
                  <option value="semiannual">{{ $t('fleet.inventory.profile.cycle.semiannual') }}</option>
                  <option value="annual">{{ $t('fleet.inventory.profile.cycle.annual') }}</option>
                  <option value="custom_days">{{ $t('fleet.inventory.profile.cycle.customDays') }}</option>
                </select>
              </div>
              <div class="grid gap-2">
                <Label for="machine-cycle-days">{{ $t('fleet.inventory.profile.cycleDays') }}</Label>
                <Input id="machine-cycle-days" v-model="cycleDays" type="number" min="1" :disabled="renewalCycle !== 'custom_days'" />
              </div>
            </div>

            <div class="grid gap-2">
              <Label for="machine-reminders">{{ $t('fleet.inventory.profile.remindersBefore') }}</Label>
              <Input id="machine-reminders" v-model="remindDays" placeholder="14,7,1" />
            </div>

            <div class="grid gap-2">
              <Label for="machine-console">{{ $t('fleet.inventory.profile.consoleUrl') }}</Label>
              <Input id="machine-console" v-model="consoleUrl" :placeholder="$t('fleet.inventory.profile.consoleUrlPlaceholder')" />
              <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <input v-model="clearConsoleUrl" type="checkbox" class="size-4 accent-primary" />
                {{ $t('fleet.inventory.profile.clearConsoleUrl') }}
              </label>
            </div>

            <div class="grid gap-2">
              <Label for="machine-detail">{{ $t('fleet.inventory.profile.detailUrl') }}</Label>
              <Input id="machine-detail" v-model="detailUrl" :placeholder="$t('fleet.inventory.profile.detailUrlPlaceholder')" />
              <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <input v-model="clearDetailUrl" type="checkbox" class="size-4 accent-primary" />
                {{ $t('fleet.inventory.profile.clearDetailUrl') }}
              </label>
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

            <div class="grid gap-2 rounded-md border border-border p-3 text-sm">
              <label class="flex items-center gap-2">
                <input v-model="autoRoll" type="checkbox" class="size-4 accent-primary" />
                {{ $t('fleet.inventory.profile.autoRoll') }}
              </label>
              <label class="flex items-center gap-2">
                <input v-model="remindersEnabled" type="checkbox" class="size-4 accent-primary" />
                {{ $t('fleet.inventory.profile.enableReminders') }}
              </label>
            </div>

            <div class="flex flex-wrap gap-2">
              <Button type="submit" :disabled="pending || !canSave">
                <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
                <Save v-else class="size-4" aria-hidden="true" />
                {{ selectedHasProfile ? $t('fleet.inventory.profile.saveProfile') : $t('fleet.inventory.profile.createProfile') }}
              </Button>
              <Button
                v-if="selectedHasProfile"
                type="button"
                variant="outline"
                :disabled="renewPending || (!autoRoll && !nextRenewal)"
                @click="renewProfile"
              >
                <RefreshCw v-if="renewPending" class="size-4 animate-spin" aria-hidden="true" />
                <CalendarClock v-else class="size-4" aria-hidden="true" />
                {{ $t('fleet.inventory.profile.recordRenewal') }}
              </Button>
              <Button
                v-if="selectedHasProfile"
                type="button"
                variant="outline"
                :disabled="remindersPending"
                @click="runReminders(true)"
              >
                <Bell class="size-4" aria-hidden="true" />
                {{ $t('fleet.inventory.profile.runReminders') }}
              </Button>
              <Button
                v-if="selectedHasProfile"
                type="button"
                variant="destructive"
                :disabled="deletePending"
                @click="deleteProfile"
              >
                <RefreshCw v-if="deletePending" class="size-4 animate-spin" aria-hidden="true" />
                <Trash2 v-else class="size-4" aria-hidden="true" />
                {{ $t('common.actions.delete') }}
              </Button>
            </div>
          </form>

          <EmptyState
            v-else-if="selectedMachine"
            :title="$t('fleet.inventory.profile.readOnlyTitle')"
            :description="$t('fleet.inventory.profile.readOnlyDescription')"
          />
          <EmptyState
            v-else
            :title="$t('fleet.inventory.profile.noSelectionTitle')"
            :description="$t('fleet.inventory.profile.noSelectionDescription')"
          />
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <HardDrive class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.inventory.facts.title') }}
            </CardTitle>
            <CardDescription>
              <template v-if="selectedMachine">{{ selectedMachine.node_name || selectedMachine.node_id }}</template>
              <template v-else>{{ $t('fleet.inventory.facts.description') }}</template>
            </CardDescription>
          </div>
          <Button
            v-if="canAdminInventory"
            variant="outline"
            size="sm"
            :disabled="remindersPending"
            @click="runReminders(false)"
          >
            <RefreshCw v-if="remindersPending" class="size-4 animate-spin" aria-hidden="true" />
            <Bell v-else class="size-4" aria-hidden="true" />
            {{ $t('fleet.inventory.facts.runAllReminders') }}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div v-if="selectedMachine" class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">{{ $t('fleet.inventory.facts.os') }}</p>
            <p class="mt-1 font-medium">{{ selectedMachine.host_facts?.os || selectedMachine.host_facts?.platform || $t('fleet.inventory.facts.unknown') }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ selectedMachine.host_facts?.kernel || selectedMachine.host_facts?.platform_version || "" }}</p>
          </div>
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">{{ $t('fleet.inventory.facts.cpu') }}</p>
            <p class="mt-1 font-medium">{{ $t('fleet.inventory.facts.cpuCores', { value: selectedMachine.host_facts?.cpu_cores || 0 }) }}</p>
            <p class="mt-1 truncate text-xs text-muted-foreground">{{ selectedMachine.host_facts?.cpu_model || $t('fleet.inventory.facts.modelUnknown') }}</p>
          </div>
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">{{ $t('fleet.inventory.facts.memory') }}</p>
            <p class="mt-1 font-medium">{{ formatBytes(selectedMachine.host_facts?.memory_total) }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ selectedMachine.host_facts?.arch || $t('fleet.inventory.facts.archUnknown') }}</p>
          </div>
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">{{ $t('fleet.inventory.facts.renewal') }}</p>
            <p :class="cn('mt-1 font-medium', selectedRenewalTone === 'destructive' && 'text-destructive', selectedRenewalTone === 'warning' && 'text-warning', selectedRenewalTone === 'success' && 'text-success')">
              {{ renewalLabel(selectedMachine) }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">{{ selectedMachine.next_renewal ? formatDateTime(selectedMachine.next_renewal) : $t('fleet.inventory.facts.dateUnset') }}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
