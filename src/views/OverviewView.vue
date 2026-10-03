<script setup lang="ts">
/**
 * Home, the console's L0 (design 23, section 4.1; design 22, section 2,
 * rule 1): what needs the operator first, then four numbers that move, then
 * what runs out this week and the one picture.
 *
 *   Attention  DMIT-4 offline 6d [Open] · 1 task stalled [Tasks] · 2 DDNS failing [DDNS]
 *   32/34 online | 0 approvals waiting | 5 tasks failed in 24h | 0 due in 7 days
 *   Due in 7 days (5 rows) | Fleet at a glance (map) | Recent changes (4 rows)
 *
 * It fits one desktop screen (design 22, rule 1): at most three attention
 * rows before "Show all N", and from 1280 px the three sections share one
 * row, so the map is a thumbnail of its column's width.
 *
 * Every number comes from a read that landed. A read that failed, or one the
 * operator has no scope for, says so where its number would be, and the
 * attention list never claims an all-clear for something it did not see
 * (homeModel). Trust posture moved to Settings > Capability Gates: it is
 * configuration, not something that moves.
 */
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { useNow } from "@vueuse/core";
import { CalendarClock, Map as MapIcon, RotateCw } from "lucide-vue-next";

import { api, unwrap } from "@/lib/api";
import type { ApprovalCounts, AuditEvent, DDNSView, ExpiringResponse, MonitorView, Node, TaskCounts } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { useAuthStore } from "@/stores/auth";
import { formatAge, formatRelativeTime } from "@/lib/format";
import { auditActionLabelKey } from "@/lib/auditAction";
import { proofReason } from "@/components/common/proofModel";
import { countNodeStatuses } from "@/lib/nodeStatus";
import { cn } from "@/lib/utils";
import { PANEL_WITHIN_DAYS, UPCOMING_SCOPES, groupByWeek, isOverdue, todayOf } from "@/views/fleet/upcomingModel";
import { failingMonitors, monitorHealth, operatorMonitors } from "@/views/fleet/monitorHealthModel";
import {
  CHANGES_QUERY,
  CHANGES_ROWS,
  DUE_WITHIN_DAYS,
  FAILED_TASKS_QUERY,
  HOME_ATTENTION_MAX,
  changesOnly,
  dueThisWeek,
  flappingNodes,
  flipQuery,
  flipReadPartial,
  homeAttention,
  nextAfterWeek,
  readState,
  type HomeAttention,
  type ReadState,
} from "@/views/fleet/homeModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import MetricStrip, { type Metric } from "@/components/common/MetricStrip.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import GettingStarted from "@/components/common/GettingStarted.vue";
import FleetMap from "@/components/fleet/FleetMap.vue";
import UpcomingList from "@/components/fleet/UpcomingList.vue";
import { Button } from "@/components/ui/button";

const auth = useAuthStore();
const { t, locale } = useI18n();
const now = useNow({ interval: 1000 });

const can = {
  nodes: auth.can("node:read"),
  approvals: auth.can("approval:read"),
  tasks: auth.can("task:read"),
  audit: auth.can("audit:read"),
  ddns: auth.can("ddns:admin"),
  upcoming: auth.canAny(UPCOMING_SCOPES),
  monitors: auth.can("monitor:read"),
};

/** A read the operator has no scope for is never sent; its number says "no access". */
function gated<T>(allowed: boolean, fetcher: (signal: AbortSignal) => Promise<T>, pollInterval: number) {
  return useAsyncData<T>(fetcher, { immediate: allowed, pollInterval: allowed ? pollInterval : 0 });
}

