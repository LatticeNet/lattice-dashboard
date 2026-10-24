<script setup lang="ts">
/**
 * Monitoring's Checks layer (design 29 D7, D9, design 32 D1): every check in
 * one list. Your checks come first: check definitions (one check with a
 * source set and a target set, with their path and paused-target counts) and
 * single checks side by side; then the built-in Fleet mesh, the path set,
 * which opens its own editor. A monitor a definition or the path set
 * generated is not a row of its own. A single check's row opens its sheet on
 * ?open=: its paths, one per source, and the path chart of the one chosen; a
 * definition's row opens the definition's sheet on the same parameter. Create
 * and edit open the editors the page hosts, so Overview and the Topology view
 * can open them too. Below the list, how long history is kept.
 *
 * A link that names a monitor (?open=, the old /monitoring/:id) or a node
 * (?node=, the node page's link) lands here.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery } from "@vueuse/core";
import { Activity, CircleAlert, Globe, History, LockKeyhole, Network, Pencil, RadioTower, Settings2, Trash2, Waypoints, X } from "lucide-vue-next";

import { api, type CheckDefinitionView, type CheckFleetMesh, type GroupView, type MonitorSettings, type MonitorView, type MonitorWindow, type Node } from "@/lib/api";
import { formatBytes, formatRelativeTime, shortId } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { AsyncData } from "@/composables/useAsyncData";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useListQuery, useQueryText } from "@/composables/useListQuery";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import { withoutSorts } from "@/lib/query/syntax";

import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ListQueryBar from "@/components/common/ListQueryBar.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import DefinitionSheet from "./DefinitionSheet.vue";
import PathDetail from "./PathDetail.vue";
import { PACKETS_DEFAULT, canEditCheck, checkSourceSummary, latestCertExpiry, multiPacket, sheetSource, withPathVerdict, type PickedSource } from "./checksModel";
import { CHECK_ROW_GROUP_ORDER, checkRowGroup, checkRowMethod, checkRowName, checkRows, describeSelector, pathsHealth, type CheckRow, type SelectorWords } from "./definitionsModel";
import { createConfirmReturn } from "./confirmFocus";
import { formatLoss, formatMs } from "./latencyModel";
import { failingMonitors, healthRank, monitorHealth, type MonitorHealth } from "./monitorHealthModel";
import { MONITORING_QUERY_EXAMPLES, checkRowsQuerySchema, type CheckRowFacts } from "./monitoringQuery";
import { isServerEvaluated } from "./monitorTypeModel";
import { stateRank, type PathAddress, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import { verdictFor } from "./triangulationModel";
import { EXPECT_STATUS_DEFAULT } from "./checkRulesModel";
import type { PathsData } from "./usePathsData";

const props = defineProps<{
  owned: OwnedRoute;
  data: PathsData;
  monitorsQuery: AsyncData<MonitorView[]>;
  nodes: Node[];
  canAdmin: boolean;
  window: MonitorWindow;
  /** The windows the page offers, for the sheet's own window control. */
  offered: MonitorWindow[];
  /** Check definitions (design 32 D1) and Fleet mesh, from the definitions read. */
  definitions: CheckDefinitionView[];
  fleetMesh?: CheckFleetMesh;
  definitionsLoading: boolean;
  /** Why the definitions read failed, while it has not answered since. */
  definitionsError?: string | null;
  groups: GroupView[];
}>();

const emit = defineEmits<{
  create: [type?: "http" | "tls" | "tcp"];
  edit: [monitor: MonitorView];
  editDefinition: [definition: CheckDefinitionView];
  pathSet: [];
  retention: [];
  changed: [];
  window: [window: MonitorWindow];
  retryDefinitions: [];
}>();

const { t } = useI18n();
const { stateLabel, displayLabel, whyText, reasonText, reasonShort } = usePathsCopy();
/** The server has the edit route: it answered the design 29 paths read. */
const serverEdits = computed(() => props.data.source.value === "paths");
const wide = useMediaQuery("(min-width: 768px)");

const all = computed(() => props.monitorsQuery.data.value ?? []);
const operator = computed(() => all.value.filter((m) => !m.managed_by));
/** The rows: definitions and single checks, then Fleet mesh; generated monitors are represented by those. */
const rows = computed<CheckRow[]>(() => checkRows(all.value, props.definitions, props.fleetMesh));

function nodeName(id: string): string {
  if (!id) return t("fleet.monitoring.result.controlPlane");
  return props.nodes.find((n) => n.id === id)?.name || shortId(id, 14);
}

/** Each check's paths in the matrix, for the verdict the control plane gives them. */
const pathsByMonitor = computed(() => {
  const out = new Map<string, PathItem[]>();
  for (const p of props.data.matrix.value?.paths ?? []) out.set(p.monitorId, [...(out.get(p.monitorId) ?? []), p]);
  return out;
});

function healthOf(monitor: MonitorView): MonitorHealth {
  return withPathVerdict(monitorHealth(monitor, monitor.latest, props.monitorsQuery.lastUpdated.value ?? Date.now()), pathsByMonitor.value.get(monitor.id) ?? [], monitor.latest);
}

/** Each definition's monitors, by the definition id the monitors list carries. */
const monitorsByDefinition = computed(() => {
  const out = new Map<string, MonitorView[]>();
  for (const m of all.value) if (m.check_definition_id) out.set(m.check_definition_id, [...(out.get(m.check_definition_id) ?? []), m]);
  return out;
});

/** A definition's paths in the matrix: the paths of the monitors it expanded into. */
function definitionPaths(definitionId: string): PathItem[] {
  return (monitorsByDefinition.value.get(definitionId) ?? []).flatMap((m) => pathsByMonitor.value.get(m.id) ?? []);
}

/** Fleet mesh's paths: the matrix's generated cells. */
const meshPaths = computed(() => (props.data.matrix.value?.paths ?? []).filter((p) => p.managed));

