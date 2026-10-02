<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { AlertTriangle, Boxes, CalendarClock, Lock } from "lucide-vue-next";
import { ApiError, type ExpiringItem, type ExpiringResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EXPIRING_KINDS, groupByWeek, hiddenKindsOf, todayOf, upcomingState } from "@/views/fleet/upcomingModel";

import EmptyState from "@/components/common/EmptyState.vue";
import UpcomingList from "./UpcomingList.vue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Every state the expiring list can be in, for the home panel and the full
 * page alike. A failure never turns into an empty list: with nothing loaded
 * it says it failed, after a good load it keeps the rows and says how old
 * they are, and a server without the endpoint says so and points at
 * Inventory instead of claiming nothing is due.
 */
const props = withDefaults(
  defineProps<{
    data?: ExpiringResponse;
    error?: Error;
    loading: boolean;
    lastUpdated?: number;
    /** The rows to show, after any filter; defaults to every row. */
    items?: ExpiringItem[];
    filtered?: boolean;
    now: number;
    /**
     * Inside a card: hairlines above and below the rows, states inset to the
     * card's padding. Off, on a page: the rows get their own rounded frame.
     */
    framed?: boolean;
    /** Rows that offer "Record renewal" (UpcomingList). */
    renewable?: (item: ExpiringItem) => boolean;
  }>(),
  { data: undefined, error: undefined, lastUpdated: undefined, items: undefined, filtered: false, framed: true, renewable: undefined },
);

const emit = defineEmits<{ retry: []; clearFilter: []; renew: [item: ExpiringItem] }>();

const rows = computed(() => props.items ?? props.data?.items ?? []);
const view = computed(() =>
  upcomingState({ loading: props.loading, error: props.error, data: props.data, visible: rows.value.length }),
);
// Not on the ticking clock: the weeks move when the data does, not every second.
const today = computed(() => todayOf(props.data, props.lastUpdated ?? Date.now()));
const groups = computed(() => groupByWeek(rows.value, today.value));
const within = computed(() => props.data?.within_days ?? 30);
const { t } = useI18n();

/**
 * "VPN users and shares are not shown for your scopes": the kinds, never a
 * count, since a count of unreadable rows tells a confined session how big
 * the fleet is.
 */
const hiddenSentence = computed(() => {
  const kinds = hiddenKindsOf(props.data);
  if (!kinds.length) return "";
  const names = kinds.map((kind) =>
    (EXPIRING_KINDS as readonly string[]).includes(kind) ? t(`fleet.upcoming.kindsInSentence.${kind}`) : kind,
  );
  const list =
    names.length === 1
      ? names[0]
      : t("fleet.upcoming.listAnd", { head: names.slice(0, -1).join(t("fleet.upcoming.listSeparator")), last: names[names.length - 1] });
  const sentence = t("fleet.upcoming.hiddenKinds", { kinds: list });
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
});
/** Inside a card the states line up with the card's text; on a page they take the full width. */
const inset = computed(() => (props.framed ? "mx-4 sm:mx-6" : ""));
const serverDetail = computed(() =>
  props.error instanceof ApiError ? props.error.serverMessage : props.error?.message ?? "",
);
</script>

<template>
  <div>
    <div v-if="view.state === 'loading'" :class="cn('space-y-2', inset)" aria-busy="true">
      <Skeleton v-for="n in 3" :key="n" class="h-8 w-full rounded-md" />
    </div>

    <div v-else-if="view.state === 'unsupported'" :class="cn('flex items-start gap-3 rounded-md border border-border bg-muted/20 p-4', inset)">
      <CalendarClock class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="min-w-0 space-y-2">
        <p class="text-sm font-medium">{{ $t('fleet.upcoming.unsupported.title') }}</p>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.upcoming.unsupported.description') }}</p>
        <Button variant="outline" size="sm" as-child>
          <RouterLink :to="{ name: 'inventory', query: { group: 'renewal' } }">
            <Boxes class="size-4" aria-hidden="true" />
            {{ $t('fleet.upcoming.unsupported.action') }}
          </RouterLink>
        </Button>
      </div>
    </div>

    <div v-else-if="view.state === 'forbidden'" :class="cn('flex items-center gap-2 rounded-md border border-border p-4 text-sm text-muted-foreground', inset)">
      <Lock class="size-4 shrink-0" aria-hidden="true" />
      {{ $t('common.state.noAccess') }}
    </div>

    <div v-else-if="view.state === 'failed'" :class="cn('flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4', inset)" role="alert">
      <AlertTriangle class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div class="min-w-0 space-y-2">
        <p class="text-sm font-medium text-destructive">{{ $t('fleet.upcoming.failed') }}</p>
        <p v-if="serverDetail" class="break-words font-mono text-xs text-muted-foreground">{{ serverDetail }}</p>
        <Button variant="outline" size="sm" @click="emit('retry')">{{ $t('common.actions.retry') }}</Button>
      </div>
    </div>

    <template v-else>
      <div
        v-if="view.stale"
        :class="cn('mb-3 flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2', inset)"
        role="status"
      >
        <p class="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertTriangle class="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          {{ $t('fleet.upcoming.stale') }}
        </p>
        <Button variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-xs" @click="emit('retry')">
          {{ $t('common.actions.retry') }}
        </Button>
      </div>

      <!-- Above the rows, not after them: on a long list the last line is
           the one nobody scrolls to. -->
      <p v-if="hiddenSentence" :class="cn('mb-3 flex items-center gap-2 text-xs text-muted-foreground', inset)" data-testid="upcoming-hidden">
        <Lock class="size-3.5 shrink-0" aria-hidden="true" />
        {{ hiddenSentence }}
      </p>

      <div v-if="view.state === 'empty'" :class="inset">
        <EmptyState
          v-if="filtered"
          :title="$t('fleet.upcoming.empty.filteredTitle', { days: within })"
        >
          <Button variant="outline" size="sm" @click="emit('clearFilter')">{{ $t('fleet.upcoming.empty.showAll') }}</Button>
        </EmptyState>
        <EmptyState
          v-else
          :icon="CalendarClock"
          :title="$t('fleet.upcoming.empty.title', { days: within })"
          :description="$t('fleet.upcoming.empty.description')"
        />
      </div>
      <UpcomingList
        v-else
        :groups="groups"
        :today="today"
        :renewable="renewable"
        @renew="(item: ExpiringItem) => emit('renew', item)"
        :class="framed ? 'border-y border-border' : 'overflow-hidden rounded-lg border border-border'"
      />

    </template>
  </div>
</template>
