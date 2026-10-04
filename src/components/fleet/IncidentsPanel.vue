<script setup lang="ts">
/**
 * Home's incidents, first on the page: the active ones, worst first, at most
 * three, with Acknowledge and Snooze on each row, and a link to the
 * Keepalive layer for the rest. Renders nothing while no incident is active,
 * so a quiet fleet keeps Home's attention list on top.
 *
 *   Incidents (2 active)                                           All incidents
 *   (!) sing-box is down on DMIT-4      14m          [Acknowledge] [Snooze] [Open]
 *       Paged 14:02 · not acknowledged
 *
 * While rows are held after an action, an incident that arrives above them
 * would be cut from the three; the title counts it and HoldArrivals names it.
 */
import { computed, nextTick, ref } from "vue";
import { RouterLink } from "vue-router";

import type { Incident } from "@/lib/api";
import { useIncidentActions } from "@/composables/useIncidentActions";
import { HOME_INCIDENTS_MAX, homeIncidents } from "@/views/fleet/incidentsModel";
import HoldArrivals from "@/components/fleet/HoldArrivals.vue";
import IncidentList from "@/components/fleet/IncidentList.vue";

const props = withDefaults(
  defineProps<{
    incidents: Incident[];
    now: number;
    canAdmin: boolean;
    nodeNames?: ReadonlyMap<string, string>;
    monitorNames?: ReadonlyMap<string, string>;
  }>(),
  { nodeNames: () => new Map<string, string>(), monitorNames: () => new Map<string, string>() },
);
const emit = defineEmits<{ refresh: [] }>();

const panel = ref<HTMLElement | null>(null);
const actions = useIncidentActions(() => emit("refresh"), { zone: () => panel.value, rows: () => props.incidents });
const view = computed(() =>
  homeIncidents(props.incidents, props.now, HOME_INCIDENTS_MAX, actions.held.value, { pinned: actions.pinned.value, before: actions.heldRows.value }),
);

async function showArrivals(): Promise<void> {
  const first = view.value.arrived[0]?.id;
  const fromShow = Boolean(document.activeElement?.closest("[data-hold-arrivals-show]"));
  actions.release();
  await nextTick();
  if (first && fromShow) panel.value?.querySelector<HTMLElement>(`[data-incident-row="${CSS.escape(first)}"]`)?.focus();
}

/** N inside the panel reaches Show. */
function onListKey(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== "n" || event.ctrlKey || event.metaKey || event.altKey || !view.value.arrived.length) return;
  const show = panel.value?.querySelector<HTMLElement>("[data-hold-arrivals-show]");
  if (!show) return;
  event.preventDefault();
  show.focus();
}
</script>

<template>
  <section v-if="view.total > 0" class="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="home-incidents" data-testid="home-incidents" ref="panel">
    <header class="flex items-center gap-2 border-b border-border px-3.5 py-2">
      <h2 id="home-incidents" class="text-xs font-medium text-muted-foreground">
        {{
          view.arrived.length
            ? $t('overview.incidents.titleNew', { n: view.total, new: view.arrived.length }, view.total)
            : $t('overview.incidents.title', { n: view.total }, view.total)
        }}
      </h2>
      <RouterLink
        :to="{ name: 'monitoring', query: { view: 'incidents' } }"
        class="ms-auto rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-end"
      >
        {{ view.more > 0 ? $t('overview.incidents.allMore', { n: view.more }, view.more) : $t('overview.incidents.all') }}
      </RouterLink>
    </header>
    <div class="relative" @keydown="onListKey">
      <HoldArrivals :arrived="view.arrived" @show="showArrivals" />
      <IncidentList
        :incidents="view.shown"
        :now="now"
        :can-admin="canAdmin"
        :busy="actions.busy.value"
        :node-names="nodeNames"
        :monitor-names="monitorNames"
        :focus-request="actions.focusRequest.value"
        :undoable="actions.undoable.value"
        :undone="actions.undone.value"
        @ack="actions.ack"
        @undo="actions.undoAck"
        @snooze="actions.snooze"
        @focused="actions.focusDone"
      />
    </div>
  </section>
</template>
