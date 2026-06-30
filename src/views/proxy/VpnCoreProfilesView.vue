<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { LayoutGrid, List, RefreshCw, Server, ShieldCheck, Radar, TriangleAlert } from "lucide-vue-next";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface CollectorRuntime {
  source?: string;
  status?: string;
  checked_at?: string;
  last_ok_at?: string;
  last_error?: string;
}
interface NodeProfileRuntime {
  node_id: string;
  node_name?: string;
  managed: boolean;
  core?: string;
  core_version?: string;
  config_path?: string;
  stats_api?: string;
  applied: boolean;
  last_apply_at?: string;
  last_error?: string;
  inbound_count: number;
  discovered_count: number;
  discovery_status?: string;
  discovery_error?: string;
  discovered_at?: string;
  collector?: CollectorRuntime;
  capabilities: string[];
}

const { t } = useI18n();
const query = useAsyncData(
  () => api.plugins.call<{ profiles: NodeProfileRuntime[]; count: number }>("latticenet.vpn-core", "latticenet.vpn-core/profiles", "query"),
  { pollInterval: 20000 },
);
const viewMode = ref<"cards" | "list">("cards");
const profiles = computed<NodeProfileRuntime[]>(() => query.data.value?.profiles ?? []);
const managedCount = computed(() => profiles.value.filter((p) => p.managed).length);
const unmanagedCount = computed(() => profiles.value.filter((p) => !p.managed).length);
const appliedCount = computed(() => profiles.value.filter((p) => p.applied).length);
const discoveryCount = computed(() => profiles.value.reduce((sum, p) => sum + (p.discovered_count || 0), 0));
const inboundCount = computed(() => profiles.value.reduce((sum, p) => sum + (p.inbound_count || 0), 0));
const collectorOkCount = computed(() => profiles.value.filter((p) => p.collector?.status === "ok").length);
const errorCount = computed(() =>
  profiles.value.filter((p) => p.last_error || p.discovery_status === "error" || p.collector?.status === "error").length,
);

