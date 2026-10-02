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
    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:min-h-11",
    active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
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

    <!-- Kind chips: a segmented row that scrolls sideways at 375 rather than wrapping into a wall. -->
    <div v-if="!unsupported" class="-mx-4 relative overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div
        class="inline-flex gap-1 rounded-lg border border-border bg-muted/30 p-1"
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