function rowHealth(row: CheckRow): MonitorHealth {
  const now = props.monitorsQuery.lastUpdated.value ?? Date.now();
  switch (row.kind) {
    case "check":
      return healthOf(row.monitor);
    case "definition":
      return pathsHealth(definitionPaths(row.definition.id), row.definition.enabled, now);
    case "fleet":
      return pathsHealth(meshPaths.value, row.mesh.enabled, now);
  }
}

function nameOfGroup(id: string): string {
  return props.groups.find((g) => g.id === id)?.name || id;
}

/** A selector as the row's From and To read it: "the whole fleet", "group edge, jp-1", "the whole fleet except hk-2". */
function selectorLabel(sel: CheckDefinitionView["sources"]): string {
  return describeSelector(sel, props.nodes, props.groups, selectorWords.value);
}

const selectorWords = computed<SelectorWords>(() => ({
  fleet: t("selector.wholeFleetInline"),
  group: (name) => t("fleet.monitoring.checkDefs.sheet.group", { name }),
  except: (base, names) => t("fleet.monitoring.checkDefs.sheet.except", { base, names }),
}));

function definitionTargets(def: CheckDefinitionView): string {
  const nodes = selectorLabel(def.targets);
  const addresses = def.addresses ?? [];
  const shown = addresses.length > 2 ? `${addresses.slice(0, 2).join(", ")} +${addresses.length - 2}` : addresses.join(", ");
  return [nodes, shown].filter(Boolean).join(", ");
}

/** The names of the nodes a row runs on, for the query's node field; undefined for the control plane. */
function rowNodes(row: CheckRow): string[] | undefined {
  switch (row.kind) {
    case "check":
      if (isServerEvaluated(row.monitor.type)) return undefined;
      return row.monitor.assign_all ? props.nodes.map((n) => n.name || n.id) : (row.monitor.node_ids ?? []).map(nodeName);
    case "definition": {
      if (row.definition.type === "tls") return undefined;
      const ids = new Set((monitorsByDefinition.value.get(row.definition.id) ?? []).flatMap((m) => m.node_ids ?? []));
      return [...ids].map(nodeName);
    }
    case "fleet":
      return [...new Set(meshPaths.value.map((p) => p.sourceName))];
  }
}

function rowFacts(row: CheckRow): CheckRowFacts {
  switch (row.kind) {
    case "check":
      return {
        name: row.monitor.name || row.monitor.id,
        id: row.monitor.id,
        type: String(row.monitor.type),
        targets: [row.monitor.target],
        nodes: rowNodes(row),
        interval: row.monitor.interval_sec,
        timeout: row.monitor.timeout_sec,
        enabled: row.monitor.enabled,
        managed: false,
        all: !!row.monitor.assign_all,
        health: rowHealth(row).kind,
      };
    case "definition":
      return {
        name: row.definition.name,
        id: row.definition.id,
        type: row.definition.type,
        targets: [...(row.definition.targets.nodes ?? []).map(nodeName), ...(row.definition.targets.groups ?? []).map(nameOfGroup), ...(row.definition.addresses ?? [])],
        nodes: rowNodes(row),
        interval: row.definition.interval_sec,
        timeout: row.definition.timeout_sec,
        enabled: row.definition.enabled,
        managed: false,
        all: !!row.definition.sources.all,
        health: rowHealth(row).kind,
      };
    case "fleet":
      return {
        name: row.mesh.name,
        id: row.key,
        type: row.mesh.method,
        targets: [...new Set(meshPaths.value.map((p) => p.targetName))],
        nodes: rowNodes(row),
        // Fleet mesh's schedule lives in its own editor; the list does not claim one.
        interval: undefined,
        timeout: undefined,
        enabled: row.mesh.enabled,
        managed: true,
        all: false,
        health: rowHealth(row).kind,
      };
  }
}

/* ---- The node filter (?node=, from the node page) ---- */

const nodeFilter = bindQueryParam(props.owned, "node", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value: string) => value || undefined,
});

const sorted = computed(() =>
  [...rows.value].sort((a, b) => {
    const group = CHECK_ROW_GROUP_ORDER.indexOf(checkRowGroup(a)) - CHECK_ROW_GROUP_ORDER.indexOf(checkRowGroup(b));
    if (group !== 0) return group;
    const rank = healthRank(rowHealth(a)) - healthRank(rowHealth(b));
    if (rank !== 0) return rank;
    return checkRowName(a).localeCompare(checkRowName(b));
  }),
);

/** Whether a row runs on, or measures, the node the node page linked with. */
function rowTouchesNode(row: CheckRow, id: string): boolean {
  switch (row.kind) {
    case "check":
      return !isServerEvaluated(row.monitor.type) && (!!row.monitor.assign_all || (row.monitor.node_ids ?? []).includes(id));
    case "definition":
      return (monitorsByDefinition.value.get(row.definition.id) ?? []).some((m) => (m.node_ids ?? []).includes(id) || m.target_node === id);
    case "fleet":
      return meshPaths.value.some((p) => p.source === id || p.targetNode === id);
  }
}

const listed = computed(() => {
  const id = nodeFilter.value;
  if (!id) return sorted.value;
  return sorted.value.filter((r) => rowTouchesNode(r, id));
});

/* ---- The query field (?monitors.q=, as before) ---- */

// Each row's facts once per change: the query reads about a dozen fields per row, and a
// definition's health walks all of its paths.
const factsByKey = computed(() => new Map(listed.value.map((r) => [r.key, rowFacts(r)])));
const querySchema = checkRowsQuerySchema<CheckRow>((row) => factsByKey.value.get(row.key) ?? rowFacts(row));
const storedQuery = bindQueryParam<string>(props.owned, "monitors.q", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => (value.trim() ? value : undefined),
});
const queryText = useQueryText(storedQuery);
const query = useListQuery(listed, querySchema, queryText);
const queryExamples = computed(() => MONITORING_QUERY_EXAMPLES.map((e) => ({ query: e.query, note: t(`fleet.monitoring.query.examples.${e.key}`) })));

