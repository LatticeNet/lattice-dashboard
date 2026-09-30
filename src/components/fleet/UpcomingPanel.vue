<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useNow } from "@vueuse/core";
import { CalendarClock } from "lucide-vue-next";
import type { ExpiringResponse } from "@/lib/api";
import type { AsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { UPCOMING_SCOPES } from "@/views/fleet/upcomingModel";

import UpcomingBody from "./UpcomingBody.vue";
import UpcomingProof from "./UpcomingProof.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Home's view of what runs out in the next 30 days, grouped by week, with the
 * cost it adds up to. Home owns the read (PANEL_WITHIN_DAYS, once a minute)
 * because its top summary counts the same rows; the proof line's age ticks
 * on its own.
 */
const props = defineProps<{ query: AsyncData<ExpiringResponse> }>();
const query = props.query;
const now = useNow({ interval: 1000 });
const auth = useAuthStore();
const canOpenList = computed(() => auth.canAny(UPCOMING_SCOPES));
</script>

<template>
  <Card class="gap-4">
    <CardHeader class="gap-1">
      <CardTitle class="flex items-center gap-2">
        <CalendarClock class="size-4 text-muted-foreground" aria-hidden="true" />
        {{ $t('fleet.upcoming.panelTitle') }}
        <RouterLink
          v-if="canOpenList"
          :to="{ name: 'upcoming' }"
          class="ms-auto rounded-sm text-xs font-normal text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          {{ $t('common.actions.viewAll') }}
        </RouterLink>
      </CardTitle>
      <CardDescription>
        <UpcomingProof :query="query" />
      </CardDescription>
    </CardHeader>
    <CardContent class="px-0">
      <UpcomingBody
        :data="query.data.value"
        :error="query.error.value"
        :loading="query.loading.value"
        :last-updated="query.lastUpdated.value"
        :now="now.getTime()"
        @retry="query.refresh"
      />
    </CardContent>
  </Card>
</template>
