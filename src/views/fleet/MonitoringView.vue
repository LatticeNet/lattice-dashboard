<script setup lang="ts">
/**
 * Monitoring (design 29 D7, design 32 D2): four layers on ?view=, Overview
 * the bare URL.
 *
 *   Overview   what needs a look, and how far each source reaches
 *   Network    every path, as a graph or a list, with one query; an edge or a
 *              row opens the path sheet in place, a node the node sheet
 *   Checks     every check in one list, the editor, the path set, history retention
 *   Incidents  the incidents the server holds
 *
 * One ?window= for the page (1h to 7d, and 14d when fine history is kept that
 * long). Old links keep working: ?view=paths and ?view=latency land on the
 * Network view's list (an old ?pair= on the path sheet), ?view=topology on
 * the Network view, ?view=monitors on Checks, the keepalive spelling on
 * Incidents, and a link that names a monitor or a node (?open=, ?node=, the
 * old /monitoring/:id) on Checks.
 *
 * Every count the page shows comes from the one matrix read (design 32 D1):
 * the proof line, Overview and the Network view say the same number.
 *
 * The page owns the reads every layer shares (monitors, nodes, incidents and
 * the path reads in usePathsData) and the editors, so Overview and Network
 * can open the path set or a check's editor without leaving for Checks first.
 */
import { computed, onBeforeUnmount, provide, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useNow } from "@vueuse/core";
import { Plus, RadioTower, RefreshCw, Settings2 } from "lucide-vue-next";

import { api, unwrap, type BeaconView, type CheckDefinitionList, type CheckDefinitionView, type GroupView, type IncidentListResponse, type MonitorType, type MonitorView, type MonitorWindow, type Node } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { toast } from "@/lib/toast";
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

import BeaconPlanSheet from "./BeaconPlanSheet.vue";
import CheckEditorSheet from "./CheckEditorSheet.vue";
import DefinitionEditorSheet from "./DefinitionEditorSheet.vue";
import ChecksLayer from "./ChecksLayer.vue";
import OverviewLayer from "./OverviewLayer.vue";
import PathSetSheet from "./PathSetSheet.vue";
import NetworkLayer from "./NetworkLayer.vue";
import RetentionSheet from "./RetentionSheet.vue";
import WindowControl from "./WindowControl.vue";
import { filterCounts, isSnoozed } from "./incidentsModel";
import { failingMonitors, monitorHealth, operatorMonitors } from "./monitorHealthModel";
import { DEFAULT_WINDOW, MONITORING_LAYERS, legacyMonitoringRedirect, parseWindow, reachBySource, type MonitoringLayer } from "./pathsModel";
import { usePathsData } from "./usePathsData";
import { isReachabilityCheck, replanMissingScopes, replanStep, replanSurface, type BeaconReplanItem } from "./beaconModel";
import { BEACON_REPLAN } from "./useBeaconReplan";
import { serverSpeaksM2a, serverSpeaksM2b } from "./checkRulesModel";
import { withPathVerdict } from "./checksModel";

const auth = useAuthStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const canReadMonitors = computed(() => auth.can("monitor:read"));
const canReadNodes = computed(() => auth.can("node:read"));
const canAdminMonitors = computed(() => auth.can("monitor:admin"));