function collectorVariant(status?: string) {
  if (status === "ok") return "success" as const;
  if (status === "error") return "destructive" as const;
  return "secondary" as const;
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('vpnProfiles.title')" :description="$t('vpnProfiles.description')">
      <template #status>
        <FreshnessLabel :last-updated="query.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="query.refreshing.value" @click="query.refresh">
          <RefreshCw :class="cn('size-4', query.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3">
      <StatCard :label="$t('vpnProfiles.kpiNodes')" :value="profiles.length" :icon="Server" />
      <StatCard :label="$t('vpnProfiles.kpiManaged')" :value="managedCount" :icon="ShieldCheck" tone="success" />
      <StatCard :label="$t('vpnProfiles.kpiErrors')" :value="errorCount" :icon="TriangleAlert" :tone="errorCount > 0 ? 'destructive' : undefined" />
    </div>

    <Card>
      <CardContent class="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-5">
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('vpnProfiles.applied') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ appliedCount }} / {{ profiles.length }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('vpnProfiles.summaryAppliedHint') }}</p>
        </div>
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('vpnProfiles.inbounds') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ inboundCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('vpnProfiles.summaryInboundHint') }}</p>
        </div>
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('vpnProfiles.discovered') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ discoveryCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('vpnProfiles.summaryDiscoveredHint') }}</p>
        </div>
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('vpnProfiles.collector') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ collectorOkCount }} ok</p>
          <p class="text-xs text-muted-foreground">{{ $t('vpnProfiles.summaryCollectorHint') }}</p>
        </div>
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ $t('vpnProfiles.unmanaged') }}</p>
          <p class="mt-1 text-xl font-semibold tabular">{{ unmanagedCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('vpnProfiles.summaryUnmanagedHint') }}</p>
        </div>
      </CardContent>
    </Card>

    <DataState
      :loading="query.loading.value"
      :error="query.error.value"
      :has-data="query.data.value !== undefined"
      :is-empty="profiles.length === 0"
      :empty-title="$t('vpnProfiles.emptyTitle')"
      :empty-description="$t('vpnProfiles.emptyDescription')"
      @retry="query.refresh"
    >
      <div class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-sm font-medium">{{ $t('vpnProfiles.runtimeInventory') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('vpnProfiles.runtimeInventoryHint') }}</p>
          </div>
          <div class="flex items-center gap-1 rounded-md border border-border p-1">
            <Button type="button" size="sm" :variant="viewMode === 'cards' ? 'secondary' : 'ghost'" @click="viewMode = 'cards'">
              <LayoutGrid class="size-4" aria-hidden="true" />
              {{ $t('vpnProfiles.cardsView') }}
            </Button>
            <Button type="button" size="sm" :variant="viewMode === 'list' ? 'secondary' : 'ghost'" @click="viewMode = 'list'">
              <List class="size-4" aria-hidden="true" />
              {{ $t('vpnProfiles.listView') }}
            </Button>
          </div>
        </div>

      <div v-if="viewMode === 'cards'" class="grid gap-4 lg:grid-cols-2">
        <Card v-for="p in profiles" :key="p.node_id">
          <CardHeader>
            <div class="flex items-start justify-between gap-3">
              <CardTitle class="flex items-center gap-2">
                <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <RouterLink :to="{ name: 'node-detail', params: { id: p.node_id } }" class="truncate text-sm hover:text-primary hover:underline">
                  {{ p.node_name || p.node_id }}
                </RouterLink>
              </CardTitle>
              <div class="flex items-center gap-1.5">
                <Badge :variant="p.managed ? 'default' : 'outline'">
                  {{ p.managed ? $t('vpnProfiles.managed') : $t('vpnProfiles.unmanaged') }}
                </Badge>
                <Badge v-if="p.core" variant="outline">{{ p.core }}{{ p.core_version ? ` ${p.core_version}` : "" }}</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent class="space-y-3 text-sm">
            <dl class="grid grid-cols-2 gap-x-4 gap-y-2">
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('vpnProfiles.applied') }}</dt>
                <dd>
                  <Badge :variant="p.applied ? 'success' : 'secondary'" class="text-[11px]">
                    {{ p.applied ? $t('vpnProfiles.appliedYes') : $t('vpnProfiles.appliedNo') }}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('vpnProfiles.inbounds') }}</dt>
                <dd class="tabular-nums">{{ p.inbound_count }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('vpnProfiles.discovered') }}</dt>
                <dd class="flex items-center gap-1.5">
                  <Radar class="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <span class="tabular-nums">{{ p.discovered_count }}</span>
                  <Tooltip v-if="p.discovery_status && p.discovery_status !== 'ok'">
                    <TooltipTrigger as-child>
                      <Badge variant="destructive" class="cursor-help text-[10px]">{{ p.discovery_status }}</Badge>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs whitespace-pre-wrap">
                      {{ p.discovery_error || p.discovery_status }}
                    </TooltipContent>
                  </Tooltip>
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('vpnProfiles.collector') }}</dt>
                <dd>
                  <Tooltip v-if="p.collector?.last_error">
                    <TooltipTrigger as-child>
                      <Badge :variant="collectorVariant(p.collector?.status)" class="cursor-help text-[11px]">{{ p.collector?.status || "—" }}</Badge>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs">{{ p.collector?.last_error }}</TooltipContent>
                  </Tooltip>
                  <Badge v-else :variant="collectorVariant(p.collector?.status)" class="text-[11px]">{{ p.collector?.status || "—" }}</Badge>
                </dd>
              </div>
            </dl>

            <div v-if="p.config_path" class="font-mono text-xs text-muted-foreground">{{ p.config_path }}</div>
            <div class="grid gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground sm:grid-cols-2">
              <div>
                <span class="font-medium text-foreground">{{ $t('vpnProfiles.lastApply') }}:</span>
                {{ p.last_apply_at ? formatRelativeTime(p.last_apply_at) : "—" }}
              </div>
              <div>
                <span class="font-medium text-foreground">{{ $t('vpnProfiles.discoveredAt') }}:</span>
                {{ p.discovered_at ? formatRelativeTime(p.discovered_at) : "—" }}
              </div>
              <div>
                <span class="font-medium text-foreground">{{ $t('vpnProfiles.statsApi') }}:</span>
                {{ p.stats_api || "—" }}
              </div>
              <div>
                <span class="font-medium text-foreground">{{ $t('vpnProfiles.configPath') }}:</span>
                {{ p.config_path || "—" }}
              </div>
            </div>

            <div v-if="p.last_error" class="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{{ p.last_error }}</div>
            <div v-if="p.discovery_error" class="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{{ p.discovery_error }}</div>

            <div class="flex flex-wrap gap-1">
              <span class="text-xs text-muted-foreground">{{ $t('vpnProfiles.capabilities') }}:</span>
              <Badge v-for="cap in p.capabilities" :key="cap" variant="secondary" class="text-[10px]">{{ cap }}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card v-else>
        <CardHeader>
          <CardTitle class="text-base">{{ $t('vpnProfiles.listTitle') }}</CardTitle>
          <CardDescription>{{ $t('vpnProfiles.listDescription') }}</CardDescription>
        </CardHeader>
        <CardContent class="overflow-x-auto">
          <table class="w-full min-w-[980px] text-sm">
            <thead class="border-b border-border text-xs uppercase text-muted-foreground">
              <tr>
                <th class="px-3 py-2 text-left font-medium">{{ $t('vpnProfiles.node') }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ $t('vpnProfiles.core') }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ $t('vpnProfiles.state') }}</th>
                <th class="px-3 py-2 text-right font-medium">{{ $t('vpnProfiles.inbounds') }}</th>
                <th class="px-3 py-2 text-right font-medium">{{ $t('vpnProfiles.discovered') }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ $t('vpnProfiles.collector') }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ $t('vpnProfiles.paths') }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ $t('vpnProfiles.lastSeen') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in profiles" :key="p.node_id" class="border-b border-border last:border-0 hover:bg-muted/35">
                <td class="px-3 py-2">
                  <RouterLink :to="{ name: 'node-detail', params: { id: p.node_id } }" class="font-medium hover:text-primary hover:underline">
                    {{ p.node_name || p.node_id }}
                  </RouterLink>
                  <p class="font-mono text-xs text-muted-foreground">{{ p.node_id }}</p>
                </td>
                <td class="px-3 py-2">
                  <Badge v-if="p.core" variant="outline">{{ p.core }}{{ p.core_version ? ` ${p.core_version}` : "" }}</Badge>
                  <span v-else class="text-muted-foreground">—</span>
                </td>
                <td class="px-3 py-2">
                  <div class="flex flex-wrap gap-1">
                    <Badge :variant="p.managed ? 'default' : 'outline'">{{ p.managed ? $t('vpnProfiles.managed') : $t('vpnProfiles.unmanaged') }}</Badge>
                    <Badge :variant="p.applied ? 'success' : 'secondary'">{{ p.applied ? $t('vpnProfiles.appliedYes') : $t('vpnProfiles.appliedNo') }}</Badge>
                  </div>
                  <p v-if="p.last_error || p.discovery_error" class="mt-1 max-w-xs truncate text-xs text-destructive">
                    {{ p.last_error || p.discovery_error }}
                  </p>
                </td>
                <td class="px-3 py-2 text-right tabular">{{ p.inbound_count }}</td>
                <td class="px-3 py-2 text-right tabular">{{ p.discovered_count }}</td>
                <td class="px-3 py-2">
                  <Badge :variant="collectorVariant(p.collector?.status)" class="text-[11px]">{{ p.collector?.status || "—" }}</Badge>
                  <p v-if="p.collector?.last_error" class="mt-1 max-w-xs truncate text-xs text-destructive">{{ p.collector.last_error }}</p>
                </td>
                <td class="px-3 py-2">
                  <p class="max-w-xs truncate font-mono text-xs">{{ p.config_path || "—" }}</p>
                  <p class="max-w-xs truncate font-mono text-xs text-muted-foreground">{{ p.stats_api || "—" }}</p>
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground">
                  <p>{{ p.last_apply_at ? formatDateTime(p.last_apply_at) : "—" }}</p>
                  <p v-if="p.discovered_at">{{ $t('vpnProfiles.discoveryShort') }} {{ formatRelativeTime(p.discovered_at) }}</p>
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
      </div>
    </DataState>
  </div>
</template>
