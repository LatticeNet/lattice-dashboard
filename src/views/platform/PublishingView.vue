<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Globe, Link2, RefreshCw, ShieldAlert } from "lucide-vue-next";
import { RouterLink } from "vue-router";

import { api, type PublishingRecord, type StorageKind } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { originTarget, publishingState, routeLabel, sortRecords } from "./publishingModel";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import StorageAdminPanel from "@/components/platform/StorageAdminPanel.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const { t } = useI18n();
const auth = useAuthStore();

// The storage forms below edit one origin at a time. Which origins the operator
// may edit is the server's answer, not a guess, so an origin they cannot admin
// is never offered as a tab.
const editableOrigins = computed<StorageKind[]>(() =>
  (["kv", "static"] as StorageKind[]).filter((origin) => auth.can(`${origin}:admin`) || auth.can(`${origin}:read`)),
);
const selectedOrigin = ref<StorageKind>("kv");
const activeOrigin = computed<StorageKind | undefined>(() =>
  editableOrigins.value.includes(selectedOrigin.value) ? selectedOrigin.value : editableOrigins.value[0],
);

const recordsQuery = useAsyncData(() => api.publishing.records());

const records = computed(() => sortRecords(recordsQuery.data.value?.records ?? []));
const visibleOrigins = computed(() => recordsQuery.data.value?.origins ?? []);

// An empty table means two very different things, and rendering the same empty
// state for both would tell the operator the product is empty when in fact they
// were not allowed to look.
const nothingVisible = computed(() => visibleOrigins.value.length === 0);

const columns = computed<DataTableColumn<PublishingRecord>[]>(() => [
  { key: "route", label: t("platform.publishing.columnRoute"), searchable: true },
  { key: "origin", label: t("platform.publishing.columnOrigin"), sortable: true, searchable: true },
  { key: "target", label: t("platform.publishing.columnServes"), searchable: true },
  { key: "state", label: t("platform.publishing.columnState") },
]);

function stateVariant(record: PublishingRecord) {
  switch (publishingState(record)) {
    case "serving":
      return "default";
    case "expired":
      return "destructive";
    default:
      return "secondary";
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.publishing.title')"
      :description="$t('platform.publishing.description')"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="recordsQuery.refreshing.value"
          @click="recordsQuery.refresh"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', recordsQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Globe aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.publishing.routesTitle') }}
        </CardTitle>
        <CardDescription>{{ $t('platform.publishing.routesDescription') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <p
          v-if="nothingVisible && !recordsQuery.loading.value"
          class="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          <ShieldAlert aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
          {{ $t('platform.publishing.noOriginsVisible') }}
        </p>

        <DataTable
          v-else
          :columns="columns"
          :rows="records"
          :row-key="(record) => record.id"
          :loading="recordsQuery.loading.value"
          :error="recordsQuery.error.value"
          :page-size="25"
          searchable
          :search-placeholder="$t('platform.publishing.searchRoutes')"
          :empty-title="$t('platform.publishing.emptyTitle')"
          :empty-description="$t('platform.publishing.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="recordsQuery.refresh"
        >
          <template #cell-route="{ row }">
            <span class="font-mono text-xs">{{ routeLabel(row, $t('platform.publishing.anyHost')) }}</span>
            <Badge v-if="row.reserved" variant="outline" class="ml-2 align-middle text-[10px]">
              {{ $t('platform.publishing.reserved') }}
            </Badge>
          </template>
          <template #cell-origin="{ row }">
            <span class="text-xs">{{ $t(`platform.publishing.origin.${row.origin}`) }}</span>
          </template>
          <template #cell-target="{ row }">
            <RouterLink
              v-if="row.origin === 'plugin'"
              to="/network/subscription-shares"
              class="inline-flex items-center gap-1 rounded-sm font-mono text-xs text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Link2 aria-hidden="true" class="size-3" />
              {{ originTarget(row) }}
            </RouterLink>
            <span v-else class="font-mono text-xs">{{ originTarget(row) }}</span>
          </template>
          <template #cell-state="{ row }">
            <Badge :variant="stateVariant(row)">
              {{ $t(`platform.publishing.state.${publishingState(row)}`) }}
            </Badge>
            <span v-if="row.expires_at" class="ml-2 text-xs text-muted-foreground">
              {{ formatDateTime(row.expires_at) }}
            </span>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <section v-if="editableOrigins.length" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm text-muted-foreground">{{ $t('platform.publishing.originPickerLabel') }}</span>
        <div class="inline-flex rounded-md border border-border p-0.5">
          <button
            v-for="origin in editableOrigins"
            :key="origin"
            type="button"
            :class="cn(
              'rounded-sm px-3 py-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              activeOrigin === origin ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
            )"
            :aria-pressed="activeOrigin === origin"
            @click="selectedOrigin = origin"
          >
            {{ $t(`platform.publishing.origin.${origin}`) }}
          </button>
        </div>
      </div>

      <!--
        One "Publishing and access" block for the whole console. It used to be
        rendered on the KV page and again on the Static page, which is what made
        publishing read as two unrelated features instead of one.
      -->
      <StorageAdminPanel v-if="activeOrigin" :key="activeOrigin" :kind="activeOrigin" />
    </section>
  </div>
</template>
