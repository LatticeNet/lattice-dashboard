<script setup lang="ts">
/**
 * Record a machine renewal in one step, from the machine's sheet in
 * Inventory or from its row in Upcoming (r1 review, item 7).
 *
 * Recording means the operator paid the provider for the next cycle, so the
 * date offered is one billing cycle after the date the machine is due now
 * (inventoryEditorModel.renewalDefault), editable. Record stays off until the
 * date is a real day different from the stored one: before this, a machine
 * without auto-roll recorded the date it already had and nothing changed.
 * The server stores the date and re-arms the reminders for it.
 *
 * Upcoming reads the machine on demand, so the dialog has a reading and a
 * failed state; Inventory passes the machine it already holds.
 *
 * The job starts at the provider, so the dialog names the provider and, for
 * a machine with a stored console link, offers the same Console button as
 * the machine's sheet. The link is sealed behind a step-up grant that the
 * host page holds (useMachineLinkReveal), so the dialog only asks for it.
 */
import { computed, ref, useId, watch } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { CalendarClock, ExternalLink, RefreshCw } from "lucide-vue-next";

import { api, type MachineView } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { daysBetween, formatDay, renewalChoice, renewalDefault, rollForwardPast } from "@/views/fleet/inventoryEditorModel";

const props = withDefaults(
  defineProps<{
    open: boolean;
    machine?: MachineView | null;
    /** The machine is being read (Upcoming reads it when the dialog opens). */
    loading?: boolean;
    /** Why the machine could not be read. */
    error?: string | null;
    /** Offer a link to the machine's sheet, from pages other than Inventory. */
    machineLink?: boolean;
    /** Offer the provider's console: the machine stores a console link the viewer may open. */
    consoleLink?: boolean;
    /** The host is revealing a link (a step-up prompt may be open). */
    consolePending?: boolean;
  }>(),
  { machine: null, loading: false, error: null, machineLink: false, consoleLink: false, consolePending: false },
);

const emit = defineEmits<{ "update:open": [open: boolean]; recorded: [machine: MachineView]; openConsole: [] }>();

const { t } = useI18n();
const dateId = useId();

function dayOf(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.toISOString().slice(0, 10);
  return day.startsWith("0001-") ? "" : day;
}

const name = computed(() => (props.machine ? props.machine.label || props.machine.node_name || props.machine.node_id : ""));
const current = computed(() => dayOf(props.machine?.next_renewal));
const cycle = computed(() => props.machine?.renewal_cycle ?? "");
const cycleDays = computed(() => props.machine?.cycle_days ?? 0);
const today = computed(() => formatDay(new Date()));

const cycleLabel = computed(() => {
  if (!cycle.value) return t("fleet.inventory.cycleLabel.noCycle");
  if (cycle.value === "custom_days") return t("fleet.inventory.cycleLabel.customDays", { days: cycleDays.value });
  return t(`fleet.inventory.profile.cycle.${cycle.value}`);
});

const chosen = ref("");
const suggested = computed(() => renewalDefault(current.value, cycle.value, cycleDays.value));

/** A new machine (or the first read landing) starts from one cycle after the current date. */
watch(
  () => [props.open, props.machine?.id, current.value] as const,
  ([open]) => {
    if (open) chosen.value = suggested.value ?? current.value;
  },
  { immediate: true },
);

const choice = computed(() => renewalChoice(current.value, chosen.value));

function daysPhrase(day: string): string {
  const n = daysBetween(today.value, day) ?? 0;
  if (n === 0) return t("fleet.renewal.today");
  return n > 0 ? t("fleet.renewal.inDays", { n }, n) : t("fleet.renewal.daysAgo", { n: -n }, -n);
}

const stillPast = computed(() => choice.value === "ok" && (daysBetween(today.value, chosen.value) ?? 0) < 0);
const rolled = computed(() => (stillPast.value ? rollForwardPast(chosen.value, cycle.value, cycleDays.value, today.value) : undefined));

const pending = ref(false);
const ready = computed(() => !!props.machine?.id && !props.loading && !props.error);
const canRecord = computed(() => ready.value && choice.value === "ok" && !pending.value);

async function record(): Promise<void> {
  const machine = props.machine;
  if (!machine?.id || !canRecord.value) return;
  pending.value = true;
  try {
    const renewed = await api.machines.renew(machine.id, `${chosen.value}T00:00:00Z`);
    toast.success(t("fleet.renewal.recorded", { name: name.value, date: chosen.value }));
    emit("recorded", renewed);
    emit("update:open", false);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.renewal.failed"));
  } finally {
    pending.value = false;
  }
}

