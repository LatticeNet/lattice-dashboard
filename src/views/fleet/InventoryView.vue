<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import {
  Bell,
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

type RenewalTone = "default" | "success" | "warning" | "destructive";

const auth = useAuthStore();

const machinesQuery = useAsyncData(() => api.machines.list().then((r) => unwrap(r, "machines")), {
  pollInterval: 12000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const selectedKey = ref("");
const pending = ref(false);
const deletePending = ref(false);
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
  if (currencies.size > 1) return "mixed";
  return formatMoney(totalCostCents.value, totalCostCurrency.value);
});
const canSave = computed(() => !!nodeId.value && canAdminInventory.value);
const selectedHasProfile = computed(() => !!profileId.value);
const selectedRenewalTone = computed<RenewalTone>(() => renewalTone(selectedMachine.value));

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

function machineKey(machine: MachineView): string {
  return machine.id || `node:${machine.node_id}`;
}

function displayName(machine: MachineView): string {
  return machine.label || machine.node_name || machine.node_id;
}

function profileLabel(machine: MachineView): string {
  if (machine.id) return "profiled";
  return "needs profile";
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
  if (!machine?.next_renewal) return "not tracked";
  const days = machine.days_until_renewal;
  if (days === undefined) return formatDate(machine.next_renewal);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  return `${days}d left`;
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
  if (!machine.price_cents) return "not priced";
  return formatMoney(machine.price_cents, machine.currency || "USD");
}

function formatCycle(machine: MachineView): string {
  if (!machine.renewal_cycle) return "no cycle";
  if (machine.renewal_cycle === "custom_days") return `${machine.cycle_days || 0} days`;
  return machine.renewal_cycle;
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
    toast.success(profileId.value ? "Machine profile updated" : "Machine profile created");
    selectedKey.value = machineKey(saved);
    loadForm(saved);
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Inventory save failed");
  } finally {
    pending.value = false;
  }
}

async function deleteProfile() {
  if (!profileId.value) return;
  const ok = window.confirm(`Delete machine profile for ${displayName(selectedMachine.value as MachineView)}?`);
  if (!ok) return;
  deletePending.value = true;
  try {
    await api.machines.delete(profileId.value);
    toast.success("Machine profile deleted");
    profileId.value = "";
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Delete failed");
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
    toast.success("Renewal recorded");
    loadForm(renewed);
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Renewal update failed");
  } finally {
    renewPending.value = false;
  }
}