const fleet = gated<Node[]>(can.nodes, (signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), 5000);
const approvalCounts = gated<ApprovalCounts>(can.approvals, (signal) => api.approvals.counts(undefined, { signal }), 10_000);
const taskCounts = gated<TaskCounts>(can.tasks, (signal) => api.tasks.counts({ signal }), 10_000);
// Dates move once a day; a minute between polls is plenty.
const expiring = gated<ExpiringResponse>(can.upcoming, (signal) => api.expiring.list(PANEL_WITHIN_DAYS, { signal }), 60_000);
const ddns = gated<DDNSView[]>(can.ddns, (signal) => api.ddns.list({ signal }), 60_000);
// Changes only: node flips and observed events (logins, SSH sessions) stay
// out on the server, so four rows are four changes (design 23, section 4.1).
// A server that ignores the exclusions has its flips dropped here, and the
// section says it did not filter.
const changes = gated<{ events: AuditEvent[]; ignored: boolean }>(
  can.audit,
  (signal) => api.audit.query({ ...CHANGES_QUERY, limit: CHANGES_ROWS }, { signal }).then((r) => changesOnly(r.events ?? [])),
  15_000,
);
// The offline transitions of the last day, to find the nodes that keep
// dropping. A read that missed rows makes every count "at least".
const flips = gated<{ events: AuditEvent[]; partial: boolean }>(
  can.audit,
  (signal) => api.audit.query(flipQuery(Date.now()), { signal }).then((r) => ({ events: r.events ?? [], partial: flipReadPartial(r) })),
  60_000,
);

// Failing monitors: the list carries each node's newest result per monitor.
const monitorList = gated<MonitorView[]>(can.monitors, (signal) => api.monitors.list({ signal }).then((r) => unwrap(r, "monitors")), 30_000);
/** The failing monitors, once the list landed; undefined while it is missing. */
const failingMonitorRows = computed(() => {
  const list = monitorList.data.value;
  if (list === undefined) return undefined;
  const at = monitorList.lastUpdated.value ?? Date.now();
  return failingMonitors(operatorMonitors(list), (monitor) => monitorHealth(monitor, monitor.latest, at)).map(({ monitor }) => ({ id: monitor.id, name: monitor.name || monitor.id }));
});

function stateOf(allowed: boolean, query: { data: { value: unknown }; error: { value: unknown } }): ReadState {
  return allowed ? readState({ data: query.data.value, error: query.error.value }) : "forbidden";
}

const nodes = computed(() => fleet.data.value ?? []);
const counts = computed(() => countNodeStatuses(nodes.value));
const isEmptyFleet = computed(() => can.nodes && fleet.data.value !== undefined && nodes.value.length === 0);

/* ------------------------------ proof line ------------------------------ */

const proof = useProof(fleet);

const proofSegments = computed<ProofSegment[]>(() => [
  { key: "nodes", text: t("overview.proof.nodes", { n: nodes.value.length }, nodes.value.length) },
  { key: "via", text: t("overview.proof.via"), tone: "muted" },
]);

/**
 * The reads attention is built from, besides the nodes (whose failure the
 * proof line states). One that failed is listed as information with a retry,
 * so a missing row is never read as an all-clear.
 */
const unreadItems = computed<AttentionItem[]>(() => {
  const sources = [
    ["flips", can.audit, flips],
    ["counts", can.tasks, taskCounts],
    ["ddns", can.ddns, ddns],
    ["expiring", can.upcoming, expiring],
    ["monitors", can.monitors, monitorList],
  ] as const;
  const items: AttentionItem[] = sources.flatMap(([key, allowed, query]) => {
    const state = stateOf(allowed, query);
    if (!allowed || (state !== "failed" && state !== "unsupported")) return [];
    return [
      {
        key: `unread:${key}`,
        tone: "info" as const,
        claim: t(`overview.unread.${key}`),
        proof: state === "unsupported" ? t("overview.read.unsupportedLong") : proofReason(query.error.value) || undefined,
        action: { label: t("common.actions.retry"), run: () => void query.refresh() },
      },
    ];
  });
  return items;
});