// A beacon's reachability check (design 29 D12) is neither the operator's check nor a path: the node page's Beacon
// card shows its verdict, and nothing here lists it. It still sends packets, so the editor's budget counts it
// as the server does (monitorPacketLoad): `allMonitors` keeps it for that.
const allMonitors = shallowRef<MonitorView[]>([]);
const monitorsQuery = useAsyncData(
  (signal) =>
    canReadMonitors.value
      ? api.monitors.list({ signal }).then((r) => {
          const all = unwrap(r, "monitors");
          allMonitors.value = all;
          return all.filter((m) => !isReachabilityCheck(m));
        })
      : Promise.resolve([] as MonitorView[]),
  { pollInterval: 10000, immediate: canReadMonitors.value },
);
const nodesQuery = useAsyncData(
  (signal) => (canReadNodes.value ? api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")) : Promise.resolve([] as Node[])),
  { pollInterval: 15000, immediate: canReadNodes.value },
);
// Check definitions and Fleet mesh (design 32 D1): the Checks list's rows beside the single checks.
const definitionsQuery = useAsyncData<CheckDefinitionList>(
  (signal) => (canReadMonitors.value ? api.monitors.definitions.list({ signal }) : Promise.resolve<CheckDefinitionList>({ definitions: [] })),
  { pollInterval: canReadMonitors.value ? 15000 : 0, immediate: canReadMonitors.value },
);
const definitions = computed<CheckDefinitionView[]>(() => definitionsQuery.data.value?.definitions ?? []);
/** The definitions read failed before it ever answered: the list and the proof line must not read as if there were none. */
const definitionsUnread = computed(() => !!definitionsQuery.error.value && definitionsQuery.data.value === undefined);
// Node groups, for the target selector's group choices and names (design 32 D5).
const canReadGroups = computed(() => auth.can("group:read"));
const groupsQuery = useAsyncData<GroupView[]>((signal) => (canReadGroups.value ? api.groups.list({ signal }).then((r) => r.groups ?? []) : Promise.resolve([])), {
  pollInterval: 0,
  immediate: canReadGroups.value,
});
const groups = computed(() => groupsQuery.data.value ?? []);
/** A session with a node allowlist names nodes only: the server refuses a group or the whole fleet from it. */
const allowBroad = computed(() => {
  const list = auth.serverAllowlist ?? [];
  return list.length === 0 || list.includes("*");
});
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

// ?view=paths, ?view=topology, ?view=latency, ?view=monitors and the keepalive spelling, rewritten once.
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
  get: () => data.window.value,
  set: (value) => (windowParam.value = value),
});
/** Every layer reads the same matrix (design 29 D13), so all of them offer the same windows. */
const windowsOffered = computed(() => data.offered.value);
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

/* ---- A beacon's change plan (the server's replan) ---- */

/**
 * The path sheet, the check sheet and the attention list offer the change
 * plan a target's beacon needs. The page reads the node's beacon (the plan
 * sheet works from the applied settings and the current sources) and opens
 * the sheet on a change that keeps the port, bind address and endpoint: the
 * request the server words. The beacon's own word is newer than the paths
 * read, so it decides (beaconModel replanStep): a plan filed meanwhile is
 * offered for review instead of a second one, and a beacon that needs no
 * plan any more says so.
 *
 * The read belongs to the surface that asked (replanSurface: the layer and
 * its open sheet). Closing or leaving that surface cancels it, and a newer
 * click on another target's action replaces it, so a plan sheet never opens
 * over something the operator already left.
 */
