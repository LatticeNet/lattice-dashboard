<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  RotateCw,
  Server,
  Wifi,
  ShieldCheck,
  Terminal,
  Activity,
} from "lucide-vue-next";
import { api, unwrap, ApiError } from "@/lib/api";
import type { Node, ApprovalView, TaskView, AuditEvent } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMetricBuffer } from "@/composables/useMetricBuffer";
import { useAuthStore } from "@/stores/auth";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import StatCard from "@/components/common/StatCard.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import NodeCard from "@/components/common/NodeCard.vue";
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
const { t } = useI18n();

// Client-side metric ring: feed each poll so NodeCard sparklines have history.
const metricBuffer = useMetricBuffer();
watch(
  () => fleet.data.value,
  (list) => {
    for (const node of list ?? []) metricBuffer.record(node.id, node.metrics);
  },
  { immediate: true },
);

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
      <template #status>
        <FreshnessLabel :last-updated="fleet.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="fleet.refreshing.value" @click="refreshAll">
          <RotateCw :class="cn('size-4', fleet.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
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
            :has-data="fleet.data.value !== undefined"
            :is-empty="nodes.length === 0"
            :empty-title="$t('overview.noNodes')"
            :empty-description="$t('overview.noNodesDescription')"
            @retry="fleet.refresh"
          >
            <div class="grid gap-3 sm:grid-cols-2">
              <NodeCard
                v-for="node in sortedNodes"
                :key="node.id"
                :node="node"
                show-sparkline
                sparkline-metric="cpu"
                :selectable="false"
                :cpu-label="t('overview.metric.cpu')"
                :memory-label="t('overview.metric.memory')"
                :disk-label="t('overview.metric.disk')"
                :online-label="t('common.status.online')"
                :offline-label="t('common.status.offline')"
                :disabled-label="t('common.status.disabled')"
                :sparkline-label="t('overview.sparklineLabel')"
              />
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
              :has-data="approvals.data.value !== undefined"
              :is-empty="pendingApprovals.length === 0"
              :empty-title="$t('overview.noPendingApprovals')"
              :empty-description="$t('overview.everythingUpToDate')"
              :empty-tone="'positive'"
              @retry="approvals.refresh"
            >
              <ul class="divide-y divide-border">
                <li
                  v-for="a in pendingApprovals.slice(0, 5)"
                  :key="a.id"
                  class="-mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/40"
                >
                  <StatusDot status="degraded" pulse />
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
              :has-data="audit.data.value !== undefined"
              :is-empty="auditEvents.length === 0"
              :empty-title="$t('overview.noRecentActivity')"
              :empty-description="$t('overview.auditWillAppear')"
              @retry="audit.refresh"
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