/* ---- Attention: operator checks that fail or went quiet ---- */

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = failingMonitors(operator.value, healthOf).map(({ monitor, failing, total }) => ({
    key: `failing:${monitor.id}`,
    tone: "danger",
    claim: t("fleet.monitoring.attention.failing", { name: monitor.name || monitor.id }),
    proof: total > 1 ? t("fleet.monitoring.status.failingOn", { n: failing, total }) : t("fleet.monitoring.status.failing"),
    action: { label: t("fleet.monitoring.attention.open"), run: () => sheet.open(monitor.id) },
  }));
  // A definition reads failing from its paths: name it, with how many of them are down.
  for (const def of props.definitions) {
    const state = pathsHealth(definitionPaths(def.id), def.enabled, Date.now());
    if (state.kind !== "failing") continue;
    items.push({
      key: `failing:${def.id}`,
      tone: "danger",
      claim: t("fleet.monitoring.attention.failing", { name: def.name }),
      proof: t("fleet.monitoring.checkDefs.list.downOf", { n: state.failing, total: state.total }),
      action: { label: t("fleet.monitoring.attention.open"), run: () => sheet.open(def.id) },
    });
  }
  for (const monitor of operator.value) {
    const state = healthOf(monitor);
    if (state.kind !== "stale") continue;
    items.push({
      key: `stale:${monitor.id}`,
      tone: "warning",
      claim: t("fleet.monitoring.attention.stale", { name: monitor.name || monitor.id }),
      proof: t("fleet.monitoring.status.lastResult", { age: formatRelativeTime(state.lastAt) }),
      action: { label: t("fleet.monitoring.attention.open"), run: () => sheet.open(monitor.id) },
    });
  }
  return items;
});

/* ---- The table ---- */

function statusView(row: CheckRow): { text: string; detail?: string; title?: string; tone?: "success" | "warning" | "destructive"; textClass: string } {
  const state = rowHealth(row);
  const monitor = row.kind === "check" ? row.monitor : undefined;
  switch (state.kind) {
    case "disabled":
      return { text: t("fleet.monitoring.checks.paused"), textClass: "text-muted-foreground" };
    case "unread":
      return { text: t("overview.read.failed"), textClass: "text-muted-foreground" };
    // Unknown always says why (design 32 D1): no result yet, results that stopped, or what the runs measured.
    case "none":
      return { text: t("fleet.monitoring.paths.state.unknown"), detail: t("fleet.monitoring.status.none"), title: t("fleet.monitoring.status.none"), textClass: "text-muted-foreground" };
    case "failing":
      // "down", as Paths and Overview say it.
      return {
        text: state.total > 1 ? t("fleet.monitoring.checks.downOn", { n: state.failing, total: state.total }) : t("fleet.monitoring.paths.state.down"),
        tone: "destructive",
        textClass: "text-destructive font-medium",
      };
    case "degraded":
      // Amber means degraded wherever a path state is drawn (design 29 D13), here as on Paths.
      return {
        text: state.total > 1 ? t("fleet.monitoring.checks.degradedOn", { n: state.degraded, total: state.total }) : t("fleet.monitoring.paths.state.degraded"),
        detail: state.latencyMs !== undefined ? formatMs(state.latencyMs) : undefined,
        tone: "warning",
        textClass: "text-warning-text font-medium",
      };
    case "stale":
      // Muted, as unknown is everywhere: amber means degraded (design 29 D13).
      return { text: t("fleet.monitoring.paths.state.unknown"), detail: t("fleet.monitoring.status.lastResult", { age: formatRelativeTime(state.lastAt) }), title: t("fleet.monitoring.paths.reason.results_stopped"), textClass: "text-muted-foreground" };
    case "unmeasured":
      // Every source's newest run measured nothing (design 29 M2a): unknown with the reason, never down.
      return state.reasons
        ? { text: t("fleet.monitoring.checks.unmeasured"), detail: t("fleet.monitoring.checks.reasons", { n: state.reasons }), textClass: "text-muted-foreground" }
        : { text: t("fleet.monitoring.checks.unmeasured"), detail: reasonShort(state.reason), title: reasonText(state.reason), textClass: "text-muted-foreground" };
    case "up": {
      // A certificate check leads with the days left, the reason it exists; others with the newest latency.
      // A definition or Fleet mesh says how many of its paths are up and how many measure nothing yet.
      if (state.of !== undefined && state.of > state.total) {
        return {
          text: t("fleet.monitoring.checks.upOn", { n: state.total, total: state.of }),
          detail: t("fleet.monitoring.checks.unknownCount", { n: state.of - state.total }),
          tone: "success",
          textClass: "text-foreground",
        };
      }
      const days = monitor ? certDaysLeft(monitor) : undefined;
      const detail = days !== undefined ? (days < 0 ? t("fleet.monitoring.checks.certExpired") : t("fleet.monitoring.checks.certLeft", { n: days })) : state.latencyMs !== undefined ? formatMs(state.latencyMs) : undefined;
      return { text: t("fleet.monitoring.status.up"), detail, tone: "success", textClass: "text-foreground" };
    }
  }
}

const DAY_MS = 86_400_000;
/** Whole days until the certificate a tls check last read expires; undefined for other checks. */
function certDaysLeft(monitor: MonitorView): number | undefined {
  if (monitor.type !== "tls") return undefined;
  const expires = latestCertExpiry(monitor.latest);
  return expires === undefined ? undefined : Math.floor((expires - Date.now()) / DAY_MS);
}

/** A check's newest failure on one source, from the list's newest results. */
function failureOn(monitor: MonitorView | undefined, source: string): string | undefined {
  const latest = monitor?.latest?.find((l) => (l.node_id ?? "") === source);
  // A run with a reason measured nothing; it is not the failure.
  return latest && !latest.success && !latest.reason ? latest.error || undefined : undefined;
}