const replanSheet = shallowRef<{ item: BeaconReplanItem; view: BeaconView; node: Pick<Node, "id" | "name" | "internal_ip" | "public_ip"> }>();
const replanSheetOpen = ref(false);
const replanOpening = ref<string>();
const nameOfNode = (id: string) => nodes.value.find((n) => n.id === id)?.name || matrix.value?.sources.find((s) => s.nodeId === id)?.name || undefined;
const replanSurfaceNow = computed(() => replanSurface(layer.value, owned.query()));
let replanRead: { controller: AbortController; surface: string } | undefined;
function cancelReplan(): void {
  replanRead?.controller.abort();
  replanRead = undefined;
  replanOpening.value = undefined;
}
watch(replanSurfaceNow, () => {
  if (replanRead) cancelReplan();
});
onBeforeUnmount(cancelReplan);
async function openReplan(item: BeaconReplanItem): Promise<void> {
  replanRead?.controller.abort();
  const read = { controller: new AbortController(), surface: replanSurfaceNow.value };
  replanRead = read;
  replanOpening.value = item.nodeId;
  const target = nameOfNode(item.nodeId) || item.name;
  let view: BeaconView;
  try {
    view = await api.nodes.beacon.get(item.nodeId, { signal: read.controller.signal });
  } catch (error) {
    if (replanRead !== read) return;
    cancelReplan();
    if (!owned.owns() || replanSurfaceNow.value !== read.surface) return;
    toast.error(t("fleet.monitoring.beacon.replan.failed", { target, reason: error instanceof Error ? error.message : String(error) }));
    return;
  }
  // Replaced by a newer click, or its surface closed or changed meanwhile: nothing opens.
  if (replanRead !== read) return;
  replanRead = undefined;
  replanOpening.value = undefined;
  if (!owned.owns() || replanSurfaceNow.value !== read.surface) return;
  const step = replanStep(view, target, !!matrix.value?.replansKnown);
  if (step.kind === "plan") {
    const node = nodes.value.find((n) => n.id === item.nodeId) ?? { id: item.nodeId, name: target };
    replanSheet.value = { item: step.item, view, node };
    fromSheet(() => (replanSheetOpen.value = true));
    return;
  }
  // The paths read was older than the beacon: read it again, so every surface offers what the beacon says.
  data.refresh();
  if (step.kind === "waits") {
    toast.info(t("fleet.monitoring.beacon.replan.waitsNow", { target }), {
      action: { label: t("fleet.monitoring.beacon.replan.review"), onClick: () => void router.push({ name: "approvals", query: { open: step.approvalId } }) },
    });
  } else {
    toast.info(t("fleet.monitoring.beacon.replan.settled", { target }));
  }
}
provide(BEACON_REPLAN, {
  replanFor: (nodeId) => (nodeId ? matrix.value?.replans.get(nodeId) : undefined),
  missing: (item) =>
    replanMissingScopes(item, { monitorAdmin: auth.can("monitor:admin"), nodeAdmin: auth.can("node:admin"), networkPlan: auth.can("network:plan"), netguardAdmin: auth.can("netguard:admin") }),
  nameOf: nameOfNode,
  open: (item) => void openReplan(item),
  opening: replanOpening,
});

/** The path set exists and has no source: nothing is measured, and the empty state says why. */
const noSources = computed(() => {
  const plan = data.planQuery.data.value;
  return !!plan && plan.stored && (plan.config.sources ?? []).length === 0;
});

/**
 * The node a generated check reaches, by check id, so a path.degraded
 * incident names and opens its path (design 29 D13): the check's own
 * target_node, else the node its generated paths in the matrix reach.
 */
const monitorTargets = computed(() => {
  const fromPaths = new Map<string, string>();
  for (const p of matrix.value?.paths ?? []) if (p.managed && p.targetNode && p.monitorId) fromPaths.set(p.monitorId, p.targetNode);
  return new Map((monitorsQuery.data.value ?? []).map((m) => {
    const generated = m.managed_by === "latency";
    return [m.id, { generated, targetNode: generated ? (m.target_node ?? fromPaths.get(m.id)) : undefined }];
  }));
});

/* ---- Head ---- */

const incidentCounts = computed(() => filterCounts(incidentsQuery.data.value?.incidents ?? [], now.value.getTime()));
const criticalOpen = computed(() =>
  (incidentsQuery.data.value?.incidents ?? []).some((i) => i.state === "open" && i.severity === "critical" && !isSnoozed(i, now.value.getTime()) && !i.maintenance),
);
const operatorChecks = computed(() => operatorMonitors(monitorsQuery.data.value ?? []));
const healthOf = (m: MonitorView) =>
  withPathVerdict(monitorHealth(m, m.latest, monitorsQuery.lastUpdated.value ?? Date.now()), (matrix.value?.paths ?? []).filter((p) => p.monitorId === m.id), m.latest);
