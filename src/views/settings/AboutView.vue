<script setup lang="ts">
import { computed } from "vue";
import { CalendarClock, GitCommit, Info, PanelTop, Server } from "lucide-vue-next";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import DataState from "@/components/common/DataState.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const versionQuery = useAsyncData(() => api.version(), { pollInterval: 60000 });
const version = computed(() => versionQuery.data.value);

const dashboardVersion = computed(() => import.meta.env.VITE_APP_VERSION || "dev");
const dashboardCommit = computed(() => import.meta.env.VITE_GIT_COMMIT || "unknown");

function shortRef(value?: string): string {
  if (!value || value === "unknown") return value || "unknown";
  return value.length > 12 ? value.slice(0, 12) : value;
}

function displayDate(value?: string): string {
  return value && value !== "unknown" ? formatDateTime(value) : "unknown";
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('settings.about.title')"
      :description="$t('settings.about.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="versionQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="versionQuery.refreshing.value"
          @click="versionQuery.refresh"
        >
          <Info
            aria-hidden="true"
            :class="cn('size-4', versionQuery.refreshing.value && 'animate-spin')"
          />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Server class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('settings.about.server.title') }}
          </CardTitle>
          <CardDescription>
            {{ $t('settings.about.server.description') }}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="versionQuery.loading.value"
            :error="versionQuery.error.value"
            :is-empty="false"
            :has-data="versionQuery.data.value !== undefined"
            @retry="versionQuery.refresh"
          >
            <dl class="grid gap-4 text-sm">
              <div class="grid gap-1">
                <dt class="text-xs font-medium uppercase text-muted-foreground">
                  {{ $t('settings.about.version') }}
                </dt>
                <dd class="flex flex-wrap items-center gap-2">
                  <Badge variant="info" class="font-mono">
                    {{ version?.server_version || 'unknown' }}
                  </Badge>
                </dd>
              </div>

              <div class="grid gap-1">
                <dt class="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <GitCommit class="size-3.5" aria-hidden="true" />
                  {{ $t('settings.about.commit') }}
                </dt>
                <dd class="flex min-w-0 items-center gap-2">
                  <code class="truncate font-mono text-xs">
                    {{ version?.server_commit || 'unknown' }}
                  </code>
                  <CopyButton
                    v-if="version?.server_commit"
                    :value="version.server_commit"
                  />
                </dd>
              </div>

              <div class="grid gap-1">
                <dt class="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <CalendarClock class="size-3.5" aria-hidden="true" />
                  {{ $t('settings.about.builtAt') }}
                </dt>
                <dd class="font-mono text-xs">
                  {{ displayDate(version?.server_date) }}
                </dd>
              </div>
            </dl>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <PanelTop class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('settings.about.dashboard.title') }}
          </CardTitle>
          <CardDescription>
            {{ $t('settings.about.dashboard.description') }}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl class="grid gap-4 text-sm">
            <div class="grid gap-1">
              <dt class="text-xs font-medium uppercase text-muted-foreground">
                {{ $t('settings.about.version') }}
              </dt>
              <dd>
                <Badge variant="secondary" class="font-mono">
                  {{ dashboardVersion }}
                </Badge>
              </dd>
            </div>

            <div class="grid gap-1">
              <dt class="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <GitCommit class="size-3.5" aria-hidden="true" />
                {{ $t('settings.about.commit') }}
              </dt>
              <dd class="flex min-w-0 items-center gap-2">
                <code class="truncate font-mono text-xs">
                  {{ dashboardCommit }}
                </code>
                <CopyButton
                  v-if="dashboardCommit !== 'unknown'"
                  :value="dashboardCommit"
                />
              </dd>
            </div>

            <div class="grid gap-1">
              <dt class="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <Server class="size-3.5" aria-hidden="true" />
                {{ $t('settings.about.dashboard.bundledRef') }}
              </dt>
              <dd class="flex min-w-0 items-center gap-2">
                <code class="truncate font-mono text-xs">
                  {{ shortRef(version?.dashboard_ref) }}
                </code>
                <CopyButton
                  v-if="version?.dashboard_ref && version.dashboard_ref !== 'unknown'"
                  :value="version.dashboard_ref"
                />
              </dd>
            </div>

            <div class="grid gap-1">
              <dt class="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <CalendarClock class="size-3.5" aria-hidden="true" />
                {{ $t('settings.about.dashboard.bundledAt') }}
              </dt>
              <dd class="font-mono text-xs">
                {{ displayDate(version?.dashboard_built) }}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