function refreshAll(): void {
  for (const [allowed, query] of [
    [can.nodes, fleet],
    [can.approvals, approvalCounts],
    [can.tasks, taskCounts],
    [can.upcoming, expiring],
    [can.ddns, ddns],
    [can.audit, changes],
    [can.audit, flips],
    [can.monitors, monitorList],
  ] as const) {
    if (allowed) void query.refresh();
  }
}
const refreshing = computed(() => fleet.refreshing.value || fleet.loading.value);

/* ------------------------------- attention ------------------------------ */

const attentionModel = computed<HomeAttention[]>(() =>
  homeAttention({
    now: now.value.getTime(),
    nodes: fleet.data.value,
    flaps: flips.data.value ? flappingNodes(flips.data.value.events) : undefined,
    flapsPartial: flips.data.value?.partial,
    counts: taskCounts.data.value,
    ddns: ddns.data.value,
    expiring: expiring.data.value?.items,
    failingMonitors: failingMonitorRows.value,
  }),
);

function age(ms: number | undefined): string {
  return ms === undefined ? "" : formatAge(ms, locale.value);
}

/**
 * The row that proves a node item, in one line. The server's sentence is
 * English and repeats the claim ("No report since ...; the control plane
 * stops trusting a node after 1m30s of silence"), so offline and never
 * reported nodes are worded here from the fields; a degraded node keeps the
 * server's sentence, because it names the part that broke.
 */
function nodeProof(item: Extract<HomeAttention, { kind: "node" }>): string | undefined {
  if (item.status === "degraded") return item.reason || undefined;
  if (item.status === "never_reported") return undefined;
  if (item.lastSeenMs === undefined) return undefined;
  return item.agentVersion
    ? t("overview.attention.proofOffline", { age: age(item.lastSeenMs), version: item.agentVersion })
    : t("overview.attention.proofOfflineNoAgent", { age: age(item.lastSeenMs) });
}

function nodeSheet(id: string) {
  return { name: "nodes", query: { open: id } };
}

function names(list: string[], max = 3): string {
  const shown = list.slice(0, max).join(", ");
  return list.length > max ? t("overview.attention.andMore", { names: shown, n: list.length - max }) : shown;
}

const attention = computed<AttentionItem[]>(() => [
  ...attentionModel.value.map((item): AttentionItem => {
    const open = t("overview.attention.open");
    switch (item.kind) {
      case "node": {
        const key = item.sinceMs === undefined ? `${item.status}NoAge` : item.status;
        return {
          key: item.key,
          tone: item.tone,
          claim: t(`overview.attention.${key}`, { name: item.name, age: age(item.sinceMs) }),
          proof: nodeProof(item),
          action: { label: open, to: nodeSheet(item.nodeId) },
        };
      }
      case "flapping":
        return {
          key: item.key,
          tone: item.tone,
          claim: t(item.atLeast ? "overview.attention.flappingAtLeast" : "overview.attention.flapping", { name: item.name, n: item.count }),
          proof: t("overview.attention.flappingProof", { age: age(now.value.getTime() - item.lastAt) }),
          action: { label: open, to: nodeSheet(item.nodeId) },
        };
      case "stalled":
        return {
          key: item.key,
          tone: item.tone,
          claim: t("overview.attention.stalled", { n: item.count }, item.count),
          action: { label: t("overview.attention.tasks"), to: { name: "tasks", query: { status: "stalled" } } },
        };
      case "ddns":
        return {
          key: item.key,
          tone: item.tone,
          claim: t("overview.attention.ddns", { n: item.count }, item.count),
          proof: `${names(item.names, 2)}: ${item.error}`,
          action: { label: t("overview.attention.ddnsAction"), to: { name: "network-ddns" } },
        };
      case "monitors":
        return {
          key: item.key,
          tone: item.tone,
          claim: t("overview.attention.monitors", { n: item.count }, item.count),
          proof: names(item.names),
          action: {
            label: t("overview.attention.monitorsAction"),
            to: item.count === 1 ? { name: "monitoring", query: { open: item.firstId } } : { name: "monitoring" },
          },
        };
      case "overdue":
        return {
          key: item.key,
          tone: item.tone,
          claim: t("overview.attention.overdue", { n: item.count }, item.count),
          proof: names(item.titles),
          action: { label: t("overview.attention.upcoming"), to: { name: "upcoming" } },
        };
      case "due":
        return {
          key: item.key,
          tone: item.tone,
          claim: t("overview.attention.due", { n: item.count }, item.count),
          proof: names(item.titles),
          action: { label: t("overview.attention.upcoming"), to: { name: "upcoming" } },
        };
    }
  }),
  ...unreadItems.value,
]);

