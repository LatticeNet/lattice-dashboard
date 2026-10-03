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
import { Undo2, Wrench } from "lucide-vue-next";

import type { MaintenanceWindow } from "@/lib/api";
import { windowCoverage, windowPhase } from "@/views/fleet/incidentsModel";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    windows: MaintenanceWindow[];
    now: number;
    nodeNames?: ReadonlyMap<string, string>;
    groupNames?: ReadonlyMap<string, string>;
    /** Shows End now and Edit; Home leaves them to the Incidents layer. */
    canEdit?: boolean;
    busy?: string | null;
    /** Windows End now just ended, as they were: each keeps a line with Undo in End now's place. */
    ended?: MaintenanceWindow[];
  }>(),
  { nodeNames: () => new Map(), groupNames: () => new Map(), canEdit: false, busy: null, ended: () => [] },
);

const emit = defineEmits<{ end: [window: MaintenanceWindow]; edit: [window: MaintenanceWindow]; undo: [window: MaintenanceWindow] }>();
const { t, locale } = useI18n();

function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date(props.now).toDateString();
  return d.toLocaleString(locale.value, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Each covered name is its own unbreakable piece in the sentence, so a
// narrow banner moves "[cd]-hetzner-hel" to the next line whole instead of
// splitting it at its hyphen; one too long for the line is cut with an ellipsis.
function line(window: MaintenanceWindow, ended: boolean) {
  const coverage = windowCoverage(window, props.nodeNames, props.groupNames);
  const names = [...coverage.nodes, ...coverage.groups.map((g) => t("fleet.keepalive.maintenance.groupName", { name: g }))];
  return { window, ended, shown: names.slice(0, 3), more: Math.max(0, names.length - 3), time: clock(window.ends_at) };
}

const lines = computed(() => [
  ...props.windows.filter((window) => windowPhase(window, props.now) === "active").map((window) => line(window, false)),
  ...(props.canEdit ? props.ended.map((window) => line(window, true)) : []),
]);
</script>

<template>
  <section v-if="lines.length" class="overflow-hidden rounded-lg border border-border bg-card" :aria-label="$t('fleet.keepalive.maintenance.bannerLabel')" data-testid="maintenance-banner">
    <p
      v-for="line in lines"
      :key="line.window.id"
      :data-window-line="line.window.id"
      class="flex flex-col gap-2 border-b border-border px-3.5 py-2 text-sm last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
    >
      <span class="flex min-w-0 flex-1 items-start gap-2.5">
        <Wrench class="mt-0.5 size-4 shrink-0 text-info-text" aria-hidden="true" />
        <i18n-t :keypath="line.ended ? 'fleet.keepalive.maintenance.bannerEnded' : 'fleet.keepalive.maintenance.banner'" tag="span" class="min-w-0 break-words" scope="global">
          <template #name>{{ line.window.name }}</template>
          <template #time>{{ line.time }}</template>
          <template #covers>
            <i18n-t v-if="line.more" keypath="fleet.keepalive.maintenance.andMore" scope="global">
              <template #names><template v-for="(covered, i) in line.shown" :key="i"><template v-if="i">, </template><span class="inline-block max-w-full truncate align-bottom">{{ covered }}</span></template></template>
              <template #n>{{ line.more }}</template>
            </i18n-t>
            <template v-else><template v-for="(covered, i) in line.shown" :key="i"><template v-if="i">, </template><span class="inline-block max-w-full truncate align-bottom">{{ covered }}</span></template></template>
          </template>
        </i18n-t>
      </span>
      <span v-if="canEdit" class="flex shrink-0 gap-1.5 ps-6.5 sm:ps-0">
        <!-- Just ended: Undo takes End now's place, where focus and the pointer already are. -->
        <Button
          v-if="line.ended"
          variant="outline"
          size="sm"
          type="button"
          class="pointer-coarse:h-11"
          :data-window-undo="line.window.id"
          :aria-label="$t('fleet.keepalive.maintenance.undoEnd', { name: line.window.name })"
          @click="emit('undo', line.window)"
        >
          <Undo2 aria-hidden="true" />
          {{ $t('fleet.keepalive.toast.undo') }}
        </Button>
        <!-- aria-disabled while it runs, not disabled: a disabled button drops focus to the page. -->
        <Button
          v-else
          variant="outline"
          size="sm"
          type="button"
          class="pointer-coarse:h-11 aria-disabled:opacity-50"
          :aria-disabled="busy === line.window.id || undefined"
          :data-window-end="line.window.id"
          @click="busy === line.window.id || emit('end', line.window)"
        >
          {{ $t('fleet.keepalive.maintenance.endNow') }}
        </Button>
        <Button variant="ghost" size="sm" type="button" class="pointer-coarse:h-11" @click="emit('edit', line.window)">
          {{ $t('common.actions.edit') }}
        </Button>
      </span>
    </p>
  </section>
</template>
