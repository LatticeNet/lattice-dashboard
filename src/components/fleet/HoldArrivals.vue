<script setup lang="ts">
/**
 * The incidents a held list keeps below their place (incidentsModel.arrivals),
 * said on one line that floats on the list's top edge:
 *
 *   ─────────── ( (!) 1 new critical incident, 1 moved up   Show ) ───────────
 *
 * "New" only for incidents new to the operator, "moved up" for ones already
 * open that now sort higher (splitArrivals). It takes no room in the layout,
 * so appearing moves nothing under the pointer the hold is protecting, and it
 * comes before the rows in the DOM, so Tab from the filters or Shift+Tab from
 * the first row reaches it. The caller also moves focus to it on N inside the
 * list. It sits in a polite live region that exists before it appears, so it
 * is announced. Show asks the caller to put the rows in their place, and says
 * whether a key pressed it (a click from Enter or Space has no detail), so the
 * caller scrolls to the row it focuses only then.
 *
 * On a touch screen Show keeps the pill's 24 px look with a 44 px pad that
 * runs down from the pill's top into the list, never above it, so it cannot
 * take taps meant for the control just above the list (New maintenance
 * window, Home's "more incidents"). Below 640 px the pill sits at the list's
 * start, clear of those controls, which sit at the end.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, OctagonAlert } from "lucide-vue-next";

import type { Incident } from "@/lib/api";
import { incidentSeverity } from "@/lib/incidentSeverity";
import { Button } from "@/components/ui/button";

const props = defineProps<{ fresh: readonly Incident[]; moved: readonly Incident[] }>();
const emit = defineEmits<{ show: [byKeyboard: boolean] }>();
const { t } = useI18n();

const criticalCount = (rows: readonly Incident[]) => rows.filter((incident) => incidentSeverity(incident) === "critical").length;
const count = computed(() => props.fresh.length + props.moved.length);
const anyCritical = computed(() => criticalCount(props.fresh) + criticalCount(props.moved) > 0);

const text = computed(() => {
  const n = props.fresh.length;
  const c = criticalCount(props.fresh);
  const m = props.moved.length;
  const fresh = !n
    ? ""
    : c === n
      ? t("fleet.keepalive.arrivals.critical", { n }, n)
      : c > 0
        ? t("fleet.keepalive.arrivals.mixed", { n, c }, n)
        : t("fleet.keepalive.arrivals.plain", { n }, n);
  if (!m) return fresh;
  if (fresh) return t("fleet.keepalive.arrivals.andMoved", { text: fresh, n: m }, m);
  return criticalCount(props.moved) === m ? t("fleet.keepalive.arrivals.movedCritical", { n: m }, m) : t("fleet.keepalive.arrivals.moved", { n: m }, m);
});
</script>

<template>
  <div
    class="pointer-events-none absolute inset-x-0 top-0 z-10 flex -translate-y-1/2 justify-start px-3.5 sm:justify-center sm:px-4"
    aria-live="polite"
    data-testid="hold-arrivals"
  >
    <p
      v-if="count"
      class="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card py-0.5 ps-3 pe-0.5 text-xs text-foreground shadow-sm"
    >
      <component :is="anyCritical ? OctagonAlert : AlertTriangle" :class="['size-3.5 shrink-0', anyCritical ? 'text-destructive' : 'text-warning-text']" aria-hidden="true" />
      <span class="min-w-0 truncate">{{ text }}</span>
      <span class="sr-only">{{ $t('fleet.keepalive.arrivals.hint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="h-6 min-h-0 rounded-full px-2.5 text-xs pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-top-0.5 pointer-coarse:after:h-11 pointer-coarse:after:content-['']"
        aria-keyshortcuts="N"
        :aria-label="$t('fleet.keepalive.arrivals.showLabel')"
        data-hold-arrivals-show
        @click="(event: MouseEvent) => emit('show', event.detail === 0)"
      >
        {{ $t('fleet.keepalive.arrivals.show') }}
      </Button>
    </p>
  </div>
</template>
