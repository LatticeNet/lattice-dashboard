<script setup lang="ts">
import { computed } from "vue";
import {
  RotateCw,
  Server,
  Wifi,
  ShieldCheck,
  Terminal,
  ArrowDown,
  ArrowUp,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Activity,
} from "lucide-vue-next";
import { api, unwrap, ApiError } from "@/lib/api";
import type { Node, ApprovalView, TaskView, AuditEvent } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import {
  formatBytesPerSec,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  ratio,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import StatCard from "@/components/common/StatCard.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import MetricBar from "@/components/common/MetricBar.vue";
import DataState from "@/components/common/DataState.vue";
import GettingStarted from "@/components/common/GettingStarted.vue";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/** Treat 403 as "section not visible" rather than a hard error. */
function soften<T>(fetcher: (signal: AbortSignal) => Promise<T>) {
  return async (signal: AbortSignal): Promise<T | undefined> => {
    try {
      return await fetcher(signal);
    } catch (e) {
      if (e instanceof ApiError && e.isForbidden) return undefined;
      throw e;
    }
  };
}

const fleet = useAsyncData<Node[] | undefined>(
  soften(() => api.nodes.list().then((r) => unwrap(r, "nodes"))),
  { pollInterval: 5000 },
);

const approvals = useAsyncData<ApprovalView[] | undefined>(
  soften(() => api.approvals.list().then((r) => unwrap(r, "approvals"))),
  { pollInterval: 10000 },
);

const tasks = useAsyncData<TaskView[] | undefined>(
  soften(() => api.tasks.list().then((r) => unwrap(r, "tasks"))),
  { pollInterval: 10000 },
);

const audit = useAsyncData<AuditEvent[] | undefined>(
  soften(() => api.audit.query({ limit: 8 }).then((r) => r.events ?? [])),
  { pollInterval: 15000 },
);

const auth = useAuthStore();

const nodes = computed<Node[]>(() => fleet.data.value ?? []);
const onlineNodes = computed(() => nodes.value.filter((n) => n.online).length);
const offlineNodes = computed(() => nodes.value.length - onlineNodes.value);
const canReadFleet = computed(() => auth.can("node:read"));

/** First-run state: no nodes enrolled yet and the fleet query has settled. */
const isEmptyFleet = computed(
  () =>
    canReadFleet.value &&
    !fleet.loading.value &&
    fleet.data.value !== undefined &&
    nodes.value.length === 0,
);

const pendingApprovals = computed(
  () => (approvals.data.value ?? []).filter((a) => a.status === "pending"),
);
const queuedTasks = computed(
  () => (tasks.data.value ?? []).filter((t) => t.status === "queued").length,
);

const sortedNodes = computed(() =>
  [...nodes.value].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

const auditEvents = computed(() => (audit.data.value ?? []).slice(0, 6));

function decisionVariant(d: string): "success" | "destructive" | "secondary" {
  if (d === "allow") return "success";
  if (d === "deny") return "destructive";
  return "secondary";
}

function refreshAll() {
  fleet.refresh();
  approvals.refresh();
  tasks.refresh();
  audit.refresh();
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('overview.title')" :description="$t('overview.description')">
      <template #actions>
        <div class="flex items-center gap-3">
          <span v-if="fleet.lastUpdated.value" class="text-xs text-muted-foreground">
            {{ $t('common.misc.updated') }} {{ formatRelativeTime(fleet.lastUpdated.value) }}
          </span>
          <Button variant="outline" size="sm" :disabled="fleet.refreshing.value" @click="refreshAll">
            <RotateCw :class="cn('size-4', fleet.refreshing.value && 'animate-spin')" aria-hidden="true" />
            {{ $t('common.actions.refresh') }}
          </Button>
        </div>
      </template>
    </PageHeader>

    <!-- First-run onboarding: shown only when no nodes are enrolled yet. -->
    <GettingStarted
      v-if="isEmptyFleet"
      :node-count="0"
      :two-factor-enabled="auth.principal?.totp_enabled"
    />

    <template v-else>
    <!-- KPI row -->
    <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard
        :label="$t('overview.kpi.nodes')"
        :value="nodes.length"
        :icon="Server"
      />
      <StatCard
        :label="$t('overview.kpi.online')"
        :value="onlineNodes"
        tone="success"
        :icon="Wifi"
        :hint="offlineNodes > 0 ? $t('overview.offlineCount', { count: offlineNodes }) : $t('overview.allOnline')"
      />
      <StatCard
        :label="$t('overview.kpi.approvals')"
        :value="pendingApprovals.length"
        :tone="pendingApprovals.length > 0 ? 'warning' : 'default'"
        :icon="ShieldCheck"
      />
      <StatCard
        :label="$t('nav.items.tasks')"
        :value="queuedTasks"
        :icon="Terminal"
      />
    </div>

    <!-- Main grid -->
    <div class="grid gap-6 lg:grid-cols-3">
      <!-- Fleet -->
      <Card class="lg:col-span-2">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Server class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('overview.fleet') }}
          </CardTitle>
          <CardDescription>
            {{ $t('overview.fleetOnline', { online: onlineNodes, total: nodes.length }) }}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="fleet.loading.value"
            :error="fleet.error.value"
            :is-empty="nodes.length === 0"
            :empty-title="$t('overview.noNodes')"
            :empty-description="$t('overview.noNodesDescription')"
          >
            <div class="grid gap-3 sm:grid-cols-2">
              <div
                v-for="node in sortedNodes"
                :key="node.id"
                :class="
                  cn(
                    'rounded-lg border border-border bg-background/40 p-4 transition-colors',
                    node.online ? 'hover:bg-muted/40' : 'opacity-60',
                  )
                "
              >
                <!-- Header -->
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <StatusDot :active="node.online" :pulse="node.online" />
                      <span class="truncate font-medium">{{ node.name || node.id }}</span>
                    </div>
                    <p
                      v-if="node.host_facts"
                      class="mt-1 truncate font-mono text-xs text-muted-foreground tabular"
                    >
                      {{ node.host_facts.hostname || node.id }}
                      <template v-if="node.host_facts.os">
                        · {{ node.host_facts.os }}
                      </template>
                      <template v-if="node.host_facts.arch">
                        · {{ node.host_facts.arch }}
                      </template>
                    </p>
                  </div>
                  <div class="flex shrink-0 flex-wrap justify-end gap-1">
                    <Badge v-if="node.role" variant="secondary">{{ node.role }}</Badge>
                    <Badge
                      v-for="tag in (node.tags ?? []).slice(0, 2)"
                      :key="tag"
                      variant="outline"
                    >
                      {{ tag }}
                    </Badge>
                  </div>
                </div>

                <!-- Metrics -->
                <div class="mt-4 space-y-2.5">
                  <MetricBar
                    label="CPU"
                    :icon="Cpu"
                    :percent="node.metrics?.cpu_percent ?? 0"
                    :value-text="formatPercent(node.metrics?.cpu_percent)"
                  />
                  <MetricBar
                    label="Memory"
                    :icon="MemoryStick"
                    tone="memory"
                    :percent="ratio(node.metrics?.memory_used, node.metrics?.memory_total)"
                    :used="node.metrics?.memory_used"
                    :total="node.metrics?.memory_total"
                  />
                  <MetricBar
                    label="Disk"
                    :icon="HardDrive"
                    tone="disk"
                    :percent="ratio(node.metrics?.disk_used, node.metrics?.disk_total)"
                    :used="node.metrics?.disk_used"
                    :total="node.metrics?.disk_total"
                  />
                </div>

                <!-- Footer stats -->
                <div
                  class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular"
                >
                  <span class="inline-flex items-center gap-1">
                    <ArrowDown class="size-3" aria-hidden="true" />
                    {{ formatBytesPerSec(node.metrics?.net_rx_speed) }}
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <ArrowUp class="size-3" aria-hidden="true" />
                    {{ formatBytesPerSec(node.metrics?.net_tx_speed) }}
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <Activity class="size-3" aria-hidden="true" />
                    {{ formatDuration(node.metrics?.uptime_seconds) }}
                  </span>
                  <span class="inline-flex items-center gap-1">
                    <Clock class="size-3" aria-hidden="true" />
                    {{ formatRelativeTime(node.last_seen) }}
                  </span>
                </div>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <!-- Right column -->
      <div class="space-y-6">
        <!-- Approvals inbox -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <ShieldCheck class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('overview.approvalsInbox') }}
            </CardTitle>
            <CardDescription>{{ $t('overview.approvalsDescription') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="approvals.loading.value"
              :error="approvals.error.value"
              :is-empty="pendingApprovals.length === 0"
              :empty-title="$t('overview.noPendingApprovals')"
              :empty-description="$t('overview.everythingUpToDate')"
              :empty-tone="'positive'"
            >
              <ul class="divide-y divide-border">
                <li
                  v-for="a in pendingApprovals.slice(0, 5)"
                  :key="a.id"
                  class="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <StatusDot tone="warning" pulse />
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm">
                      <span class="font-medium">{{ a.plugin }}</span>
                      <span class="text-muted-foreground"> · {{ a.action }}</span>
                    </p>
                    <p class="truncate font-mono text-xs text-muted-foreground tabular">
                      {{ a.node_id }}
                    </p>
                  </div>
                  <span class="shrink-0 text-xs text-muted-foreground tabular">
                    {{ formatRelativeTime(a.created_at) }}
                  </span>
                </li>
              </ul>
            </DataState>
          </CardContent>
        </Card>

        <!-- Recent activity -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Activity class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('overview.recentActivity') }}
            </CardTitle>
            <CardDescription>{{ $t('overview.recentActivityDescription') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="audit.loading.value"
              :error="audit.error.value"
              :is-empty="auditEvents.length === 0"
              :empty-title="$t('overview.noRecentActivity')"
              :empty-description="$t('overview.auditWillAppear')"
            >
              <ul class="divide-y divide-border">
                <li
                  v-for="ev in auditEvents"
                  :key="ev.id"
                  class="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-mono text-xs tabular">{{ ev.action }}</p>
                    <p v-if="ev.node_id" class="truncate font-mono text-xs text-muted-foreground tabular">
                      {{ ev.node_id }}
                    </p>
                  </div>
                  <Badge :variant="decisionVariant(ev.decision)">{{ ev.decision }}</Badge>
                  <span class="shrink-0 text-xs text-muted-foreground tabular">
                    {{ formatRelativeTime(ev.at) }}
                  </span>
                </li>
              </ul>
            </DataState>
          </CardContent>
        </Card>
      </div>
    </div>
    </template>
  </div>
</template>
