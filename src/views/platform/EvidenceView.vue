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
 */
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { CircleSlash, RefreshCw } from "lucide-vue-next";

import PageHeader from "@/components/common/PageHeader.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBytes } from "@/lib/format";
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
const route = useRoute();
const router = useRouter();
const ctx = provideEvidenceContext();

// Rewrite an old or partial link to its canonical spelling once, in place,
// so the address bar an operator copies is the one this page writes.
watch(
  () => route.query,
  (query) => {
    const normalized = normalizeEvidenceQuery(query);
    if (!evidenceQueryEqual(query, normalized)) router.replace({ query: normalized }).catch(() => {});
  },
  { immediate: true },
);

const layer = computed<EvidenceLayer>({
  get: () => resolveEvidenceLayer(route.query),
  set: (next) => {
    const query = writeEvidenceLayer(route.query, next);
    if (!evidenceQueryEqual(query, route.query)) router.push({ query }).catch(() => {});
  },
});

const refreshing = computed(
  () => ctx.lastHour.refreshing.value || ctx.policies.refreshing.value || ctx.sessions.refreshing.value,
);

/**
 * The proof line: what the store holds, whether it is encrypted, its cap, and
 * how many nodes collect. Each fragment appears only when it was read; an
 * unread count is said to be unread, never printed as zero.
 */
const proofLine = computed(() => {
  if (!ctx.storeReady.value) return t("platform.evidence.proof.storeOff");
  const proof = ctx.storeProof.value;
  const statsSettled = ctx.stats.data.value !== undefined || !!ctx.stats.error.value;
  const hourSettled = ctx.lastHour.data.value !== undefined || !!ctx.lastHour.error.value;
  const policiesSettled = ctx.policies.data.value !== undefined || !!ctx.policies.error.value;
  if (!statsSettled && !hourSettled && !policiesSettled) return t("platform.evidence.proof.reading");

  const parts: string[] = [];
  if (proof.records !== undefined) {
    parts.push(t("platform.evidence.proof.records", { count: proof.records }, proof.records));
  } else if (statsSettled && hourSettled) {
    parts.push(t("platform.evidence.proof.recordsUnread"));
  }
  if (proof.encrypted !== undefined) {
    parts.push(proof.encrypted ? t("platform.evidence.proof.encrypted") : t("platform.evidence.proof.plaintext"));
  }
  if (proof.capBytes) parts.push(t("platform.evidence.proof.cap", { size: formatBytes(proof.capBytes, 0) }));
  // A collecting count over a policy list that was never read would be a
  // confident zero; it is said to be unread instead.
  if (proof.total !== undefined) {
    parts.push(t("platform.evidence.proof.collecting", { collecting: proof.collecting, total: proof.total }, proof.total));
  } else if (ctx.policies.error.value) {
    parts.push(t("platform.evidence.proof.collectingUnread"));
  }
  return parts.join(" · ");
});
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('platform.evidence.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('platform.evidence.description') }}</p>
        <p
          v-if="ctx.canRead.value"
          class="font-mono text-xs tabular text-muted-foreground"
          data-testid="evidence-proof-line"
        >
          {{ proofLine }}
        </p>
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
      <!-- The one tab row. At phone width it scrolls sideways inside its own
           strip rather than squeezing the labels. -->
      <Tabs v-model="layer">
        <div class="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList :aria-label="$t('platform.evidence.layersLabel')">
            <TabsTrigger v-for="name in EVIDENCE_LAYERS" :key="name" :value="name" class="px-3">
              {{ $t(`platform.evidence.layer.${name}`) }}
            </TabsTrigger>
          </TabsList>
        </div>
      </Tabs>

      <EvidenceOverview v-if="layer === 'overview'" />
      <EvidenceExplore v-else-if="layer === 'explore'" />
      <EvidenceCollection v-else />
    </template>
  </div>
</template>
