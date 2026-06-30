<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { RefreshCw, Server, ShieldCheck, Radar, TriangleAlert } from "lucide-vue-next";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
const profiles = computed<NodeProfileRuntime[]>(() => query.data.value?.profiles ?? []);
const managedCount = computed(() => profiles.value.filter((p) => p.managed).length);
const errorCount = computed(() => profiles.value.filter((p) => p.last_error || p.discovery_status === "error").length);

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

    <DataState
      :loading="query.loading.value"
      :error="query.error.value"
      :has-data="query.data.value !== undefined"
      :is-empty="profiles.length === 0"
      :empty-title="$t('vpnProfiles.emptyTitle')"
      :empty-description="$t('vpnProfiles.emptyDescription')"
      @retry="query.refresh"
    >
      <div class="grid gap-4 lg:grid-cols-2">
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

            <div v-if="p.last_error" class="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{{ p.last_error }}</div>
            <div v-if="p.discovery_error" class="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{{ p.discovery_error }}</div>

            <div class="flex flex-wrap gap-1">
              <span class="text-xs text-muted-foreground">{{ $t('vpnProfiles.capabilities') }}:</span>
              <Badge v-for="cap in p.capabilities" :key="cap" variant="secondary" class="text-[10px]">{{ cap }}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </DataState>
  </div>
</template>
