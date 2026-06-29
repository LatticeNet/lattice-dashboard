<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  ArrowUpRight,
  ChevronRight,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
  Waypoints,
} from "lucide-vue-next";
import { api, type Line, type LineGroup, type LinesListResponse } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const { t } = useI18n();

// Real Badge variant tokens (mirrors src/components/ui/badge/badgeVariants.ts).
type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "info";

// The Lines read-model is owned by the vpn-core plugin and reached ONLY through
// the design-10 dashboard→plugin gateway (never a bespoke /api/proxy route).
// A 4xx here (plugin inactive / missing scope) is surfaced gracefully by
// DataState — the page never crashes.
const linesQuery = useAsyncData(
  () =>
    api.plugins.call<LinesListResponse>(
      "latticenet.vpn-core",
      "latticenet.vpn-core/lines",
      "list",
    ),
  { pollInterval: 15000 },
);

const groups = computed<LineGroup[]>(() => linesQuery.data.value?.groups ?? []);
const sortedGroups = computed<LineGroup[]>(() =>
  [...groups.value].sort((a, b) =>
    (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id),
  ),
);
const allLines = computed<Line[]>(() => groups.value.flatMap((g) => g.lines ?? []));

// ── KPI strip ────────────────────────────────────────────────────────────────
const totalLines = computed(() => linesQuery.data.value?.count ?? allLines.value.length);
const nodeCount = computed(() => groups.value.length);
const managedCount = computed(() => allLines.value.filter((l) => l.source === "managed").length);
const errorCount = computed(() => allLines.value.filter((l) => l.status === "error").length);
const isEmpty = computed(() => allLines.value.length === 0);

// ── Source / status visual treatment ──────────────────────────────────────────
function sourceVariant(source: string): BadgeVariant {
  if (source === "managed") return "default"; // solid / primary
  if (source === "imported") return "secondary";
  return "outline"; // discovered (+ anything unknown) → muted outline
}
function sourceLabel(source: string): string {
  switch (source) {
    case "managed":
      return t("lines.sourceManaged");
    case "discovered":
      return t("lines.sourceDiscovered");
    case "imported":
      return t("lines.sourceImported");
    default:
      return source || "—";
  }
}
function statusVariant(status?: string): BadgeVariant {
  switch (status) {
    case "ok":
      return "success";
    case "pending":
      return "warning";
    case "error":
      return "destructive";
    default:
      return "secondary"; // stale + unknown
  }
}
function statusLabel(status?: string): string {
  switch (status) {
    case "ok":
      return t("lines.statusOk");
    case "pending":
      return t("lines.statusPending");
    case "error":
      return t("lines.statusError");
    case "stale":
      return t("lines.statusStale");
    default:
      return status || t("lines.statusUnknown");
  }
}

// ── Detail drawer (the app's modal primitive; no separate Sheet exists) ───────
const selected = ref<Line | null>(null);
const detailOpen = ref(false);
function openDetail(line: Line) {
  selected.value = line;
  detailOpen.value = true;
}

const metadataEntries = computed<[string, string][]>(() =>
  selected.value?.metadata ? Object.entries(selected.value.metadata) : [],
);

