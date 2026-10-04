<script setup lang="ts">
/**
 * The incidents a held list keeps below their place (incidentsModel.arrivals),
 * said on one line that floats on the list's top edge:
 *
 *   ─────────── ( (!) 1 new critical incident   Show ) ───────────
 *
 * It takes no room in the layout, so appearing moves nothing under the
 * pointer the hold is protecting, and it comes before the rows in the DOM,
 * so Tab from the filters or Shift+Tab from the first row reaches it. The
 * caller also moves focus to it on N inside the list. On a touch screen
 * Show keeps the pill's 24 px look and gets a 44 px pad (.touch-target), so
 * the pill covers no more of the first row than at 1440. It sits in a polite
 * live region that exists before it appears, so it is announced. Show asks
 * the caller to release the hold, which puts every row in its place.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, OctagonAlert } from "lucide-vue-next";

import type { Incident } from "@/lib/api";
import { incidentSeverity } from "@/lib/incidentSeverity";
import { Button } from "@/components/ui/button";

const props = defineProps<{ arrived: readonly Incident[] }>();
const emit = defineEmits<{ show: [] }>();
const { t } = useI18n();

const critical = computed(() => props.arrived.filter((incident) => incidentSeverity(incident) === "critical").length);
const text = computed(() => {
  const n = props.arrived.length;
  if (critical.value === n) return t("fleet.keepalive.arrivals.critical", { n }, n);
  if (critical.value > 0) return t("fleet.keepalive.arrivals.mixed", { n, c: critical.value }, n);
  return t("fleet.keepalive.arrivals.plain", { n }, n);
});
</script>

<template>
  <div class="pointer-events-none absolute inset-x-0 top-0 z-10 flex -translate-y-1/2 justify-center px-4" aria-live="polite" data-testid="hold-arrivals">
    <p
      v-if="arrived.length"
      class="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card py-0.5 ps-3 pe-0.5 text-xs text-foreground shadow-sm"
    >
      <component :is="critical ? OctagonAlert : AlertTriangle" :class="['size-3.5 shrink-0', critical ? 'text-destructive' : 'text-warning-text']" aria-hidden="true" />
      <span class="min-w-0 truncate">{{ text }}</span>
      <span class="sr-only">{{ $t('fleet.keepalive.arrivals.hint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="touch-target h-6 min-h-0 rounded-full px-2.5 text-xs"
        aria-keyshortcuts="N"
        :aria-label="$t('fleet.keepalive.arrivals.showLabel')"
        data-hold-arrivals-show
        @click="emit('show')"
      >
        {{ $t('fleet.keepalive.arrivals.show') }}
      </Button>
    </p>
  </div>
</template>