/**
 * A generated check's name without the "Latency to " every one of them
 * starts with: under the Path set group it says nothing, and on a phone it
 * pushed the part that differs out of the cell.
 */
function shownName(row: CheckRow): string {
  return checkRowName(row);
}

/** The line under a definition's or Fleet mesh's name: its paths and the targets it keeps paused. */
function nameDetail(row: CheckRow): string | undefined {
  if (row.kind === "definition") {
    const s = row.definition.summary;
    const paths = t("fleet.monitoring.checkDefs.list.paths", { n: s.paths }, s.paths);
    return s.paused_targets ? `${paths} · ${t("fleet.monitoring.checkDefs.list.paused", { n: s.paused_targets }, s.paused_targets)}` : paths;
  }
  if (row.kind === "fleet") {
    const paths = t("fleet.monitoring.checkDefs.list.paths", { n: row.mesh.paths }, row.mesh.paths);
    const note = t("fleet.monitoring.checkDefs.list.builtIn");
    return row.mesh.paused_targets ? `${note} · ${paths} · ${t("fleet.monitoring.checkDefs.list.paused", { n: row.mesh.paused_targets }, row.mesh.paused_targets)}` : `${note} · ${paths}`;
  }
  return undefined;
}

function rowTarget(row: CheckRow): string {
  switch (row.kind) {
    case "check":
      return row.monitor.target;
    case "definition":
      return definitionTargets(row.definition);
    case "fleet":
      return t("fleet.monitoring.checkDefs.list.meshTargets", { n: row.mesh.targets }, row.mesh.targets);
  }
}

function rowAssignment(row: CheckRow): string {
  switch (row.kind) {
    case "check":
      return assignmentLabel(row.monitor);
    case "definition":
      return row.definition.type === "tls" ? t("fleet.monitoring.assignment.controlPlane") : selectorLabel(row.definition.sources);
    case "fleet":
      return t("fleet.monitoring.assignment.nodeCount", { count: row.mesh.sources }, row.mesh.sources);
  }
}

function rowInterval(row: CheckRow): string | undefined {
  if (row.kind === "fleet") return undefined;
  const interval = row.kind === "check" ? row.monitor.interval_sec : row.definition.interval_sec;
  const timeout = row.kind === "check" ? row.monitor.timeout_sec : row.definition.timeout_sec;
  return t("fleet.monitoring.definitions.interval", { interval: cadence(interval), timeout: cadence(timeout) });
}

/** The row a sheet shows, by the open id: a definition's id, or a monitor's. */
function rowKeyOf(openId: string | null | undefined): string | null {
  if (!openId) return null;
  return openId.startsWith("chk_") ? `def:${openId}` : openId;
}

function openRow(row: CheckRow, el?: HTMLElement): void {
  if (row.kind === "fleet") emit("pathSet");
  else sheet.open(row.kind === "definition" ? row.definition.id : row.monitor.id, el);
}

function cadence(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return t("fleet.monitoring.definitions.unit.h", { n: seconds / 3600 });
  if (seconds >= 60 && seconds % 60 === 0) return t("fleet.monitoring.definitions.unit.m", { n: seconds / 60 });
  return t("fleet.monitoring.definitions.unit.s", { n: seconds });
}

function assignmentLabel(monitor: MonitorView): string {
  if (isServerEvaluated(monitor.type)) return t("fleet.monitoring.assignment.controlPlane");
  // The same sources the check's sheet lists: its own and any its paths name, and how many measure nothing.
  const summary = checkSourceSummary(monitor, pathsByMonitor.value.get(monitor.id) ?? []);
  const withUnmeasured = (base: string) => (summary.unmeasured ? t("fleet.monitoring.checks.withUnmeasured", { base, n: summary.unmeasured }) : base);
  if (monitor.assign_all) return withUnmeasured(t("fleet.monitoring.assignment.allNodes"));
  const count = summary.ids.length;
  // A generated check whose every path is paused runs on no source.
  if (count === 0) return t("fleet.monitoring.checks.noneRunning");
  const paused = (monitor.paused_node_ids ?? []).length;
  const base = count === 1 ? nodeName(summary.ids[0]!) : t("fleet.monitoring.assignment.nodeCount", { count }, count);
  return withUnmeasured(paused ? t("fleet.monitoring.checks.withPaused", { base, n: paused }) : base);
}

const columns = computed<DataTableColumn<CheckRow>[]>(() => [
  // A long name wraps inside a capped column rather than squeezing To and From.
  { key: "name", label: t("fleet.monitoring.checks.table.name"), sortable: true, searchable: true, wrap: true, class: "max-w-80", value: (r) => checkRowName(r) },
  { key: "status", label: t("fleet.monitoring.table.status"), sortable: true, value: (r) => healthRank(rowHealth(r)) },
  { key: "type", label: t("fleet.monitoring.checks.table.method"), sortable: true, searchable: true, value: (r) => checkRowMethod(r) },
  { key: "target", label: t("fleet.monitoring.checkDefs.list.to"), searchable: true, value: (r) => rowTarget(r) },
  { key: "assignment", label: t("fleet.monitoring.checks.table.from"), value: (r) => rowAssignment(r) },
  { key: "interval", label: t("fleet.monitoring.table.every"), sortable: true, value: (r) => (r.kind === "check" ? r.monitor.interval_sec : r.kind === "definition" ? r.definition.interval_sec : 0) },
  { key: "actions", label: "", class: "w-12 max-md:w-11 max-md:px-0", pin: "end" },
]);

const confirmReturn = createConfirmReturn();
const deleteTarget = ref<MonitorView | undefined>();
const deleteOpen = ref(false);
const deletePending = ref(false);

function requestDelete(monitor: MonitorView): void {
  confirmReturn.remember(monitor.id);
  deleteTarget.value = monitor;
  deleteOpen.value = true;
}