const failingChecks = computed(() => failingMonitors(operatorChecks.value, healthOf));
/** Definitions with a down path, by the monitors they expanded into. */
const failingDefinitions = computed(() => {
  const down = new Set((matrix.value?.paths ?? []).filter((p) => p.state === "down").map((p) => p.monitorId));
  const failing = new Set<string>();
  for (const m of monitorsQuery.data.value ?? []) if (m.check_definition_id && down.has(m.id)) failing.add(m.check_definition_id);
  return failing.size;
});

const pathsProof = useProof(data.pathsQuery);
const monitorsProof = useProof(monitorsQuery);
const incidentsProof = useProof(incidentsQuery);
const proof = computed(() => (layer.value === "incidents" ? incidentsProof.value : layer.value === "checks" ? monitorsProof.value : pathsProof.value));

/** The Network view's list under a query: on the Network view already, the mode the operator chose stays. */
function pathsLink(q: string) {
  const query = owned.query();
  return { name: "monitoring", query: { ...query, view: "network", as: layer.value === "network" ? query.as : "list", "paths.q": q, path: undefined, peek: undefined } };
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
    // Rows as the list draws them: definitions and single checks; Fleet mesh is the built-in one beside them.
    const checks = definitions.value.length + operatorChecks.value.length;
    const out: ProofSegment[] = [{ key: "checks", text: t("fleet.monitoring.checks.proof.checks", { n: checks }, checks) }];
    if (definitionsUnread.value) out.push({ key: "definitions", tone: "warning", text: t("fleet.monitoring.checkDefs.proof.unread") });
    else if (definitions.value.length) out.push({ key: "definitions", text: t("fleet.monitoring.checkDefs.proof.definitions", { n: definitions.value.length }, definitions.value.length) });
    const failing = failingChecks.value.length + failingDefinitions.value;
    if (failing) out.push({ key: "failing", tone: "destructive", text: t("fleet.monitoring.proof.failing", { n: failing }) });
    return out;
  }
  const m = matrix.value;
  if (!m) return [];
  const out: ProofSegment[] = [{ key: "paths", tone: "strong", text: t("fleet.monitoring.paths.proof.paths", { n: m.counts.paths }, m.counts.paths) }];
  // Nodes that run a path, as the Network view's source picker counts them: the control plane is not one.
  const sources = reachBySource(m).filter((r) => r.source && r.total > 0).length;
  if (sources > 1) out.push({ key: "sources", text: t("fleet.monitoring.paths.proof.sources", { n: sources }, sources) });
  if (m.counts.down) out.push({ key: "down", tone: "destructive", text: t("fleet.monitoring.paths.proof.down", { n: m.counts.down }), to: pathsLink("state:down") });
  // Degraded after down, in the warning tone, only from a server that judges it (design 29 D13).
  if (m.judgesDegraded && m.counts.degraded) out.push({ key: "degraded", tone: "warning", text: t("fleet.monitoring.paths.proof.degraded", { n: m.counts.degraded }), to: pathsLink("state:degraded") });
  // Amber means degraded wherever a path state is shown: unknown is muted.
  if (m.counts.unknown) out.push({ key: "unknown", tone: "muted", text: t("fleet.monitoring.paths.proof.unknown", { n: m.counts.unknown }), to: pathsLink("state:unknown") });
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
  { value: "network", label: t("fleet.monitoring.layers.network") },
  {
    value: "checks",
    label: t("fleet.monitoring.layers.checks"),
    count: failingChecks.value.length || undefined,
    tone: failingChecks.value.length ? "destructive" : "default",
  },
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
/** The one "New check" flow (design 32 D1), which also edits a definition. */
const definitionEditorOpen = ref(false);
const definitionEditing = ref<CheckDefinitionView | undefined>();
const definitionType = ref<MonitorType | undefined>();
const pathSetOpen = ref(false);
const retentionOpen = ref(false);

/**
 * An editor never opens over another sheet: below 768 px both are modal, and
 * two modal sheets at once fight over focus and the page (reka-ui's layers
 * loop). The check or path sheet it was opened from closes first, after its
 * exit, and comes back when the editor closes without saving.
 */