/** Focus goes back to the control that opened the dialog. */
let opener: HTMLElement | null = null;
watch(
  () => props.open,
  (open) => {
    if (open && typeof document !== "undefined") opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  },
);
/** The date is what the dialog is for, so it takes focus over the Console button above it. */
function onOpenAutoFocus(event: Event): void {
  const input = typeof document !== "undefined" ? document.getElementById(dateId) : null;
  if (!input) return;
  event.preventDefault();
  input.focus();
}
function onCloseAutoFocus(event: Event): void {
  if (!opener?.isConnected) return;
  event.preventDefault();
  opener.focus();
}

function setOpen(open: boolean): void {
  if (!open && pending.value) return;
  emit("update:open", open);
}
</script>

<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogScrollContent class="w-[calc(100%-2rem)] sm:max-w-md" data-testid="record-renewal" @open-auto-focus="onOpenAutoFocus" @close-auto-focus="onCloseAutoFocus">
      <DialogHeader class="pe-6">
        <DialogTitle>{{ name ? $t('fleet.renewal.title', { name }) : $t('fleet.renewal.action') }}</DialogTitle>
        <DialogDescription>{{ $t('fleet.renewal.description') }}</DialogDescription>
      </DialogHeader>

      <p v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <RefreshCw class="size-4 animate-spin" aria-hidden="true" />
        {{ $t('fleet.renewal.loading') }}
      </p>
      <p v-else-if="error" class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm break-words" role="alert">
        {{ error }}
      </p>

      <form v-else-if="machine" id="record-renewal-form" class="space-y-4" @submit.prevent="record">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt class="text-muted-foreground">{{ $t('fleet.renewal.currentDue') }}</dt>
          <dd class="font-mono tabular">
            <template v-if="current">{{ current }} <span class="font-sans text-muted-foreground">· {{ daysPhrase(current) }}</span></template>
            <template v-else>{{ $t('fleet.renewal.noDate') }}</template>
          </dd>
          <dt class="text-muted-foreground">{{ $t('fleet.renewal.cycle') }}</dt>
          <dd>{{ cycleLabel }}</dd>
          <template v-if="machine.vendor || consoleLink">
            <dt class="text-muted-foreground" :class="consoleLink && 'self-center'">{{ $t('fleet.renewal.provider') }}</dt>
            <dd class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span v-if="machine.vendor" class="break-words">{{ machine.vendor }}</span>
              <Button
                v-if="consoleLink"
                type="button"
                variant="outline"
                size="sm"
                :disabled="consolePending"
                data-testid="record-renewal-console"
                @click="emit('openConsole')"
              >
                <RefreshCw v-if="consolePending" class="size-3.5 animate-spin" aria-hidden="true" />
                <ExternalLink v-else class="size-3.5" aria-hidden="true" />
                {{ $t('fleet.inventory.list.openConsole') }}
              </Button>
            </dd>
          </template>
        </dl>
        <p v-if="machine.auto_roll" class="text-xs text-muted-foreground">{{ $t('fleet.renewal.autoRoll') }}</p>

        <div class="grid gap-2">
          <Label :for="dateId">{{ $t('fleet.renewal.nextRenewal') }}</Label>
          <div class="relative w-full sm:w-56">
            <CalendarClock class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input :id="dateId" v-model="chosen" type="date" class="pl-9" data-testid="record-renewal-date" />
          </div>
          <p class="text-xs text-muted-foreground" data-testid="record-renewal-preview" aria-live="polite">
            <template v-if="choice === 'invalid'">{{ $t('fleet.renewal.invalid') }}</template>
            <template v-else-if="choice === 'unchanged'">{{ suggested ? $t('fleet.renewal.unchanged', { date: current }) : $t('fleet.renewal.noCycle') }}</template>
            <template v-else-if="stillPast">{{ $t('fleet.renewal.past', { date: chosen }) }}</template>
            <template v-else>{{ $t('fleet.renewal.moves', { from: current || $t('fleet.renewal.noDate'), to: chosen, days: daysPhrase(chosen) }) }}</template>
          </p>
          <Button v-if="rolled" type="button" variant="outline" size="sm" class="justify-self-start" @click="chosen = rolled">
            {{ $t('fleet.renewal.useRolled', { date: rolled }) }}
          </Button>
        </div>
      </form>

      <DialogFooter class="gap-2 sm:items-center">
        <Button v-if="machineLink && machine?.id" as-child variant="ghost" class="sm:me-auto">
          <RouterLink :to="{ name: 'inventory', query: { open: machine.id } }">{{ $t('fleet.renewal.openMachine') }}</RouterLink>
        </Button>
        <Button type="button" variant="outline" :disabled="pending" @click="setOpen(false)">
          {{ $t('common.actions.cancel') }}
        </Button>
        <Button type="submit" form="record-renewal-form" :disabled="!canRecord" data-testid="record-renewal-submit">
          <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
          <CalendarClock v-else class="size-4" aria-hidden="true" />
          {{ $t('fleet.renewal.record') }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
