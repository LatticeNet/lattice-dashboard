<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ExpiringItem, ExpiringResponse } from "@/lib/api";
import type { AsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import { formatTotals, sumTotals } from "@/views/fleet/upcomingModel";

/**
 * The list's proof line, on the shared ProofLine: when the server built the
 * list, the window, how many rows are shown, and what they cost per currency
 * (`observed 12s ago · next 30 days · 20 items · USD 123.45`). The totals are
 * summed from the rows on screen, which by contract equals the server's
 * `totals` for an unfiltered list and stays true under a filter.
 *
 * The age is the server's `generated_at`, the moment the list was computed.
 * Before the first answer the line is absent: the body below says loading or
 * failed with its own retry, and a second retry here would repeat it.
 */
const props = defineProps<{
  query: AsyncData<ExpiringResponse>;
  items?: ExpiringItem[];
}>();

const { t } = useI18n();
const proof = useProof(props.query);

const observedAt = computed(() => {
  const generated = Date.parse(props.query.data.value?.generated_at ?? "");
  return Number.isNaN(generated) ? proof.value.observedAt : generated;
});

const segments = computed<ProofSegment[]>(() => {
  const data = props.query.data.value;
  if (!data) return [];
  const rows = props.items ?? data.items;
  const totals = sumTotals(rows);
  const out: ProofSegment[] = [
    { key: "within", text: t("fleet.upcoming.proof.within", { days: data.within_days }) },
    { key: "items", text: t("fleet.upcoming.proof.items", { n: rows.length }, rows.length) },
  ];
  if (rows.length > 0) {
    out.push({ key: "totals", text: totals.length ? formatTotals(totals) : t("fleet.upcoming.proof.noPrices") });
  }
  return out;
});
</script>

<template>
  <ProofLine
    v-if="query.data.value"
    v-bind="proof"
    :observed-at="observedAt"
    :segments="segments"
    data-testid="upcoming-proof"
    @retry="query.refresh"
  />
</template>