/* -------------------------------- numbers ------------------------------- */

const week = computed(() => dueThisWeek(expiring.data.value?.items ?? []));
const dueCount = computed(() => week.value.shown.length + week.value.more);
// Counted over the whole week, not the five rows shown: a sixth overdue item is still overdue.
const overdueCount = computed(() => (expiring.data.value?.items ?? []).filter((item) => item.days <= DUE_WITHIN_DAYS && isOverdue(item)).length);

/**
 * A number, or the reason there is none. A number held from a read whose
 * refresh failed is the last good one, not a current reading: it loses its
 * colour and says how old it is.
 */
function metric(
  base: Omit<Metric, "value">,
  state: ReadState,
  value: () => Pick<Metric, "value" | "hint" | "tone">,
  query?: { error: { value: unknown }; lastUpdated: { value: number | undefined } },
): Metric {
  if (state !== "ready") return { ...base, to: undefined, value: t(`overview.read.${state}`), tone: "muted" };
  const read = value();
  const at = query?.lastUpdated.value;
  if (query?.error.value && at !== undefined) {
    return { ...base, ...read, tone: "muted", hint: t("overview.metric.lastGood", { age: age(now.value.getTime() - at) }) };
  }
  return { ...base, ...read };
}

const metrics = computed<Metric[]>(() => [
  metric({ key: "online", label: t("overview.metric.online"), to: { name: "nodes" } }, stateOf(can.nodes, fleet), () => ({
    value: counts.value.online,
    hint: t("overview.metric.onlineOf", { total: counts.value.total }),
    tone: counts.value.offline + counts.value.never_reported > 0 ? "warning" : "success",
  }), fleet),
  metric(
    { key: "approvals", label: t("overview.metric.approvals"), to: { name: "approvals" } },
    stateOf(can.approvals, approvalCounts),
    () => {
      const pending = approvalCounts.data.value?.pending ?? 0;
      return { value: pending, tone: pending > 0 ? "warning" : "default" };
    },
    approvalCounts,
  ),
  metric(
    { key: "failed", label: t("overview.metric.failed24h"), to: { name: "tasks", query: { ...FAILED_TASKS_QUERY } } },
    stateOf(can.tasks, taskCounts),
    () => {
      const failed = taskCounts.data.value?.failed_24h ?? 0;
      return { value: failed, hint: t("overview.metric.failed24hHint"), tone: failed > 0 ? "destructive" : "default" };
    },
    taskCounts,
  ),
  metric({ key: "due", label: t("overview.metric.due7"), to: { name: "upcoming" } }, stateOf(can.upcoming, expiring), () => ({
    value: dueCount.value,
    hint: overdueCount.value > 0 ? t("overview.metric.overdue", { n: overdueCount.value }) : undefined,
    tone: overdueCount.value > 0 ? "destructive" : dueCount.value > 0 ? "warning" : "default",
  }), expiring),
]);

/* ------------------------------ due this week ----------------------------- */

const expiringState = computed(() => stateOf(can.upcoming, expiring));
const today = computed(() => todayOf(expiring.data.value, now.value.getTime()));
const dueGroups = computed(() => groupByWeek(week.value.shown, today.value));
const nextItem = computed(() => nextAfterWeek(expiring.data.value?.items ?? []));

