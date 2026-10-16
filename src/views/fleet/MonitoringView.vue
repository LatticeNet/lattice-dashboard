<script setup lang="ts">
/**
 * Monitoring (design 29 D7): five layers on ?view=, Overview the bare URL.
 *
 *   Overview   what needs a look, and how far each source reaches
 *   Paths      the source by target matrix; a cell opens the path sheet and its chart
 *   Checks     every check in one list, the editor, the path set, history retention
 *   Topology   every path the console knows, drawn once
 *   Incidents  the incidents the server holds
 *
 * One ?window= for the page (1h to 7d, and 14d when fine history is kept that
 * long). Old links keep working: ?view=latency lands on Paths (its ?pair= on
 * the path sheet), ?view=monitors on Checks, the keepalive spelling on
 * Incidents, and a link that names a monitor or a node (?open=, ?node=, the
 * old /monitoring/:id) on Checks.
 *
 * The page owns the reads every layer shares (monitors, nodes, incidents and
 * the path reads in usePathsData) and the editors, so Overview and Paths can
 * open the path set or a new check without leaving for Checks first.
 */
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useNow } from "@vueuse/core";
import { Plus, RadioTower, RefreshCw, Settings2 } from "lucide-vue-next";

import { api, unwrap, type IncidentListResponse, type MonitorType, type MonitorView, type MonitorWindow, type Node } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindLayer } from "@/composables/useLayer";
import { useAuthStore } from "@/stores/auth";

import type { AttentionItem } from "@/components/common/AttentionList.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import KeepaliveLayer from "@/components/fleet/KeepaliveLayer.vue";
import { Button } from "@/components/ui/button";

import CheckEditorSheet from "./CheckEditorSheet.vue";
import ChecksLayer from "./ChecksLayer.vue";
import OverviewLayer from "./OverviewLayer.vue";
import PathSetSheet from "./PathSetSheet.vue";
import PathsLayer from "./PathsLayer.vue";
import RetentionSheet from "./RetentionSheet.vue";
import TopologyLayer from "./TopologyLayer.vue";
import WindowControl from "./WindowControl.vue";
import { filterCounts, isSnoozed } from "./incidentsModel";
import { failingMonitors, monitorHealth, operatorMonitors } from "./monitorHealthModel";
import { DEFAULT_WINDOW, LEGACY_WINDOWS, MONITORING_LAYERS, legacyMonitoringRedirect, legacyWindow, parseWindow, reachBySource, type MonitoringLayer } from "./pathsModel";
import { usePathsData } from "./usePathsData";
import { serverSpeaksM2a } from "./checkRulesModel";
import { withPathVerdict } from "./checksModel";

const auth = useAuthStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const canReadMonitors = computed(() => auth.can("monitor:read"));
const canReadNodes = computed(() => auth.can("node:read"));
const canAdminMonitors = computed(() => auth.can("monitor:admin"));

