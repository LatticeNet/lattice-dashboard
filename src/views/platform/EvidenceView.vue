<script setup lang="ts">
/**
 * Evidence: what the nodes actually did, in three layers (design 22,
 * section 7).
 *
 * Overview says what is being collected, because nothing else on the page
 * means anything without it, and offers the one action that changes it: a
 * time-boxed capture. Explore asks one question of what was collected, with
 * a lens for connection records and one for the raw log lines they were
 * assembled from. Collection holds the per-node policy, the capture history
 * and the raw log sources, the settings an operator changes rarely.
 *
 * One tab row, mirrored in `?view=`. Old links (vpn-core's node and line
 * links, the retired Logs and Trace routes, the old inner tab) resolve
 * through evidenceModel and are rewritten once to their canonical spelling.
 *
 * The head is the shared chassis: the ProofLine under the title and the
 * LayerTabs row (design 23, sections 3.1 and 3.4). The layer model stays
 * Evidence's own, because its old links name layers by other names.
 */
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CircleSlash, RefreshCw } from "lucide-vue-next";

import PageHeader from "@/components/common/PageHeader.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import { proofReason, type ProofState } from "@/components/common/proofModel";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { cn } from "@/lib/utils";

import EvidenceCollection from "./EvidenceCollection.vue";
import EvidenceExplore from "./EvidenceExplore.vue";
import EvidenceOverview from "./EvidenceOverview.vue";
import { provideEvidenceContext } from "./evidenceContext";
import {
  EVIDENCE_LAYERS,
  evidenceQueryEqual,
  normalizeEvidenceQuery,
  resolveEvidenceLayer,
  writeEvidenceLayer,
  type EvidenceLayer,
} from "./evidenceModel";

const { t } = useI18n();
// Reads and writes go through the page's own route: while Evidence is
// leaving, the router already points at the next page, whose query this
// normaliser must neither read nor rewrite.
const owned = useOwnedRoute();
const ctx = provideEvidenceContext();

// Rewrite an old or partial link to its canonical spelling once, in place,
// so the address bar an operator copies is the one this page writes.
watch(
  () => owned.query(),
  (query) => {
    if (!owned.owns()) return;
    const normalized = normalizeEvidenceQuery(query);
    if (!evidenceQueryEqual(query, normalized)) owned.replace(normalized);
  },
  { immediate: true },
);

const layer = computed<EvidenceLayer>({
  get: () => resolveEvidenceLayer(owned.query()),
  set: (next) => {
    const query = writeEvidenceLayer(owned.query(), next);
    if (!evidenceQueryEqual(query, owned.query())) owned.push(query);
  },
});

const refreshing = computed(
  () => ctx.lastHour.refreshing.value || ctx.policies.refreshing.value || ctx.sessions.refreshing.value,
);

const layerTabs = computed<LayerTab<EvidenceLayer>[]>(() =>
  EVIDENCE_LAYERS.map((name) => ({ value: name, label: t(`platform.evidence.layer.${name}`) })),
);

/** The reads the proof line speaks for. */
const proofSources = [ctx.stats, ctx.lastHour, ctx.policies];

/**
 * The proof line's state. Evidence reads three things and says, per segment,
 * which of them it could not read; so one failed read is a stale line (the
 * rest still stand, the failure is named), and only all three failing with
 * nothing read is a failed line with no counts at all.
 */
const proofState = computed<ProofState>(() => {
  if (!ctx.storeReady.value) return "idle";
  const settled = proofSources.filter((query) => query.data.value !== undefined || !!query.error.value);
  if (settled.length === 0) return "loading";
  const withData = proofSources.filter((query) => query.data.value !== undefined);
  const failing = proofSources.some((query) => !!query.error.value);
  if (withData.length === 0 && failing) return "failed";
  if (failing) return "stale";
  if (proofSources.some((query) => query.refreshing.value)) return "refreshing";
  return "observed";
});

const proofObservedAt = computed(() => {
  const times = proofSources.map((query) => query.lastUpdated.value).filter((ms): ms is number => ms !== undefined);
  return times.length ? Math.min(...times) : null;
});

const proofError = computed(() => {
  const failing = proofSources.find((query) => query.error.value);
  return failing ? proofReason(failing.error.value) : null;
});

/**
 * The proof line: what the store holds, whether it is encrypted, its cap, and
 * how many nodes collect. Each fragment appears only when it was read; an
 * unread count is said to be unread, never printed as zero.
 */
const proofSegments = computed<ProofSegment[]>(() => {
  if (!ctx.storeReady.value) return [{ key: "store-off", text: t("platform.evidence.proof.storeOff") }];
  const proof = ctx.storeProof.value;
  const statsSettled = ctx.stats.data.value !== undefined || !!ctx.stats.error.value;
  const hourSettled = ctx.lastHour.data.value !== undefined || !!ctx.lastHour.error.value;

  const parts: ProofSegment[] = [];
  if (proof.records !== undefined) {
    parts.push({ key: "records", text: t("platform.evidence.proof.records", { count: proof.records }, proof.records) });
  } else if (statsSettled && hourSettled) {
    parts.push({ key: "records", text: t("platform.evidence.proof.recordsUnread") });
  }
  if (proof.encrypted !== undefined) {
    parts.push({ key: "encrypted", text: proof.encrypted ? t("platform.evidence.proof.encrypted") : t("platform.evidence.proof.plaintext") });
  }
  if (proof.capBytes) parts.push({ key: "cap", text: t("platform.evidence.proof.cap", { size: formatBytes(proof.capBytes, 0) }) });
  // A collecting count over a policy list that was never read would be a
  // confident zero; it is said to be unread instead.
  if (proof.total !== undefined) {
    parts.push({
      key: "collecting",
      text: t("platform.evidence.proof.collecting", { collecting: proof.collecting, total: proof.total }, proof.total),
    });
  } else if (ctx.policies.error.value) {
    parts.push({ key: "collecting", text: t("platform.evidence.proof.collectingUnread") });
  }
  return parts;
});
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('platform.evidence.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('platform.evidence.description') }}</p>
        <ProofLine
          v-if="ctx.canRead.value"
          :state="proofState"
          :observed-at="proofObservedAt"
          :error="proofError"
          :segments="proofSegments"
          data-testid="evidence-proof-line"
          @retry="ctx.refreshAll"
        />
      </template>
      <template v-if="ctx.canRead.value" #actions>
        <Button variant="outline" size="sm" :disabled="refreshing" @click="ctx.refreshAll">
          <RefreshCw aria-hidden="true" :class="cn('size-4', refreshing && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Permission denied: one quiet panel, no half-working controls. -->
    <EmptyState
      v-if="!ctx.canRead.value"
      :icon="CircleSlash"
      :title="$t('platform.trace.scopeRequiredTitle')"
      :description="$t('platform.trace.scopeRequiredDescription', { scope: 'log:read' })"
    />

    <template v-else>
      <!-- The one layer row. At phone width it scrolls sideways inside its own
           strip rather than squeezing the labels. -->
      <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('platform.evidence.layersLabel')" />

      <EvidenceOverview v-if="layer === 'overview'" />
      <EvidenceExplore v-else-if="layer === 'explore'" />
      <EvidenceCollection v-else />
    </template>
  </div>
</template>
