<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useNow } from "@vueuse/core";
import { RotateCw } from "lucide-vue-next";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { cn } from "@/lib/utils";
import {
  EXPIRING_KINDS,
  LIST_WITHIN_DAYS,
  filterByKinds,
  hiddenKindsOf,
  isUnsupported,
  kindCounts,
  kindFilterQuery,
  parseKindFilter,
  toggleKind,
  type KnownKind,
} from "./upcomingModel";

import PageHeader from "@/components/common/PageHeader.vue";
import UpcomingBody from "@/components/fleet/UpcomingBody.vue";
import UpcomingProof from "@/components/fleet/UpcomingProof.vue";
import { Button } from "@/components/ui/button";

/**
 * Everything that runs out in the next 90 days, overdue first, grouped by
 * week: the same rows as home's Upcoming panel with a longer reach and a kind
 * filter. The filter lives in the address bar (`?kind=share,vpn_user`), so a
 * filtered view survives a reload and opens the same way from a shared link.
 */
const route = useRoute();
const router = useRouter();
const now = useNow({ interval: 1000 });

const query = useAsyncData((signal) => api.expiring.list(LIST_WITHIN_DAYS, { signal }), { pollInterval: 60_000 });

const kinds = computed(() => parseKindFilter(route.query.kind));
const allItems = computed(() => query.data.value?.items ?? []);
const visible = computed(() => filterByKinds(allItems.value, kinds.value));
const counts = computed(() => kindCounts(allItems.value));
// Counts only for a list that loaded: a failed read is not zero of anything,
// and a server without the list has nothing for the chips to filter.
const loaded = computed(() => query.data.value !== undefined);
const unsupported = computed(() => isUnsupported(query.error.value));
// A kind the session cannot read gets no chip: it would only ever count zero.
const chipKinds = computed(() => {
  const hidden = hiddenKindsOf(query.data.value);
  return EXPIRING_KINDS.filter((kind) => !hidden.includes(kind));
});

function setKinds(next: KnownKind[]): void {
  const wanted = kindFilterQuery(next);
  if (route.query.kind === wanted) return;
  router.replace({ query: { ...route.query, kind: wanted } }).catch(() => {});
}

const chipClass = (active: boolean) =>
  cn(
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background pointer-coarse:h-11",
    active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/40",
  );
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.upcoming.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.upcoming.description') }}</p>
        <UpcomingProof :query="query" :items="visible" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="query.refreshing.value" @click="query.refresh">
          <RotateCw :class="cn('size-4', query.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Kind chips: a multi-select filter, drawn as bordered chips like SSH
         Guard's so it never reads as a layer row. At 375 the row scrolls
         sideways rather than wrapping into a wall, and the scroll padding
         brings a chip reached by keyboard fully into view. -->
    <div v-if="!unsupported" class="-mx-4 relative scroll-px-4 overflow-x-auto px-4 py-1 sm:mx-0 sm:scroll-px-0 sm:px-0">
      <div
        class="inline-flex gap-1.5"
        role="group"
        :aria-label="$t('fleet.upcoming.filter.label')"
      >
        <button type="button" :aria-pressed="kinds.length === 0" :class="chipClass(kinds.length === 0)" @click="setKinds([])">
          {{ $t('fleet.upcoming.filter.all') }}
          <span v-if="loaded" class="font-mono tabular text-muted-foreground">{{ allItems.length }}</span>
        </button>
        <button
          v-for="kind in chipKinds"
          :key="kind"
          type="button"
          :aria-pressed="kinds.includes(kind)"
          :class="chipClass(kinds.includes(kind))"
          @click="setKinds(toggleKind(kinds, kind))"
        >
          {{ $t(`fleet.upcoming.filter.${kind}`) }}
          <span v-if="loaded" class="font-mono tabular text-muted-foreground">{{ counts[kind] }}</span>
        </button>
      </div>
    </div>

    <UpcomingBody
      :framed="false"
      :data="query.data.value"
      :error="query.error.value"
      :loading="query.loading.value"
      :last-updated="query.lastUpdated.value"
      :items="visible"
      :filtered="kinds.length > 0"
      :now="now.getTime()"
      @retry="query.refresh"
      @clear-filter="setKinds([])"
    />
  </div>
</template>