let returnTo: { open?: string; path?: string; peek?: string } | null = null;
const SHEET_EXIT_MS = 220;

function fromSheet(then: () => void): void {
  const query = owned.query();
  const open = typeof query.open === "string" ? query.open : undefined;
  const path = typeof query.path === "string" ? query.path : undefined;
  // The Network view's node sheet (?peek=) is one of them: "New check" sits in that view's header.
  const peek = typeof query.peek === "string" ? query.peek : undefined;
  if (!open && !path && !peek) {
    returnTo = null;
    then();
    return;
  }
  returnTo = { open, path, peek };
  owned.replace({ ...query, open: undefined, path: undefined, peek: undefined });
  window.setTimeout(then, SHEET_EXIT_MS);
}

function backToSheet(): void {
  const back = returnTo;
  returnTo = null;
  if (back) window.setTimeout(() => owned.replace({ ...owned.query(), open: back.open, path: back.path, peek: back.peek }), SHEET_EXIT_MS);
}

/** New check: one check with a source set and a target set (design 32 D1). Single checks are only edited now. */
function openCreate(type?: MonitorType): void {
  fromSheet(() => {
    definitionEditing.value = undefined;
    definitionType.value = type === "http" || type === "tls" || type === "tcp" || type === "icmp" || type === "beacon" ? type : undefined;
    definitionEditorOpen.value = true;
  });
}

function openEditDefinition(definition: CheckDefinitionView): void {
  fromSheet(() => {
    definitionEditing.value = definition;
    definitionType.value = undefined;
    definitionEditorOpen.value = true;
  });
}

