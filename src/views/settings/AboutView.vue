<script setup lang="ts">
import { computed } from "vue";
import { CalendarClock, GitCommit, PanelTop, RefreshCw, Server } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
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

const { t } = useI18n();

const versionQuery = useAsyncData((signal) => api.version({ signal }), { pollInterval: 60000 });
const version = computed(() => versionQuery.data.value);

// The build stamps these at compile time; "unknown" is the raw sentinel the
// build writes, so it never reaches the screen untranslated.
const RAW_UNKNOWN = "unknown";
const unknownLabel = computed(() => t("settings.about.unknown"));

const dashboardVersion = computed(() => import.meta.env.VITE_APP_VERSION || "dev");
const dashboardCommit = computed(() => import.meta.env.VITE_GIT_COMMIT || RAW_UNKNOWN);
const dashboardCommitKnown = computed(() => dashboardCommit.value !== RAW_UNKNOWN);
const dashboardCommitLabel = computed(() =>
  dashboardCommitKnown.value ? dashboardCommit.value : unknownLabel.value,
);

function shortRef(value?: string): string {
  if (!value || value === RAW_UNKNOWN) return unknownLabel.value;
  return value.length > 12 ? value.slice(0, 12) : value;
}

function displayDate(value?: string): string {
  return value && value !== RAW_UNKNOWN ? formatDateTime(value) : unknownLabel.value;
}
</script>

<template>
  <div class="page-narrow p-6 space-y-6">
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
          <RefreshCw
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
            :is-empty="versionQuery.data.value === undefined"
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
                    {{ version?.server_version || unknownLabel }}
                  </Badge>
                </dd>
              </div>

              <div class="grid gap-1">
                <dt class="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <GitCommit class="size-3.5" aria-hidden="true" />
                  {{ $t('settings.about.commit') }}
                </dt>
                <dd class="flex min-w-0 items-center gap-2">
                  <code
                    class="truncate font-mono text-xs"
                    :title="version?.server_commit || unknownLabel"
                  >
                    {{ version?.server_commit || unknownLabel }}
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
          <!-- bundledRef/bundledAt come from the same /version call as the server
               card, so this half needs the same loading + error treatment. -->
          <DataState
            :loading="versionQuery.loading.value"
            :error="versionQuery.error.value"
            :is-empty="versionQuery.data.value === undefined"
            :has-data="versionQuery.data.value !== undefined"
            @retry="versionQuery.refresh"
          >
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
                  <code class="truncate font-mono text-xs" :title="dashboardCommitLabel">
                    {{ dashboardCommitLabel }}
                  </code>
                  <CopyButton v-if="dashboardCommitKnown" :value="dashboardCommit" />
                </dd>
              </div>

              <div class="grid gap-1">
                <dt class="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <Server class="size-3.5" aria-hidden="true" />
                  {{ $t('settings.about.dashboard.bundledRef') }}
                </dt>
                <dd class="flex min-w-0 items-center gap-2">
                  <code
                    class="truncate font-mono text-xs"
                    :title="version?.dashboard_ref || unknownLabel"
                  >
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
          </DataState>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