/* ---------------------------------- map ---------------------------------- */

const located = computed(() => nodes.value.filter((node) => typeof node.geo?.lat === "number" && typeof node.geo?.lon === "number").length);

/* -------------------------------- changes -------------------------------- */

const changesState = computed(() => stateOf(can.audit, changes));

/** What a change did, for a person; an action without a label keeps its raw name. */
function changeLabel(action: string): string | null {
  const key = auditActionLabelKey(action);
  return key ? t(key) : null;
}
</script>

<template>
  <div class="space-y-4 p-4 sm:p-6">
    <PageHeader :title="$t('overview.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('overview.description') }}</p>
        <ProofLine v-if="can.nodes" v-bind="proof" :segments="proofSegments" @retry="fleet.refresh" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="refreshing" @click="refreshAll">
          <RotateCw :class="cn('size-4', refreshing && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- First run: nothing enrolled yet. -->
    <GettingStarted v-if="isEmptyFleet" :node-count="0" :two-factor-enabled="auth.principal?.totp_enabled" />

    <template v-else>
      <AttentionList :items="attention" :max="HOME_ATTENTION_MAX" />

      <MetricStrip :metrics="metrics" :columns="4" />

      <!-- From 1280 px the three sections share one row, so home fits one
           screen; between 1024 and 1280 Recent changes takes its own row. -->
      <div class="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,6fr)_minmax(0,4fr)_minmax(0,4fr)]">
        <!-- Due in 7 days: what needs a hand this week, at most five rows. -->
        <section class="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="home-due">
          <header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <CalendarClock class="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 id="home-due" class="text-sm font-medium">{{ $t('overview.due.title') }}</h2>
            <RouterLink
              v-if="can.upcoming"
              :to="{ name: 'upcoming' }"
              class="ms-auto rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-end"
            >
              {{ $t('overview.due.all') }}
            </RouterLink>
          </header>
          <div v-if="expiringState !== 'ready'" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-6 text-sm text-muted-foreground">
            <span class="min-w-0 break-words">{{ $t(`overview.read.${expiringState}Long`, { reason: proofReason(expiring.error.value) }) }}</span>
            <Button v-if="expiringState === 'failed'" variant="outline" size="sm" @click="expiring.refresh()">
              {{ $t('common.actions.retry') }}
            </Button>
          </div>
          <template v-else>
            <UpcomingList v-if="week.shown.length" :groups="dueGroups" :today="today" />
            <div v-else class="space-y-1 px-4 py-5">
              <p class="text-sm">{{ $t('overview.due.none') }}</p>
              <p v-if="nextItem" class="text-xs text-muted-foreground">
                {{ $t('overview.due.next', { title: nextItem.title, n: nextItem.days, date: nextItem.due_at.slice(5, 10) }) }}
              </p>
            </div>
            <p
              v-if="week.more > 0 || week.auto > 0"
              class="mt-auto flex flex-wrap gap-x-3 border-t border-border px-4 py-2 text-xs text-muted-foreground"
            >
              <RouterLink v-if="week.more > 0" :to="{ name: 'upcoming' }" class="underline decoration-dotted underline-offset-2 hover:text-foreground">
                {{ $t('overview.due.more', { n: week.more }) }}
              </RouterLink>
              <span v-if="week.auto > 0">{{ $t('overview.due.auto', { n: week.auto }, week.auto) }}</span>
            </p>
          </template>
        </section>

        <!-- The one picture: where the fleet runs, as status clusters. -->
        <section class="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="home-map">
          <header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <MapIcon class="size-4 text-muted-foreground" aria-hidden="true" />
            <h2 id="home-map" class="text-sm font-medium">{{ $t('overview.map.title') }}</h2>
            <span v-if="fleet.data.value" class="ms-auto font-mono text-xs text-muted-foreground tabular">
              {{ $t('overview.map.located', { located, total: nodes.length }) }}
            </span>
          </header>
          <div class="p-3">
            <RouterLink
              v-if="fleet.data.value"
              :to="{ name: 'map' }"
              class="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :aria-label="$t('overview.map.open')"
            >
              <FleetMap :nodes="nodes" compact />
            </RouterLink>
            <div v-else class="grid aspect-[2/1] place-items-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              {{ $t(`overview.read.${stateOf(can.nodes, fleet)}`) }}
            </div>
          </div>
        </section>

        <!-- Recent changes: what operators and automation did, not node flips.
             Its rows follow the section's own width (a container query), so
             they fold to two lines in the narrow column. -->
        <section class="@container min-w-0 overflow-hidden rounded-lg border border-border bg-card lg:col-span-2 xl:col-span-1" aria-labelledby="home-changes">
          <header class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border px-4 py-2.5">
            <h2 id="home-changes" class="text-sm font-medium" :title="$t('overview.changes.hint')">{{ $t('overview.changes.title') }}</h2>
            <span class="hidden text-xs text-muted-foreground @md:inline">{{ $t('overview.changes.hint') }}</span>
            <RouterLink
              v-if="can.audit"
              :to="{ name: 'audit' }"
              class="ms-auto rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-end"
            >
              {{ $t('common.actions.viewAll') }}
            </RouterLink>
          </header>
          <div v-if="changesState !== 'ready'" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-5 text-sm text-muted-foreground">
            <span class="min-w-0 break-words">{{ $t(`overview.read.${changesState}Long`, { reason: proofReason(changes.error.value) }) }}</span>
            <Button v-if="changesState === 'failed'" variant="outline" size="sm" @click="changes.refresh()">
              {{ $t('common.actions.retry') }}
            </Button>
          </div>
          <p v-else-if="!changes.data.value?.events.length && !changes.data.value?.ignored" class="px-4 py-5 text-sm text-muted-foreground">{{ $t('overview.changes.empty') }}</p>
          <p
            v-if="changesState === 'ready' && changes.data.value?.ignored"
            :class="cn('px-4 text-xs text-muted-foreground', changes.data.value.events.length ? 'border-b border-border py-2' : 'py-5')"
          >
            {{ $t('overview.changes.unfiltered', { n: CHANGES_ROWS }) }}
          </p>
          <ul v-if="changesState === 'ready' && changes.data.value?.events.length" class="divide-y divide-border">
            <li v-for="event in changes.data.value.events" :key="event.id">
              <RouterLink
                :to="{ name: 'audit', query: { open: event.id } }"
                class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @xl:grid-cols-[14rem_minmax(0,1fr)_8rem_8rem]"
              >
                <!-- The label says what happened; the raw action rides in mono after
                     the node, so the row still reads as the audit entry it opens. -->
                <span v-if="changeLabel(event.action)" class="truncate text-sm" :title="event.action">{{ changeLabel(event.action) }}</span>
                <span v-else class="truncate font-mono text-xs" :title="event.action">{{ event.action }}</span>
                <span class="col-start-1 row-start-2 flex min-w-0 gap-2 text-xs text-muted-foreground @xl:col-start-2 @xl:row-start-1">
                  <NodeLabel v-if="event.node_id" :id="event.node_id" :nodes="nodes" class="max-w-[60%] shrink-0" />
                  <span v-else class="shrink-0">{{ $t('overview.changes.noNode') }}</span>
                  <span v-if="changeLabel(event.action)" class="min-w-0 truncate font-mono" :title="event.action">{{ event.action }}</span>
                </span>
                <span class="hidden truncate text-xs text-muted-foreground @xl:block">{{ event.actor_id }}</span>
                <span class="col-start-2 row-span-2 row-start-1 text-right text-xs text-muted-foreground tabular @xl:col-start-4 @xl:row-span-1" :title="event.at">
                  {{ formatRelativeTime(event.at) }}
                </span>
              </RouterLink>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