async function runReminders(selectedOnly = false) {
  remindersPending.value = true;
  try {
    const res = await api.machines.runReminders(selectedOnly ? profileId.value : undefined);
    toast.success(`${res.fired.length} reminder${res.fired.length === 1 ? "" : "s"} fired`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Reminder run failed");
  } finally {
    remindersPending.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Inventory" description="Machine profiles, cost metadata, and renewal reminders">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="machinesQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', machinesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Machines" :value="machines.length" :icon="Boxes" />
      <StatCard label="Profiled" :value="profiledCount" :icon="CheckCircle2" tone="success" />
      <StatCard label="Needs Profile" :value="missingCount" :icon="Pencil" :tone="missingCount > 0 ? 'warning' : 'success'" />
      <StatCard label="Renewal Risk" :value="renewalSoonCount" :icon="CalendarClock" :tone="renewalSoonCount > 0 ? 'warning' : 'success'" :hint="`listed cost ${totalCostLabel}`" />
    </div>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Server class="size-4 text-muted-foreground" aria-hidden="true" />
            Machines
          </CardTitle>
          <CardDescription>{{ profiledCount }} profiles, {{ missingCount }} visible nodes without metadata</CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="machinesQuery.loading.value"
            :error="machinesQuery.error.value"
            :is-empty="machines.length === 0"
            empty-title="No inventory-visible nodes"
            empty-description="Nodes appear here when your token has inventory:read for them."
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
                  <span>{{ machine.region || "region unset" }}</span>
                  <span v-if="machine.updated_at">updated {{ formatRelativeTime(machine.updated_at) }}</span>
                </div>

                <div class="mt-3 flex flex-wrap gap-1.5">
                  <Badge v-if="machine.has_console_url" variant="info">
                    <Link class="size-3" aria-hidden="true" />
                    console link stored
                  </Badge>
                  <Badge v-if="machine.has_detail_url" variant="info">
                    <Link class="size-3" aria-hidden="true" />
                    detail link stored
                  </Badge>
                  <Badge v-if="machine.reminders_enabled" variant="outline">
                    <Bell class="size-3" aria-hidden="true" />
                    reminders
                  </Badge>
                </div>
              </button>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Pencil class="size-4 text-muted-foreground" aria-hidden="true" />
            Machine Profile
          </CardTitle>
          <CardDescription>
            <template v-if="selectedMachine">{{ displayName(selectedMachine) }}</template>
            <template v-else>Select a machine to edit inventory metadata</template>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form v-if="selectedMachine && canAdminInventory" class="space-y-4" @submit.prevent="saveProfile">
            <div class="grid gap-2">
              <Label for="machine-node">Node</Label>
              <select
                id="machine-node"
                v-model="nodeId"
                class="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name || node.id }}
                </option>
                <option v-if="nodeId && !nodes.some((node) => node.id === nodeId)" :value="nodeId">
                  {{ nodeId }}
                </option>
              </select>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="machine-label">Label</Label>
                <Input id="machine-label" v-model="label" placeholder="gmami-jp1" />
              </div>
              <div class="grid gap-2">
                <Label for="machine-vendor">Vendor</Label>
                <Input id="machine-vendor" v-model="vendor" placeholder="DMIT" />
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="machine-region">Region</Label>
                <Input id="machine-region" v-model="region" placeholder="JP-Tokyo" />
              </div>
              <div class="grid gap-2">
                <Label for="machine-currency">Currency</Label>
                <Input id="machine-currency" v-model="currency" maxlength="3" placeholder="USD" />
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="machine-price">Price</Label>
                <Input id="machine-price" v-model="priceMajor" type="number" min="0" step="0.01" placeholder="9.90" />
              </div>
              <div class="grid gap-2">
                <Label for="machine-renewal">Next renewal</Label>
                <Input id="machine-renewal" v-model="nextRenewal" type="date" />
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="machine-cycle">Renewal cycle</Label>
                <select
                  id="machine-cycle"
                  v-model="renewalCycle"
                  class="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">None</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="semiannual">Semiannual</option>
                  <option value="annual">Annual</option>
                  <option value="custom_days">Custom days</option>
                </select>
              </div>
              <div class="grid gap-2">
                <Label for="machine-cycle-days">Cycle days</Label>
                <Input id="machine-cycle-days" v-model="cycleDays" type="number" min="1" :disabled="renewalCycle !== 'custom_days'" />
              </div>
            </div>

            <div class="grid gap-2">
              <Label for="machine-reminders">Reminder days before</Label>
              <Input id="machine-reminders" v-model="remindDays" placeholder="14,7,1" />
            </div>

            <div class="grid gap-2">
              <Label for="machine-console">Console URL</Label>
              <Input id="machine-console" v-model="consoleUrl" placeholder="blank keeps existing write-only link" />
              <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <input v-model="clearConsoleUrl" type="checkbox" class="size-4 accent-primary" />
                Clear stored console URL
              </label>
            </div>

            <div class="grid gap-2">
              <Label for="machine-detail">Detail URL</Label>
              <Input id="machine-detail" v-model="detailUrl" placeholder="blank keeps existing write-only link" />
              <label class="flex items-center gap-2 text-xs text-muted-foreground">
                <input v-model="clearDetailUrl" type="checkbox" class="size-4 accent-primary" />
                Clear stored detail URL
              </label>
            </div>

            <div class="grid gap-2">
              <Label for="machine-notes">Notes</Label>
              <textarea
                id="machine-notes"
                v-model="notes"
                class="min-h-24 rounded-md border border-input bg-background p-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                placeholder="Billing account, plan, support notes"
              />
            </div>

            <div class="grid gap-2 rounded-md border border-border p-3 text-sm">
              <label class="flex items-center gap-2">
                <input v-model="autoRoll" type="checkbox" class="size-4 accent-primary" />
                Auto-roll next renewal when recording a renewal
              </label>
              <label class="flex items-center gap-2">
                <input v-model="remindersEnabled" type="checkbox" class="size-4 accent-primary" />
                Enable renewal reminders
              </label>
            </div>

            <div class="flex flex-wrap gap-2">
              <Button type="submit" :disabled="pending || !canSave">
                <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
                <Save v-else class="size-4" aria-hidden="true" />
                {{ selectedHasProfile ? "Save profile" : "Create profile" }}
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
                Record renewal
              </Button>
              <Button
                v-if="selectedHasProfile"
                type="button"
                variant="outline"
                :disabled="remindersPending"
                @click="runReminders(true)"
              >
                <Bell class="size-4" aria-hidden="true" />
                Run reminders
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
                Delete
              </Button>
            </div>
          </form>

          <EmptyState
            v-else-if="selectedMachine"
            title="Read-only access"
            description="Your token can inspect inventory, but inventory:admin is required to edit machine profiles."
          />
          <EmptyState
            v-else
            title="No machine selected"
            description="Choose a visible node or machine profile from the inventory list."
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
              Selected Machine Facts
            </CardTitle>
            <CardDescription>
              <template v-if="selectedMachine">{{ selectedMachine.node_name || selectedMachine.node_id }}</template>
              <template v-else>Host facts are reported by the node agent</template>
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
            Run all reminders
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div v-if="selectedMachine" class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">OS</p>
            <p class="mt-1 font-medium">{{ selectedMachine.host_facts?.os || selectedMachine.host_facts?.platform || "unknown" }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ selectedMachine.host_facts?.kernel || selectedMachine.host_facts?.platform_version || "" }}</p>
          </div>
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">CPU</p>
            <p class="mt-1 font-medium">{{ selectedMachine.host_facts?.cpu_cores || 0 }} cores</p>
            <p class="mt-1 truncate text-xs text-muted-foreground">{{ selectedMachine.host_facts?.cpu_model || "model unknown" }}</p>
          </div>
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">Memory</p>
            <p class="mt-1 font-medium">{{ formatBytes(selectedMachine.host_facts?.memory_total) }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ selectedMachine.host_facts?.arch || "arch unknown" }}</p>
          </div>
          <div class="rounded-lg border border-border p-4">
            <p class="text-sm text-muted-foreground">Renewal</p>
            <p :class="cn('mt-1 font-medium', selectedRenewalTone === 'destructive' && 'text-destructive', selectedRenewalTone === 'warning' && 'text-warning', selectedRenewalTone === 'success' && 'text-success')">
              {{ renewalLabel(selectedMachine) }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">{{ selectedMachine.next_renewal ? formatDateTime(selectedMachine.next_renewal) : "date unset" }}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