const detailRows = computed<{ label: string; value: string }[]>(() => {
  const l = selected.value;
  if (!l) return [];
  const listen = l.listen_host
    ? l.listen_port
      ? `${l.listen_host}:${l.listen_port}`
      : l.listen_host
    : l.listen_port
      ? `:${l.listen_port}`
      : "—";
  const rows: { label: string; value: string }[] = [
    { label: t("lines.fieldNode"), value: l.node_id },
    { label: t("lines.fieldSource"), value: sourceLabel(l.source) },
    { label: t("lines.fieldCore"), value: l.core || "—" },
    { label: t("lines.fieldName"), value: l.name || "—" },
    { label: t("lines.fieldTag"), value: l.tag || "—" },
    { label: t("lines.fieldType"), value: l.type || "—" },
    { label: t("lines.fieldListen"), value: listen },
    { label: t("lines.fieldPublic"), value: l.public_host || "—" },
    { label: t("lines.fieldDomain"), value: l.domain || "—" },
    { label: t("lines.fieldOutbound"), value: l.outbound_ref || "—" },
    {
      label: t("lines.fieldUsers"),
      value: l.user_known ? String(l.user_count) : t("lines.usersUnknown"),
    },
    { label: t("lines.fieldStatus"), value: statusLabel(l.status) },
  ];
  if (l.last_error) rows.push({ label: t("lines.fieldLastError"), value: l.last_error });
  return rows;
});
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('lines.title')" :description="$t('lines.description')">
      <template #status>
        <FreshnessLabel :last-updated="linesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="linesQuery.refreshing.value"
          @click="linesQuery.refresh"
        >
          <RefreshCw
            :class="cn('size-4', linesQuery.refreshing.value && 'animate-spin')"
            aria-hidden="true"
          />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('lines.kpiLines')" :value="totalLines" :icon="Waypoints" />
      <StatCard :label="$t('lines.kpiNodes')" :value="nodeCount" :icon="Server" />
      <StatCard :label="$t('lines.kpiManaged')" :value="managedCount" :icon="ShieldCheck" tone="success" />
      <StatCard
        :label="$t('lines.kpiErrors')"
        :value="errorCount"
        :icon="TriangleAlert"
        :tone="errorCount > 0 ? 'destructive' : undefined"
      />
    </div>

    <DataState
      :loading="linesQuery.loading.value"
      :error="linesQuery.error.value"
      :has-data="linesQuery.data.value !== undefined"
      :is-empty="isEmpty"
      :empty-title="$t('lines.emptyTitle')"
      :empty-description="$t('lines.emptyDescription')"
      @retry="linesQuery.refresh"
    >
      <div class="space-y-6">
        <Card v-for="group in sortedGroups" :key="group.node_id">
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <CardTitle class="flex items-center gap-2">
                  <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <RouterLink
                    :to="{ name: 'node-detail', params: { id: group.node_id } }"
                    class="inline-flex min-w-0 items-center gap-1 truncate text-sm hover:text-primary hover:underline"
                    :title="$t('lines.viewNode')"
                  >
                    <span class="truncate font-medium">{{ group.node_name || group.node_id }}</span>
                    <ArrowUpRight class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  </RouterLink>
                </CardTitle>
                <div class="font-mono text-xs text-muted-foreground">{{ group.node_id }}</div>
              </div>
              <Badge variant="secondary" class="shrink-0">
                {{ $t('lines.groupLineCount', { count: group.lines.length }, group.lines.length) }}
              </Badge>
            </div>
          </CardHeader>

          <CardContent>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-xs text-muted-foreground">
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colSource') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colCore') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colName') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colTag') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colType') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colListen') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colPublic') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colOutbound') }}</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('lines.colUsers') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colStatus') }}</th>
                    <th scope="col" class="px-3 py-2"><span class="sr-only">{{ $t('lines.viewDetail') }}</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="line in group.lines"
                    :key="line.id || line.line_hash_id"
                    role="button"
                    tabindex="0"
                    class="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
                    :aria-label="$t('lines.viewDetail')"
                    @click="openDetail(line)"
                    @keydown.enter.prevent="openDetail(line)"
                    @keydown.space.prevent="openDetail(line)"
                  >
                    <td class="px-3 py-3">
                      <Badge :variant="sourceVariant(line.source)">{{ sourceLabel(line.source) }}</Badge>
                    </td>
                    <td class="px-3 py-3">
                      <Badge v-if="line.core" variant="outline">{{ line.core }}</Badge>
                      <span v-else class="text-muted-foreground">—</span>
                    </td>
                    <td class="px-3 py-3">
                      <span class="font-medium">{{ line.name || "—" }}</span>
                    </td>
                    <td class="px-3 py-3">
                      <span class="font-mono text-xs text-muted-foreground">{{ line.tag || "—" }}</span>
                    </td>
                    <td class="px-3 py-3">
                      <span class="font-mono text-xs text-muted-foreground">{{ line.type || "—" }}</span>
                    </td>
                    <td class="px-3 py-3">
                      <span class="font-mono text-xs">
                        {{ line.listen_host || "—" }}<span
                          v-if="line.listen_port"
                          class="text-muted-foreground"
                        >:{{ line.listen_port }}</span>
                      </span>
                    </td>
                    <td class="px-3 py-3">
                      <div class="font-mono text-xs">{{ line.public_host || "—" }}</div>
                      <div v-if="line.domain" class="font-mono text-xs text-muted-foreground">{{ line.domain }}</div>
                    </td>
                    <td class="px-3 py-3">
                      <span class="font-mono text-xs">{{ line.outbound_ref || "—" }}</span>
                    </td>
                    <td class="px-3 py-3 text-right">
                      <Tooltip v-if="!line.user_known">
                        <TooltipTrigger as-child>
                          <span class="cursor-help font-mono text-xs text-muted-foreground">
                            {{ $t('lines.usersUnknown') }}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{{ $t('lines.usersUnknownHint') }}</TooltipContent>
                      </Tooltip>
                      <span v-else class="font-mono text-xs tabular">{{ line.user_count }}</span>
                    </td>
                    <td class="px-3 py-3">
                      <Tooltip v-if="line.status === 'error' && line.last_error">
                        <TooltipTrigger as-child>
                          <Badge :variant="statusVariant(line.status)" class="cursor-help">
                            {{ statusLabel(line.status) }}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent class="max-w-xs">{{ line.last_error }}</TooltipContent>
                      </Tooltip>
                      <Badge v-else :variant="statusVariant(line.status)">{{ statusLabel(line.status) }}</Badge>
                    </td>
                    <td class="px-3 py-3 text-right">
                      <ChevronRight class="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DataState>

    <!-- Line detail drawer -->
    <Dialog v-model:open="detailOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ $t('lines.detailTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('lines.detailDescription', { name: selected?.name || selected?.line_hash_id }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="selected" class="space-y-4">
          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('lines.fieldLineHashId') }}</span>
              <CopyButton :value="selected.line_hash_id" :label="$t('common.actions.copy')" />
            </div>
            <code class="block break-all p-3 font-mono text-xs">{{ selected.line_hash_id }}</code>
          </div>

          <dl class="overflow-hidden rounded-md border border-border">
            <div
              v-for="(row, idx) in detailRows"
              :key="row.label"
              class="flex items-start justify-between gap-4 px-3 py-2.5"
              :class="cn(idx % 2 === 1 && 'bg-muted/30', idx > 0 && 'border-t border-border')"
            >
              <dt class="shrink-0 text-xs font-medium text-muted-foreground">{{ row.label }}</dt>
              <dd class="min-w-0 break-words text-right font-mono text-xs">{{ row.value }}</dd>
            </div>
          </dl>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('lines.jumpEdgesTitle') }}</p>
            <div v-if="selected.jump_edges && selected.jump_edges.length" class="space-y-1">
              <div
                v-for="edge in selected.jump_edges"
                :key="edge"
                class="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
              >
                <code class="block break-all font-mono text-xs">{{ edge }}</code>
                <CopyButton :value="edge" />
              </div>
            </div>
            <p v-else class="text-xs text-muted-foreground">{{ $t('lines.noJumpEdges') }}</p>
          </div>

          <div v-if="metadataEntries.length" class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('lines.fieldMetadata') }}</p>
            <dl class="overflow-hidden rounded-md border border-border">
              <div
                v-for="([k, v], idx) in metadataEntries"
                :key="k"
                class="flex items-start justify-between gap-4 px-3 py-2"
                :class="cn(idx % 2 === 1 && 'bg-muted/30', idx > 0 && 'border-t border-border')"
              >
                <dt class="shrink-0 font-mono text-xs text-muted-foreground">{{ k }}</dt>
                <dd class="min-w-0 break-words text-right font-mono text-xs">{{ v }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="detailOpen = false">
            {{ $t('common.actions.close') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