async function deleteMonitor(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deletePending.value = true;
  try {
    await api.monitors.delete(target.id);
    toast.success(t("fleet.monitoring.toast.deleted"));
    deleteOpen.value = false;
    if (sheet.openId.value === target.id) sheet.close();
    emit("changed");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}

const deleteImpact = computed(() => {
  const m = deleteTarget.value;
  if (!m) return [];
  const lines = [t("fleet.monitoring.confirm.impactHistory")];
  if (m.type === "tls") lines.push(t("fleet.monitoring.confirm.impactUpcoming"));
  return lines;
});

function menuFor(row: CheckRow): RowMenuItem[] {
  if (row.kind === "fleet") {
    return [{ key: "pathset", label: t("fleet.monitoring.checkDefs.list.editMesh"), icon: Settings2, hidden: !props.canAdmin, run: () => emit("pathSet") }];
  }
  if (row.kind === "definition") {
    return [{ key: "edit", label: t("fleet.monitoring.checks.actions.edit"), icon: Pencil, hidden: !props.canAdmin, run: () => emit("editDefinition", row.definition) }];
  }
  const monitor = row.monitor;
  if (monitor.managed_by) {
    return [{ key: "pathset", label: t("fleet.monitoring.paths.sheet.editPathSet"), icon: Settings2, hidden: !props.canAdmin, run: () => emit("pathSet") }];
  }
  return [
    {
      key: "edit",
      label: t("fleet.monitoring.checks.actions.edit"),
      icon: Pencil,
      // Until the paths read says which server this is, Edit is neither offered nor refused.
      hidden: !props.canAdmin || props.data.source.value === "unknown",
      disabled: !canEditCheck(monitor, serverEdits.value),
      reason: canEditCheck(monitor, serverEdits.value) ? undefined : t("fleet.monitoring.checks.editUnavailable"),
      run: () => emit("edit", monitor),
    },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !props.canAdmin, run: () => requestDelete(monitor) },
  ];
}

/* ---- The check sheet ---- */

const sheet = bindRouteOpen(props.owned);
/** A definition's id opens the definition's sheet; a monitor's, the check sheet. */
const definitionOpen = computed(() => !!sheet.openId.value?.startsWith("chk_"));
const openDefinition = computed(() => (definitionOpen.value ? props.definitions.find((d) => d.id === sheet.openId.value) : undefined));
const openDefinitionPaths = computed(() => (openDefinition.value ? definitionPaths(openDefinition.value.id) : []));
const selected = computed(() => (sheet.openId.value && !definitionOpen.value ? all.value.find((m) => m.id === sheet.openId.value) : undefined));

/**
 * The open check's M2a settings (design 29): its target node, packets,
 * expected statuses and headers. A secret header reads "set", never a value,
 * because the server never sends one.
 */
const settingsRows = computed(() => {
  const m = selected.value;
  if (!m) return [];
  const rows: { key: string; label: string; value: string; mono?: boolean; heading?: boolean }[] = [];
  if (m.target_node) rows.push({ key: "node", label: t("fleet.monitoring.checks.sheet.targetNode"), value: t("fleet.monitoring.checks.sheet.targetNodeValue", { name: nodeName(m.target_node), endpoint: m.target || t("common.misc.none") }) });
  if (multiPacket(m.type)) rows.push({ key: "packets", label: t(m.type === "beacon" ? "fleet.monitoring.checks.editor.packetsBeacon" : "fleet.monitoring.checks.editor.packets"), value: String(m.packets && m.packets > 0 ? m.packets : PACKETS_DEFAULT), mono: true });
  if (m.type === "http" && (m.expect_status !== undefined || m.headers?.length || m.secrets_origin)) {
    rows.push({ key: "status", label: t("fleet.monitoring.checks.editor.expectStatus.label"), value: m.expect_status || EXPECT_STATUS_DEFAULT, mono: true });
  }
  if (m.headers?.length) rows.push({ key: "headers", label: t("fleet.monitoring.checks.editor.headers.title"), value: "", heading: true });
  for (const [i, h] of (m.headers ?? []).entries()) {
    rows.push({ key: `header-${i}`, label: h.name, value: h.secret ? t("fleet.monitoring.checks.sheet.secretSet") : (h.value ?? ""), mono: true });
  }
  if (m.secrets_origin) rows.push({ key: "origin", label: t("fleet.monitoring.checks.sheet.secretsOrigin"), value: m.secrets_origin, mono: true });
  return rows;
});
const sheetState = computed(() => {
  if (!sheet.openId.value) return "loading" as const;
  if (props.monitorsQuery.data.value === undefined) {
    return props.monitorsQuery.error.value && !props.monitorsQuery.loading.value ? ("failed" as const) : ("loading" as const);
  }
  if (!selected.value) return "gone" as const;
  return props.monitorsQuery.error.value ? ("stale" as const) : ("ready" as const);
});

interface SourceRow {
  source: string;
  name: string;
  path?: PathItem;
  /** From the check's newest results, when the server has no paths read. */
  latest?: { success: boolean; latencyMs?: number; at: string; error?: string; reason?: string };
  paused: boolean;
}

/** One row per source of the open check: its path when the matrix has it, else its newest result. */
const sourceRows = computed<SourceRow[]>(() => {
  const m = selected.value;
  if (!m) return [];
  const paths = (props.data.matrix.value?.paths ?? []).filter((p) => p.monitorId === m.id);
  const paused = new Set(m.paused_node_ids ?? []);
  if (paths.length) {
    return paths
      .map((p) => ({ source: p.source, name: p.sourceName, path: p, paused: paused.has(p.source) }))
      .sort((a, b) => stateRank(a.path.state) - stateRank(b.path.state) || a.name.localeCompare(b.name));
  }
  const fromLatest: SourceRow[] = (m.latest ?? []).map((l) => ({
    source: l.node_id ?? "",
    name: nodeName(l.node_id ?? ""),
    latest: { success: l.success, latencyMs: l.latency_ms, at: l.at, error: l.error, reason: l.reason },
    paused: paused.has(l.node_id ?? ""),
  }));
  // Every source the check names is listed, with no result yet when it never reported (an agent too old for the method among them).
  const reported = new Set(fromLatest.map((r) => r.source));
  const configured = isServerEvaluated(m.type) ? [] : m.assign_all ? props.nodes.map((n) => n.id) : (m.node_ids ?? []);
  const silent: SourceRow[] = configured.filter((id) => !reported.has(id)).map((id) => ({ source: id, name: nodeName(id), paused: paused.has(id) }));
  const rank = (r: SourceRow) => (r.latest ? Number(r.latest.success) : 2);
  return [...fromLatest, ...silent].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
});