/** The saved definition opens on Checks once the list holds it. */
async function onDefinitionSaved(saved: CheckDefinitionView): Promise<void> {
  returnTo = null;
  await Promise.all([definitionsQuery.refresh(), monitorsQuery.refresh()]);
  openCheck(saved.id);
  data.refresh();
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
/** Whether it speaks M2b, the beacon, read the same way (checkRulesModel.serverSpeaksM2b). */
const m2b = computed(() => serverSpeaksM2b(nodesQuery.data.value, plan.value, monitorsQuery.data.value));
/**
 * Whether the server judges degraded (design 29 D13): its matrix carries
 * `degraded_at`, or a check or the path set already holds an M3 field (so an
 * editor opened before the first paths read, or while it fails, still shows
 * a stored down_and_degraded and its thresholds). Once seen it stays seen for
 * the page. Only then do the editors offer down and degraded and the
 * thresholds.
 */
const m3Seen = ref(false);
watch(
  () =>
    !!matrix.value?.judgesDegraded ||
    (monitorsQuery.data.value ?? []).some((m) => m.alert === "down_and_degraded" || !!m.degraded) ||
    (() => {
      const config = data.planQuery.data.value?.config;
      return !!config && (config.alert !== undefined || config.alert_after !== undefined || !!config.degraded);
    })(),
  (seen) => {
    if (seen) m3Seen.value = true;
  },
  { immediate: true },
);
const m3 = computed(() => data.source.value !== "legacy" && m3Seen.value);
/** A source's agent version, said on a path whose agent is too old. */
const agentOf = (id: string) => (nodesQuery.data.value ?? []).find((n) => n.id === id)?.agent_version;
const shortestIntervalSec = computed(() => {
  const list = (monitorsQuery.data.value ?? []).filter((m) => m.enabled).map((m) => m.interval_sec);
  return list.length ? Math.min(...list) : undefined;
});

/** Counts the page's refreshes, so the Network view rereads its own chains read with the rest. */
const refreshTick = ref(0);
function refreshAll(): void {
  refreshTick.value += 1;
  if (canReadMonitors.value) {
    void monitorsQuery.refresh();
    void definitionsQuery.refresh();
    void incidentsQuery.refresh();
    data.refresh();
  }
  if (canReadNodes.value) void nodesQuery.refresh();
  // Group edits change what a selector resolves to and how the picker reads it.
  if (canReadGroups.value) void groupsQuery.refresh();
}

const refreshing = computed(() => monitorsQuery.refreshing.value || data.pathsQuery.refreshing.value);
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.monitoring.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.monitoring.description') }}</p>
        <ProofLine v-if="canReadMonitors" v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template v-if="canReadMonitors" #actions>
        <Button v-if="canAdminMonitors && layer === 'checks' && plan" variant="outline" size="sm" type="button" data-testid="pathset-open" @click="openPathSet">
          <Settings2 class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.checks.actions.pathSet') }}
        </Button>
        <Button v-if="canAdminMonitors && (layer === 'checks' || layer === 'network')" size="sm" type="button" data-testid="check-create" @click="openCreate()">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.checks.actions.create') }}
        </Button>
        <Button variant="outline" size="sm" type="button" :disabled="refreshing" @click="refreshAll">
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

      <NetworkLayer
        v-if="layer === 'network'"
        :owned="owned"
        :data="data"
        :nodes-query="nodesQuery"
        :monitors="monitorsQuery.data.value ?? []"
        :incidents-query="incidentsQuery"
        :can-admin="canAdminMonitors"
        :window="data.window.value"
        :offered="data.offered.value"
        :failure-of="failureOf"
        :no-sources="noSources"
        :agent-of="agentOf"
        :refresh-tick="refreshTick"
        @path-set="openPathSet"
        @create-check="openCreate()"
        @edit-check="openEdit"
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
        :definitions="definitions"
        :fleet-mesh="definitionsQuery.data.value?.fleet_mesh"
        :definitions-loading="definitionsQuery.loading.value && definitionsQuery.data.value === undefined"
        :definitions-error="definitionsQuery.error.value?.message ?? null"
        :groups="groups"
        @window="(w) => (windowParam = w)"
        @create="openCreate"
        @edit="openEdit"
        @edit-definition="openEditDefinition"
        @path-set="openPathSet"
        @retention="openRetention"
        @changed="refreshAll"
        @retry-definitions="definitionsQuery.refresh"
      />

      <KeepaliveLayer
        v-if="layer === 'incidents'"
        :owned="owned"
        :response="incidentsQuery.data.value"
        :error="incidentsQuery.error.value"
        :loading="incidentsQuery.loading.value"
        :nodes="nodes"
        :monitor-names="monitorNames"
        :monitor-targets="monitorTargets"
        :now="now.getTime()"
        :degraded="!!matrix?.judgesDegraded"
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
      :m2b="m2b && data.source.value === 'paths'"
      :m3="m3"
      :monitors="allMonitors"
      :plan="plan"
      @close="editorOpen = false; backToSheet()"
      @saved="onCheckSaved"
      @reload="refreshAll"
    />
    <DefinitionEditorSheet
      v-if="canAdminMonitors"
      :open="definitionEditorOpen"
      :definition="definitionEditing"
      :initial-type="definitionType"
      :nodes="nodes"
      :groups="groups"
      :allow-broad="allowBroad"
      :m3="m3"
      @close="definitionEditorOpen = false; backToSheet()"
      @saved="onDefinitionSaved"
      @reload="refreshAll"
    />
    <PathSetSheet
      v-if="canAdminMonitors && plan"
      :open="pathSetOpen"
      :plan="plan"
      :nodes="nodes"
      :m2a="m2a && data.source.value === 'paths'"
      :m2b="m2b && data.source.value === 'paths'"
      :m3="m3"
      @close="pathSetOpen = false; backToSheet()"
      @saved="(next) => { data.planQuery.data.value = next; data.refresh(); }"
      @reload="data.refresh"
    />
    <BeaconPlanSheet
      v-if="replanSheet"
      :open="replanSheetOpen"
      action="change"
      :node="replanSheet.node"
      :view="replanSheet.view"
      :replan="replanSheet.item"
      @close="replanSheetOpen = false; backToSheet()"
      @filed="data.refresh()"
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