const monitorsQuery = useAsyncData(
  (signal) => (canReadMonitors.value ? api.monitors.list({ signal }).then((r) => unwrap(r, "monitors")) : Promise.resolve([] as MonitorView[])),
  { pollInterval: 10000, immediate: canReadMonitors.value },
);
const nodesQuery = useAsyncData(
  (signal) => (canReadNodes.value ? api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")) : Promise.resolve([] as Node[])),
  { pollInterval: 15000, immediate: canReadNodes.value },
);
// A session without monitor:read never sends it, first read or poll.
const incidentsQuery = useAsyncData<IncidentListResponse>((signal) => api.incidents.list(undefined, { signal }), {
  pollInterval: canReadMonitors.value ? 10000 : 0,
  immediate: canReadMonitors.value,
});
const now = useNow({ interval: 1000 });

const owned = useOwnedRoute();

/* ---- Layers and old links ---- */

const layerFallback = (): MonitoringLayer => {
  const query = owned.query();
  return query.open || query.node || route.params.id ? "checks" : "overview";
};
const layer = bindLayer<MonitoringLayer>(owned, () => MONITORING_LAYERS, layerFallback);

// ?view=latency, ?view=monitors and the keepalive spelling, rewritten once.
watch(
  () => owned.query(),
  (query) => {
    if (!owned.owns()) return;
    const next = legacyMonitoringRedirect(query);
    if (next) owned.replace(next);
  },
  { immediate: true },
);
// A link that names a monitor or a node lands on Checks, and the address says
// so: closing the sheet or clearing the node chip removes the parameter, and
// the page must not switch to Overview under the operator.
watch(
  () => owned.query(),
  (query) => {
    if (!owned.owns() || query.view || query.tab) return;
    if (query.open || query.node) owned.replace({ ...query, view: "checks" });
  },
  { immediate: true },
);
// The old /monitoring/:id (Upcoming's TLS rows) opens that check's sheet.
watch(
  () => route.params.id,
  (id) => {
    if (typeof id === "string" && id) router.replace({ name: "monitoring", query: { ...route.query, view: "checks", open: id } }).catch(() => {});
  },
  { immediate: true },
);

/* ---- The window and the path reads ---- */

const windowParam = bindQueryParam<MonitorWindow>(owned, "window", {
  parse: (raw) => parseWindow(raw),
  format: (value) => (value === DEFAULT_WINDOW ? undefined : value),
});

const monitorNames = computed(() => new Map((monitorsQuery.data.value ?? []).map((m) => [m.id, m.name || m.id])));
const data = usePathsData({
  requested: windowParam,
  canRead: canReadMonitors,
  checkName: (id) => monitorNames.value.get(id),
  nodeName: (id) => nodesQuery.data.value?.find((n) => n.id === id)?.name,
  controlPlane: () => t("fleet.monitoring.result.controlPlane"),
});
/** The control shows the window the reads use, so a link naming another marks the one actually read. */
const windowModel = computed<MonitorWindow>({
  get: () => (layer.value === "topology" ? legacyWindow(data.window.value) : data.window.value),
  set: (value) => (windowParam.value = value),
});
/** Topology draws from the latency rollups, which keep 1h, 24h and 7d; it offers only those. */
const windowsOffered = computed(() => (layer.value === "topology" ? data.offered.value.filter((w) => LEGACY_WINDOWS.includes(w)) : data.offered.value));
const matrix = computed(() => data.matrix.value);
const nodes = computed(() => nodesQuery.data.value ?? []);

/**
 * The newest failure of a check on one source, from the monitors list's
 * newest results: the server sends a down path without a reason, and the
 * error the agent wrote is the reason the operator needs.
 */
function failureOf(monitorId: string, source: string): string | undefined {
  const monitor = (monitorsQuery.data.value ?? []).find((m) => m.id === monitorId);
  const latest = monitor?.latest?.find((l) => (l.node_id ?? "") === source);
  return latest && !latest.success && !latest.reason ? latest.error || undefined : undefined;
}

/** When a node last reported, for an offline source in the attention list. */
function nodeSeen(id: string): string | undefined {
  return nodes.value.find((n) => n.id === id)?.last_seen || undefined;
}

/** The path set exists and has no source: nothing is measured, and the empty state says why. */
const noSources = computed(() => {
  const plan = data.planQuery.data.value;
  return !!plan && plan.stored && (plan.config.sources ?? []).length === 0;
});

/** Topology reads the latency rollups; when the page window is one they do not keep, say what it shows. */
const topologyNote = computed(() =>
  layer.value === "topology" && !LEGACY_WINDOWS.includes(data.window.value)
    ? t("fleet.monitoring.window.topologyNote", { window: t(`fleet.monitoring.window.long.${legacyWindow(data.window.value)}`) })
    : "",
);

/* ---- Head ---- */

const incidentCounts = computed(() => filterCounts(incidentsQuery.data.value?.incidents ?? [], now.value.getTime()));
const criticalOpen = computed(() =>
  (incidentsQuery.data.value?.incidents ?? []).some((i) => i.state === "open" && i.severity === "critical" && !isSnoozed(i, now.value.getTime()) && !i.maintenance),
);
const operatorChecks = computed(() => operatorMonitors(monitorsQuery.data.value ?? []));
const healthOf = (m: MonitorView) =>
  withPathVerdict(monitorHealth(m, m.latest, monitorsQuery.lastUpdated.value ?? Date.now()), (matrix.value?.paths ?? []).filter((p) => p.monitorId === m.id));
const failingChecks = computed(() => failingMonitors(operatorChecks.value, healthOf));

const pathsProof = useProof(data.pathsQuery);
const monitorsProof = useProof(monitorsQuery);
const incidentsProof = useProof(incidentsQuery);
const proof = computed(() => (layer.value === "incidents" ? incidentsProof.value : layer.value === "checks" ? monitorsProof.value : pathsProof.value));

function pathsLink(q: string) {
  return { name: "monitoring", query: { ...owned.query(), view: "paths", "paths.q": q, path: undefined } };
}

const proofSegments = computed<ProofSegment[]>(() => {
  if (layer.value === "incidents") {
    const c = incidentCounts.value;
    const out: ProofSegment[] = [{ key: "open", text: t("fleet.keepalive.proof.open", { n: c.open }, c.open), tone: c.open > 0 ? (criticalOpen.value ? "destructive" : "warning") : undefined }];
    if (c.acknowledged) out.push({ key: "acked", text: t("fleet.keepalive.proof.acknowledged", { n: c.acknowledged }) });
    if (c.snoozed) out.push({ key: "snoozed", text: t("fleet.keepalive.proof.snoozed", { n: c.snoozed }) });
    if (c.pending) out.push({ key: "pending", text: t("fleet.keepalive.proof.pending", { n: c.pending }) });
    return out;
  }
  if (layer.value === "checks") {
    const all = monitorsQuery.data.value ?? [];
    const out: ProofSegment[] = [{ key: "checks", text: t("fleet.monitoring.checks.proof.checks", { n: all.length }, all.length) }];
    const generated = all.length - operatorChecks.value.length;
    if (generated) out.push({ key: "generated", text: t("fleet.monitoring.checks.proof.generated", { n: generated }) });
    if (failingChecks.value.length) out.push({ key: "failing", tone: "destructive", text: t("fleet.monitoring.proof.failing", { n: failingChecks.value.length }) });
    return out;
  }
  const m = matrix.value;
  if (!m) return [];
  const out: ProofSegment[] = [{ key: "paths", tone: "strong", text: t("fleet.monitoring.paths.proof.paths", { n: m.counts.paths }, m.counts.paths) }];
  const sources = reachBySource(m).filter((r) => r.total > 0).length;
  if (sources > 1) out.push({ key: "sources", text: t("fleet.monitoring.paths.proof.sources", { n: sources }, sources) });
  if (m.counts.down) out.push({ key: "down", tone: "destructive", text: t("fleet.monitoring.paths.proof.down", { n: m.counts.down }), to: pathsLink("state:down") });
  if (m.counts.unknown) out.push({ key: "unknown", tone: "warning", text: t("fleet.monitoring.paths.proof.unknown", { n: m.counts.unknown }), to: pathsLink("state:unknown") });
  if (m.counts.paused) out.push({ key: "paused", tone: "muted", text: t("fleet.monitoring.paths.proof.paused", { n: m.counts.paused }), to: pathsLink("state:paused") });
  if (data.source.value === "legacy") out.push({ key: "legacy", tone: "muted", text: t("fleet.monitoring.paths.proof.legacy") });
  return out;
});

const layerTabs = computed<LayerTab<MonitoringLayer>[]>(() => [
  {
    value: "overview",
    label: t("fleet.monitoring.layers.overview"),
    count: matrix.value?.counts.down || undefined,
    tone: matrix.value?.counts.down ? "destructive" : "default",
  },
  { value: "paths", label: t("fleet.monitoring.layers.paths") },
  {
    value: "checks",
    label: t("fleet.monitoring.layers.checks"),
    count: failingChecks.value.length || undefined,
    tone: failingChecks.value.length ? "destructive" : "default",
  },
  { value: "topology", label: t("fleet.monitoring.layers.topology") },
  {
    value: "incidents",
    label: t("fleet.monitoring.layers.incidents"),
    count: incidentCounts.value.open || undefined,
    tone: incidentCounts.value.open > 0 ? (criticalOpen.value ? "destructive" : "warning") : "default",
  },
]);

/**
 * On a server whose matrix holds latency paths only, Overview still names the
 * operator checks that fail or went quiet, as the Monitors layer did.
 */
const legacyCheckAttention = computed<AttentionItem[]>(() => {
  if (data.source.value !== "legacy") return [];
  return failingChecks.value.map(({ monitor, failing, total }) => ({
    key: `check:${monitor.id}`,
    tone: "danger" as const,
    claim: t("fleet.monitoring.attention.failing", { name: monitor.name || monitor.id }),
    proof: [
      total > 1 ? t("fleet.monitoring.status.failingOn", { n: failing, total }) : t("fleet.monitoring.status.failing"),
      (() => {
        const h = healthOf(monitor);
        return h.kind === "failing" ? t("fleet.monitoring.status.lastResult", { age: formatRelativeTime(h.lastAt) }) : "";
      })(),
    ]
      .filter(Boolean)
      .join(" · "),
    action: { label: t("fleet.monitoring.attention.open"), run: () => openCheck(monitor.id) },
  }));
});

/* ---- Editors ---- */

const editorOpen = ref(false);
const editorMonitor = ref<MonitorView | undefined>();
const editorType = ref<MonitorType | undefined>();
const pathSetOpen = ref(false);
const retentionOpen = ref(false);

/**
 * An editor never opens over another sheet: below 768 px both are modal, and
 * two modal sheets at once fight over focus and the page (reka-ui's layers
 * loop). The check or path sheet it was opened from closes first, after its
 * exit, and comes back when the editor closes without saving.
 */
let returnTo: { open?: string; path?: string } | null = null;
const SHEET_EXIT_MS = 220;

function fromSheet(then: () => void): void {
  const query = owned.query();
  const open = typeof query.open === "string" ? query.open : undefined;
  const path = typeof query.path === "string" ? query.path : undefined;
  if (!open && !path) {
    returnTo = null;
    then();
    return;
  }
  returnTo = { open, path };
  owned.replace({ ...query, open: undefined, path: undefined });
  window.setTimeout(then, SHEET_EXIT_MS);
}

function backToSheet(): void {
  const back = returnTo;
  returnTo = null;
  if (back) window.setTimeout(() => owned.replace({ ...owned.query(), open: back.open, path: back.path }), SHEET_EXIT_MS);
}

function openCreate(type?: MonitorType): void {
  fromSheet(() => {
    editorMonitor.value = undefined;
    editorType.value = type;
    editorOpen.value = true;
  });
}

function openEdit(monitor: MonitorView): void {
  fromSheet(() => {
    editorMonitor.value = monitor;
    editorType.value = undefined;
    editorOpen.value = true;
  });
}

function openPathSet(): void {
  fromSheet(() => (pathSetOpen.value = true));
}

function openRetention(): void {
  fromSheet(() => (retentionOpen.value = true));
}

function openCheck(id: string): void {
  owned.push({ ...owned.query(), view: "checks", open: id, path: undefined });
}

/** The new or edited check opens once the list holds it, so its sheet never says it is gone. */
async function onCheckSaved(id: string): Promise<void> {
  // The saved check opens instead of the sheet the editor came from.
  returnTo = null;
  await monitorsQuery.refresh();
  openCheck(id);
  data.refresh();
}

const plan = computed(() => data.planQuery.data.value);
/**
 * Whether the server speaks design 29 M2a, read from its answers (the
 * node list's probe_methods, else the plan's pair methods), as M1 reads the
 * paths route: a server without it is offered nothing it cannot take.
 */
const m2a = computed(() => serverSpeaksM2a(nodesQuery.data.value, plan.value, monitorsQuery.data.value));
const shortestIntervalSec = computed(() => {
  const list = (monitorsQuery.data.value ?? []).filter((m) => m.enabled).map((m) => m.interval_sec);
  return list.length ? Math.min(...list) : undefined;
});

function refreshAll(): void {
  if (canReadMonitors.value) {
    void monitorsQuery.refresh();
    void incidentsQuery.refresh();
    data.refresh();
  }
  if (canReadNodes.value) void nodesQuery.refresh();
}

const refreshing = computed(() => monitorsQuery.refreshing.value || data.pathsQuery.refreshing.value);
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.monitoring.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.monitoring.description') }}</p>
        <ProofLine v-if="canReadMonitors && layer !== 'topology'" v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
        <p v-if="topologyNote" class="text-xs text-muted-foreground" data-testid="topology-window-note">{{ topologyNote }}</p>
      </template>
      <template v-if="canReadMonitors" #actions>
        <Button v-if="canAdminMonitors && layer === 'checks' && plan" variant="outline" size="sm" type="button" data-testid="pathset-open" @click="openPathSet">
          <Settings2 class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.checks.actions.pathSet') }}
        </Button>
        <Button v-if="canAdminMonitors && layer === 'checks'" size="sm" type="button" data-testid="check-create" @click="openCreate()">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.checks.actions.create') }}
        </Button>
        <Button v-if="layer !== 'topology'" variant="outline" size="sm" type="button" :disabled="refreshing" @click="refreshAll">
          <RefreshCw :class="cn('size-4', refreshing && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <!-- Last, so it holds the header's end whatever the layer's own buttons are. -->
        <WindowControl v-if="layer !== 'incidents'" v-model="windowModel" :offered="windowsOffered" :label="$t('fleet.monitoring.window.label')" />
      </template>
    </PageHeader>

    <EmptyState v-if="!canReadMonitors" :icon="RadioTower" :title="$t('fleet.monitoring.noAccessTitle')" :description="$t('fleet.monitoring.noAccessDescription')" />

    <template v-else>
      <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('fleet.monitoring.layers.label')" />

      <OverviewLayer
        v-if="layer === 'overview'"
        :owned="owned"
        :data="data"
        :window="data.window.value"
        :can-admin="canAdminMonitors"
        :check-attention="legacyCheckAttention"
        :failure-of="failureOf"
        :node-seen="nodeSeen"
        :no-sources="noSources"
        @path-set="openPathSet"
        @create-check="openCreate()"
      />

      <PathsLayer
        v-if="layer === 'paths'"
        :owned="owned"
        :data="data"
        :monitors="monitorsQuery.data.value ?? []"
        :can-admin="canAdminMonitors"
        :window="data.window.value"
        :offered="data.offered.value"
        :failure-of="failureOf"
        :no-sources="noSources"
        @path-set="openPathSet"
        @create-check="openCreate()"
        @open-check="openCheck"
        @changed="refreshAll"
        @window="(w) => (windowParam = w)"
      />

      <ChecksLayer
        v-if="layer === 'checks'"
        :owned="owned"
        :data="data"
        :monitors-query="monitorsQuery"
        :nodes="nodes"
        :can-admin="canAdminMonitors"
        :window="data.window.value"
        :offered="data.offered.value"
        @window="(w) => (windowParam = w)"
        @create="openCreate"
        @edit="openEdit"
        @path-set="openPathSet"
        @retention="openRetention"
        @changed="refreshAll"
      />

      <TopologyLayer
        v-if="layer === 'topology'"
        :owned="owned"
        :nodes-query="nodesQuery"
        :monitors-query="monitorsQuery"
        :incidents-query="incidentsQuery"
        @layer="(next) => (layer = next)"
        @refresh-page="refreshAll"
        @open-monitor="(id) => openCheck(id)"
      />

      <KeepaliveLayer
        v-if="layer === 'incidents'"
        :owned="owned"
        :response="incidentsQuery.data.value"
        :error="incidentsQuery.error.value"
        :loading="incidentsQuery.loading.value"
        :nodes="nodes"
        :monitor-names="monitorNames"
        :now="now.getTime()"
        @refresh="incidentsQuery.refresh()"
      />
    </template>

    <CheckEditorSheet
      v-if="canAdminMonitors"
      :open="editorOpen"
      :monitor="editorMonitor"
      :initial-type="editorType"
      :nodes="nodes"
      :can-read-nodes="canReadNodes"
      :with-alert="data.source.value === 'paths'"
      :m2a="m2a && data.source.value === 'paths'"
      :monitors="monitorsQuery.data.value ?? []"
      :plan="plan"
      @close="editorOpen = false; backToSheet()"
      @saved="onCheckSaved"
      @reload="refreshAll"
    />
    <PathSetSheet
      v-if="canAdminMonitors && plan"
      :open="pathSetOpen"
      :plan="plan"
      :nodes="nodes"
      :m2a="m2a && data.source.value === 'paths'"
      @close="pathSetOpen = false; backToSheet()"
      @saved="(next) => { data.planQuery.data.value = next; data.refresh(); }"
      @reload="data.refresh"
    />
    <RetentionSheet
      v-if="data.settings.value"
      :open="retentionOpen"
      :settings="data.settings.value"
      :can-admin="canAdminMonitors"
      :shortest-interval-sec="shortestIntervalSec"
      @close="retentionOpen = false; backToSheet()"
      @saved="(next) => { data.settingsQuery.data.value = next; data.refresh(); }"
      @reload="data.refresh"
    />
  </div>
</template>