/**
 * The source a check sheet opens on: the worst one that is measured (down
 * before up, the higher loss first), never a paused one while a measured
 * source exists, so the chart shows something to read.
 */
function defaultSource(rows: SourceRow[]): string | undefined {
  // A newest run with a reason measured nothing (design 29 M2a): it is not the source to open on.
  const measured = rows.filter((r) => !r.paused && (r.path ? r.path.state !== "unknown" : !!r.latest && !r.latest.reason));
  const pool = measured.length ? measured : rows.filter((r) => !r.paused).length ? rows.filter((r) => !r.paused) : rows;
  const rank = (r: SourceRow) => (r.path ? stateRank(r.path.state) : r.latest && !r.latest.success && !r.latest.reason ? 0 : 2);
  return [...pool].sort((a, b) => rank(a) - rank(b) || (b.path?.loss ?? 0) - (a.path?.loss ?? 0) || a.name.localeCompare(b.name))[0]?.source;
}

const chosenSource = ref<string | undefined>();
/** The operator's pick, kept while the sheet steps aside for a plan or the editor (checksModel sheetSource). */
let pickedSource: PickedSource | null = null;
watch(
  () => [sheet.openId.value, sourceRows.value.map((r) => r.source).join(",")] as const,
  () => {
    const next = sheetSource(sheet.openId.value, sourceRows.value.map((r) => r.source), chosenSource.value, pickedSource, () => defaultSource(sourceRows.value));
    pickedSource = next.picked;
    chosenSource.value = next.source;
  },
  { immediate: true },
);
function pickSource(source: string): void {
  chosenSource.value = source;
  pickedSource = sheet.openId.value ? { check: sheet.openId.value, source } : null;
}
const chosenRow = computed(() => sourceRows.value.find((r) => r.source === chosenSource.value));
const chosenAddress = computed<PathAddress | undefined>(() => {
  const m = selected.value;
  const row = chosenRow.value;
  if (!m || !row) return undefined;
  if (m.managed_by && row.path?.targetNode) return { source: row.source, targetNode: row.path.targetNode };
  return { source: row.source, monitorId: m.id };
});

/* ---- Retention ---- */

const settings = computed<MonitorSettings | undefined>(() => props.data.settings.value);
</script>

