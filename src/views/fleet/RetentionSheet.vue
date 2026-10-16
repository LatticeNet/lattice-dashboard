<script setup lang="ts">
/**
 * How long Monitoring keeps five-minute history (design 29 D4), 3 to 14 days
 * by the server's bounds, with the store's measured size and the size the
 * chosen setting projects. Lowering it frees space for reuse inside the
 * store, not on the disk, and the sheet says so before the save. The save is
 * versioned (409 on a stale read) and audited on the server.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Save } from "lucide-vue-next";

import { api, type MonitorSettings } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { toast } from "@/lib/toast";

import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { largeMesh, lowersRetention, projectedBytesAt, retentionBounds, retentionValid } from "./retentionModel";

const props = defineProps<{ open: boolean; settings: MonitorSettings; canAdmin: boolean; shortestIntervalSec?: number }>();
const emit = defineEmits<{ close: []; saved: [settings: MonitorSettings]; reload: [] }>();

const { t } = useI18n();
const days = ref(props.settings.fine_retention_days);
watch(
  () => props.open,
  (open) => {
    if (open) days.value = props.settings.fine_retention_days;
  },
  { immediate: true },
);

const bounds = computed(() => retentionBounds(props.settings));
const valid = computed(() => retentionValid(Number(days.value), props.settings));
const projected = computed(() => projectedBytesAt(props.settings, Number(days.value)));
const dirty = computed(() => Number(days.value) !== props.settings.fine_retention_days);
const lowers = computed(() => lowersRetention(props.settings, Number(days.value)));
const warnLarge = computed(() => largeMesh(props.settings.paths, props.shortestIntervalSec));
const pending = ref(false);

async function save(): Promise<void> {
  if (!valid.value || !dirty.value || !props.canAdmin) return;
  pending.value = true;
  try {
    const next = await api.monitors.settings.update({ version: props.settings.version, fine_retention_days: Number(days.value) });
    toast.success(t("fleet.monitoring.retention.toast.saved", { days: next.fine_retention_days }));
    emit("saved", next);
    emit("close");
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      toast.error(t("fleet.monitoring.retention.toast.conflict"));
      emit("reload");
      emit("close");
    } else {
      toast.error(error instanceof Error ? error.message : t("fleet.monitoring.retention.toast.failed"));
    }
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <ObjectSheet :open="open" :title="$t('fleet.monitoring.retention.title')" :read-only="!canAdmin" @close="emit('close')">
    <form id="retention" class="space-y-5 text-sm" data-testid="retention" @submit.prevent="save">
      <p class="text-muted-foreground">{{ $t('fleet.monitoring.retention.description') }}</p>

      <div class="grid gap-2">
        <Label for="retention-days">{{ $t('fleet.monitoring.retention.days') }}</Label>
        <div class="flex items-center gap-3">
          <input
            id="retention-days"
            v-model.number="days"
            type="range"
            class="w-full accent-[var(--primary)]"
            :min="bounds.min"
            :max="bounds.max"
            step="1"
            :disabled="!canAdmin"
            :aria-valuetext="$t('fleet.monitoring.retention.daysValue', { n: days }, days)"
          />
          <span class="w-20 shrink-0 text-end font-mono font-medium tabular" aria-hidden="true">{{ $t('fleet.monitoring.retention.daysValue', { n: days }, days) }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.retention.range', { min: bounds.min, max: bounds.max }) }}</p>
      </div>

      <dl class="grid grid-cols-2 gap-3 rounded-md border border-border p-3" data-testid="retention-sizes">
        <div>
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.retention.measured') }}</dt>
          <dd class="font-mono font-medium tabular">{{ formatBytes(settings.measured_bytes) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.retention.projected', { n: days }, days) }}</dt>
          <dd class="font-mono font-medium tabular">{{ formatBytes(projected) }}</dd>
        </div>
        <p class="col-span-2 text-xs text-muted-foreground">
          {{ $t('fleet.monitoring.retention.tiers', { paths: settings.paths, coarse: settings.coarse_retention_days, rows: settings.raw_rows_per_path }) }}
        </p>
      </dl>

      <p class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground" :class="lowers && 'text-foreground'" role="note" data-testid="retention-note">
        {{ $t('fleet.monitoring.retention.note') }}
      </p>
      <p v-if="warnLarge" class="rounded-md bg-warning/10 p-2.5 text-xs text-warning-text" role="status">{{ $t('fleet.monitoring.retention.large') }}</p>
    </form>
    <template #actions>
      <Button variant="outline" size="sm" type="button" @click="emit('close')">{{ $t('common.actions.cancel') }}</Button>
      <Button type="submit" form="retention" size="sm" :disabled="pending || !dirty || !valid" data-testid="retention-save">
        <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
        <Save v-else class="size-4" aria-hidden="true" />
        {{ $t('fleet.monitoring.retention.save') }}
      </Button>
    </template>
  </ObjectSheet>
</template>
