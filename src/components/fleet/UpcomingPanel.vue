<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useNow } from "@vueuse/core";
import { CalendarClock } from "lucide-vue-next";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { PANEL_WITHIN_DAYS, UPCOMING_SCOPES } from "@/views/fleet/upcomingModel";

import UpcomingBody from "./UpcomingBody.vue";
import UpcomingProof from "./UpcomingProof.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Home's view of what runs out in the next 30 days, grouped by week, with the
 * cost it adds up to. Dates move once a day, so a minute between polls is
 * plenty; the proof line's age ticks on its own.
 */
const query = useAsyncData((signal) => api.expiring.list(PANEL_WITHIN_DAYS, { signal }), { pollInterval: 60_000 });
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
          class="ms-auto text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
        >
          {{ $t('common.actions.viewAll') }}
        </RouterLink>
      </CardTitle>
      <CardDescription>
        <UpcomingProof :data="query.data.value" :now="now.getTime()" />
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