<template>
  <div class="space-y-4">
    <AttentionList :items="attention" />

    <!-- Nothing at all yet: one sentence and the watches worth starting with. -->
    <section
      v-if="monitorsQuery.data.value !== undefined && !definitionsLoading && !definitionsError && rows.length === 0"
      class="rounded-lg border border-dashed border-border px-5 py-8 text-center"
      aria-labelledby="checks-empty"
    >
      <RadioTower class="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
      <h2 id="checks-empty" class="mt-3 text-sm font-medium">{{ $t('fleet.monitoring.checks.empty.title') }}</h2>
      <p class="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        {{ canAdmin ? $t('fleet.monitoring.checks.empty.description') : $t('fleet.monitoring.definitions.emptyReadOnly') }}
      </p>
      <div v-if="canAdmin" class="mt-4 flex flex-wrap justify-center gap-2">
        <Button size="sm" type="button" @click="emit('create', 'http')">
          <Globe class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.empty.http') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="emit('create', 'tls')">
          <LockKeyhole class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.empty.tls') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="emit('pathSet')">
          <Settings2 class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.paths.empty.pathSet') }}
        </Button>
      </div>
    </section>

    <div v-if="nodeFilter && rows.length" class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        class="inline-flex max-w-full items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-foreground hover:bg-primary/20 pointer-coarse:min-h-11"
        :aria-label="$t('fleet.monitoring.nodeFilter.remove', { node: nodeName(nodeFilter) })"
        @click="nodeFilter = ''"
      >
        <span class="truncate">{{ $t('fleet.monitoring.nodeFilter.chip', { node: nodeName(nodeFilter) }) }}</span>
        <X class="size-3 shrink-0" aria-hidden="true" />
      </button>
      <span class="tabular">{{ $t('fleet.monitoring.nodeFilter.showing', { shown: listed.length, total: rows.length }) }}</span>
    </div>

    <ListQueryBar
      v-if="rows.length"
      v-model="queryText"
      class="max-w-3xl"
      storage-key="monitors"
      testid="monitors-query"
      :query="query"
      :count="query.filtering.value ? { shown: query.rows.value.length, total: listed.length } : undefined"
      :label="$t('fleet.monitoring.query.label')"
      :placeholder="$t('fleet.monitoring.query.placeholder')"
      :examples="queryExamples"
    />

    <div
      v-if="definitionsError && !definitions.length"
      role="alert"
      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border px-3 py-2 text-sm"
      data-testid="definitions-failed"
    >
      <CircleAlert class="size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span class="min-w-0 flex-1 break-words">{{ $t('fleet.monitoring.checkDefs.list.failed') }} <span class="text-muted-foreground">{{ definitionsError }}</span></span>
      <Button variant="outline" size="sm" type="button" @click="emit('retryDefinitions')">{{ $t('common.actions.retry') }}</Button>
    </div>

    <DataTable
      v-if="!(monitorsQuery.data.value !== undefined && !definitionsLoading && !definitionsError && rows.length === 0)"
      state-key="monitors"
      :columns="columns"
      :rows="query.rows.value"
      :row-key="(r) => r.key"
      :group-key="(r) => checkRowGroup(r)"
      :group-order="CHECK_ROW_GROUP_ORDER"
      :loading="monitorsQuery.loading.value"
      :error="monitorsQuery.error.value ?? null"
      :has-data="monitorsQuery.data.value !== undefined"
      :expression-filter="false"
      :external-sort="query.sorted.value"
      :class="query.staleRows.value && 'opacity-50'"
      :inert="query.staleRows.value || undefined"
      :row-click="(r, el) => openRow(r, el)"
      :active-row-id="rowKeyOf(sheet.openId.value)"
      data-testid="checks-table"
      @retry="monitorsQuery.refresh"
      @sort="queryText = withoutSorts(queryText)"
    >
      <template #group="{ group }">
        <span class="font-medium text-foreground">{{ $t(`fleet.monitoring.checkDefs.list.group.${group.key}`) }}</span>
        <span class="font-mono tabular text-muted-foreground">{{ group.rows.length }}</span>
        <span v-if="group.key === 'builtin'" class="truncate text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.list.group.builtinNote') }}</span>
      </template>
      <template #cell-name="{ row }">
        <span class="flex min-w-0 items-center gap-2">
          <component :is="row.kind === 'check' ? Activity : row.kind === 'fleet' ? Network : Waypoints" class="size-4 shrink-0 text-muted-foreground max-md:hidden" aria-hidden="true" />
          <span class="min-w-0">
            <span class="block font-medium md:truncate max-md:break-words" :title="shownName(row)">{{ shownName(row) }}</span>
            <span v-if="nameDetail(row)" class="block text-xs text-muted-foreground tabular" data-testid="check-row-detail">{{ nameDetail(row) }}</span>
          </span>
        </span>
      </template>
      <template #cell-status="{ row }">
        <span class="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs" data-testid="monitor-status">
          <StatusDot v-if="statusView(row).tone" :tone="statusView(row).tone" :pulse="false" />
          <span :class="statusView(row).textClass">{{ statusView(row).text }}</span>
          <span v-if="statusView(row).detail" :class="cn('text-muted-foreground', statusView(row).title ? '' : 'font-mono tabular')" :title="statusView(row).title">{{ statusView(row).detail }}</span>
        </span>
      </template>
      <template #cell-type="{ row }">
        <span class="font-mono text-xs uppercase">{{ checkRowMethod(row) }}</span>
        <span v-if="row.kind === 'check' && row.monitor.type === 'tls'" class="ms-1.5 whitespace-nowrap text-xs text-muted-foreground">{{ $t('fleet.monitoring.definitions.threshold', { days: row.monitor.threshold_days ?? 14 }) }}</span>
      </template>
      <template #cell-target="{ row }">
        <span :class="cn('text-xs break-words', row.kind === 'check' && 'font-mono')">{{ rowTarget(row) }}</span>
      </template>
      <template #cell-assignment="{ row }">
        <span class="text-xs break-words text-muted-foreground">{{ rowAssignment(row) }}</span>
      </template>
      <template #cell-interval="{ row }">
        <span class="whitespace-nowrap text-xs text-muted-foreground">{{ rowInterval(row) ?? '' }}</span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu :name="checkRowName(row)" :items="menuFor(row)" />
      </template>
      <template v-if="nodeFilter" #empty>
        <EmptyState :icon="RadioTower" :title="$t('fleet.monitoring.nodeFilter.emptyTitle', { node: nodeName(nodeFilter) })" :description="$t('fleet.monitoring.nodeFilter.emptyDescription')">
          <Button variant="outline" size="sm" type="button" @click="nodeFilter = ''">{{ $t('fleet.monitoring.nodeFilter.showAll') }}</Button>
        </EmptyState>
      </template>
    </DataTable>

    <!-- How long history is kept; only a server with the retention setting shows it. -->
    <section
      v-if="settings"
      class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm"
      data-testid="checks-retention"
      :aria-label="$t('fleet.monitoring.retention.title')"
    >
      <History class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p class="me-auto min-w-0">
        <span class="font-medium">{{ $t('fleet.monitoring.retention.summary', { n: settings.fine_retention_days }, settings.fine_retention_days) }}</span>
        <span class="ms-2 font-mono text-xs text-muted-foreground tabular">{{ $t('fleet.monitoring.retention.sizes', { measured: formatBytes(settings.measured_bytes), projected: formatBytes(settings.projected_bytes) }) }}</span>
      </p>
      <Button variant="outline" size="sm" type="button" data-testid="retention-open" @click="emit('retention')">
        {{ canAdmin ? $t('fleet.monitoring.retention.change') : $t('fleet.monitoring.retention.view') }}
      </Button>
    </section>

    <!-- One check: its paths, and the chart of the source chosen. -->
    <!-- One check definition: its sets, its paths, its paused targets. -->
    <DefinitionSheet
      :open="definitionOpen"
      :definition="openDefinition"
      :open-id="sheet.openId.value"
      :list-loading="definitionsLoading"
      :list-error="definitionsError && !definitions.length ? definitionsError : null"
      :paths="openDefinitionPaths"
      :nodes="nodes"
      :groups="groups"
      :can-admin="canAdmin"
      :owned="owned"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
      @edit="(d) => emit('editDefinition', d)"
      @retry="emit('retryDefinitions')"
      @changed="emit('changed')"
    />

    <ObjectSheet
      :open="!!sheet.openId.value && !definitionOpen"
      :title="selected?.name || selected?.id || sheet.openId.value || ''"
      :subtitle="selected ? `${selected.type.toUpperCase()} · ${selected.target}` : undefined"
      :state="sheetState"
      :error="monitorsQuery.error.value?.message ?? null"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('fleet.monitoring.sheet.goneTitle')"
      :gone-description="$t('fleet.monitoring.sheet.goneDescription')"
      @close="sheet.close"
      @retry="monitorsQuery.refresh"
    >
      <div v-if="selected" class="space-y-5 text-sm">
        <p v-if="selected.managed_by" class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.sheet.generatedNote') }}</p>
        <p v-else-if="!selected.enabled" class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.sheet.pausedNote') }}</p>

        <dl v-if="settingsRows.length" class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border p-3 text-xs" data-testid="check-settings">
          <template v-for="row in settingsRows" :key="row.key">
            <!-- Headers sit under their own heading; a long name breaks at its hyphens before anywhere else. -->
            <dt v-if="row.heading" class="col-span-2 pt-1 text-xs font-medium text-muted-foreground">{{ row.label }}</dt>
            <template v-else>
              <dt :class="cn('min-w-0 text-muted-foreground', row.key.startsWith('header-') ? 'ps-2 font-mono [overflow-wrap:anywhere]' : 'break-all')">{{ row.label }}</dt>
              <dd :class="cn('min-w-0 break-all', row.mono && 'font-mono')">{{ row.value }}</dd>
            </template>
          </template>
        </dl>

        <section v-if="sourceRows.length" class="space-y-1.5" :aria-label="$t('fleet.monitoring.checks.sheet.sources')">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.checks.sheet.sources') }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border" data-testid="check-sources">
            <li v-for="row in sourceRows" :key="row.source">
              <button
                type="button"
                :aria-pressed="row.source === chosenSource"
                :class="cn('grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', row.source === chosenSource && 'bg-muted')"
                @click="pickSource(row.source)"
              >
                <span class="min-w-0">
                  <span class="block truncate font-medium">{{ row.name }}</span>
                  <span v-if="row.paused" class="block text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.paused') }}</span>
                  <span v-else-if="row.path && row.path.state !== 'up'" :class="cn('block text-xs break-words', row.path.state === 'down' ? 'text-destructive' : row.path.state === 'degraded' ? 'text-warning-text' : 'text-muted-foreground')">
                    {{ displayLabel(row.path) }}: {{ whyText(row.path, failureOn(selected, row.source)) }}
                  </span>
                  <span v-else-if="row.latest?.reason" class="block text-xs break-words text-muted-foreground">{{ reasonText(row.latest.reason) }}</span>
                  <span v-else-if="row.latest && !row.latest.success" class="block text-xs break-words text-destructive">{{ row.latest.error || $t('fleet.monitoring.result.failing') }}</span>
                  <span v-else-if="!row.path && !row.latest" class="block text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.sheet.noResults') }}</span>
                </span>
                <span class="text-end font-mono text-xs tabular">
                  <template v-if="row.path">
                    <span class="block">{{ row.path.p50Ms !== undefined && row.path.state !== 'unknown' ? formatMs(row.path.p50Ms) : displayLabel(row.path) }}</span>
                    <span v-if="(row.path.loss ?? 0) > 0" class="block text-muted-foreground">{{ $t('fleet.monitoring.paths.cell.loss', { loss: formatLoss(row.path.loss) }) }}</span>
                  </template>
                  <template v-else-if="row.latest">
                    <span v-if="row.latest.reason" class="text-muted-foreground">{{ $t('fleet.monitoring.checks.unmeasured') }}</span>
                    <span v-else :class="row.latest.success ? '' : 'text-destructive'">{{ row.latest.success ? formatMs(row.latest.latencyMs) || $t('fleet.monitoring.result.ok') : $t('fleet.monitoring.result.fail') }}</span>
                  </template>
                </span>
              </button>
            </li>
          </ul>
        </section>
        <p v-else class="text-muted-foreground">{{ $t('fleet.monitoring.history.emptyDescription') }}</p>

        <PathDetail
          v-if="chosenAddress && chosenRow"
          :address="chosenAddress"
          :path="chosenRow.path"
          :window="window"
          :source="data.source.value"
          :compact="!wide"
          :title="$t('fleet.monitoring.paths.sheet.title', { source: chosenRow.name, target: selected.name || selected.target })"
          :offered="offered"
          :failure="failureOn(selected, chosenRow.source)"
          :agent-version="nodes.find((n) => n.id === chosenRow!.source)?.agent_version"
          :paths-failed="!!data.pathsQuery.error.value && data.source.value === 'unknown'"
          :owned="owned"
          :judges-degraded="!!data.matrix.value?.judgesDegraded"
          :verdict="data.triangulation.value && chosenRow.path ? verdictFor(data.triangulation.value, chosenRow.path) : undefined"
          @window="(w) => emit('window', w)"
        />
      </div>
      <template v-if="canAdmin && selected" #actions>
        <template v-if="selected.managed_by">
          <Button variant="outline" size="sm" type="button" @click="emit('pathSet')">
            <Settings2 class="size-4" aria-hidden="true" />
            {{ $t('fleet.monitoring.paths.sheet.editPathSet') }}
          </Button>
        </template>
        <template v-else>
          <Badge v-if="data.source.value === 'legacy'" variant="outline" class="me-auto">{{ $t('fleet.monitoring.checks.editUnavailable') }}</Badge>
          <Button variant="outline" size="sm" type="button" class="text-destructive" :disabled="deletePending" @click="requestDelete(selected)">
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
          <Button v-if="canEditCheck(selected, serverEdits)" size="sm" type="button" data-testid="check-edit" @click="emit('edit', selected)">
            <Pencil class="size-4" aria-hidden="true" />
            {{ $t('fleet.monitoring.checks.actions.edit') }}
          </Button>
        </template>
      </template>
    </ObjectSheet>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('fleet.monitoring.confirm.deleteTitle')"
      :description="deleteTarget ? $t('fleet.monitoring.confirm.delete', { name: deleteTarget.name || deleteTarget.id }) : ''"
      :impact="deleteImpact"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletePending"
      :return-focus="confirmReturn.target"
      @confirm="deleteMonitor"
    />
  </div>
</template>
