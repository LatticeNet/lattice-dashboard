<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ExpiringItem, ExpiringResponse } from "@/lib/api";
import { formatAge } from "@/lib/format";
import { formatTotals, sumTotals } from "@/views/fleet/upcomingModel";

/**
 * The list's proof line: when the server built it, how many rows are shown,
 * and what they cost per currency (`generated 12s ago · 20 items · USD 123.45`).
 * The totals are summed from the rows on screen, which by contract equals the
 * server's `totals` for an unfiltered list and stays true under a filter.
 */
const props = defineProps<{
  data?: ExpiringResponse;
  items?: ExpiringItem[];
  now: number;
}>();

const { t, locale } = useI18n();

const line = computed(() => {
  const data = props.data;
  if (!data) return "";
  const rows = props.items ?? data.items;
  const generated = Date.parse(data.generated_at);
  const totals = sumTotals(rows);
  return [
    Number.isNaN(generated) ? "" : t("fleet.upcoming.proof.generated", { age: formatAge(props.now - generated, locale.value) }),
    t("fleet.upcoming.proof.within", { days: data.within_days }),
    t("fleet.upcoming.proof.items", { n: rows.length }, rows.length),
    rows.length === 0 ? "" : totals.length ? formatTotals(totals) : t("fleet.upcoming.proof.noPrices"),
  ]
    .filter(Boolean)
    .join(" · ");
});
</script>

<template>
  <p v-if="line" class="font-mono text-xs tabular text-muted-foreground" data-testid="upcoming-proof">{{ line }}</p>
</template>
