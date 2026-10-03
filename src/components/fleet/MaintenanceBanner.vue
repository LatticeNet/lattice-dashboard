<script setup lang="ts">
/**
 * One line per active maintenance window, above Home and the Keepalive
 * layer: which window, what it covers, until when, and that notifications
 * for those nodes are held. Renders nothing when no window is active.
 *
 *   [wrench] Maintenance "kernel upgrade" on vultr-sg, edge until 15:00: notifications held   [End now] [Edit]
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Wrench } from "lucide-vue-next";

import type { MaintenanceWindow } from "@/lib/api";
import { windowCoverage, windowPhase } from "@/views/fleet/incidentsModel";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    windows: MaintenanceWindow[];
    now: number;
    nodeNames?: ReadonlyMap<string, string>;
    groupNames?: ReadonlyMap<string, string>;
    /** Shows End now and Edit; Home leaves them to the Keepalive layer. */
    canEdit?: boolean;
    busy?: string | null;
  }>(),
  { nodeNames: () => new Map(), groupNames: () => new Map(), canEdit: false, busy: null },
);

const emit = defineEmits<{ end: [window: MaintenanceWindow]; edit: [window: MaintenanceWindow] }>();
const { t, locale } = useI18n();

function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date(props.now).toDateString();
  return d.toLocaleString(locale.value, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const lines = computed(() =>
  props.windows
    .filter((window) => windowPhase(window, props.now) === "active")
    .map((window) => {
      const coverage = windowCoverage(window, props.nodeNames, props.groupNames);
      const names = [...coverage.nodes, ...coverage.groups.map((g) => t("fleet.keepalive.maintenance.groupName", { name: g }))];
      const shown = names.slice(0, 3).join(", ");
      const covers = names.length > 3 ? t("fleet.keepalive.maintenance.andMore", { names: shown, n: names.length - 3 }) : shown;
      return { window, text: t("fleet.keepalive.maintenance.banner", { name: window.name, covers, time: clock(window.ends_at) }) };
    }),
);
</script>

<template>
  <section v-if="lines.length" class="overflow-hidden rounded-lg border border-border bg-card" :aria-label="$t('fleet.keepalive.maintenance.bannerLabel')" data-testid="maintenance-banner">
    <p
      v-for="line in lines"
      :key="line.window.id"
      class="flex flex-col gap-2 border-b border-border px-3.5 py-2 text-sm last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
    >
      <span class="flex min-w-0 flex-1 items-start gap-2.5">
        <Wrench class="mt-0.5 size-4 shrink-0 text-info-text" aria-hidden="true" />
        <span class="min-w-0 break-words">{{ line.text }}</span>
      </span>
      <span v-if="canEdit" class="flex shrink-0 gap-1.5 ps-6.5 sm:ps-0">
        <Button variant="outline" size="sm" type="button" class="pointer-coarse:h-11" :disabled="busy === line.window.id" @click="emit('end', line.window)">
          {{ $t('fleet.keepalive.maintenance.endNow') }}
        </Button>
        <Button variant="ghost" size="sm" type="button" class="pointer-coarse:h-11" @click="emit('edit', line.window)">
          {{ $t('common.actions.edit') }}
        </Button>
      </span>
    </p>
  </section>
</template>
