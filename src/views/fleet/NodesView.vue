<script setup lang="ts">
/**
 * Nodes, the fleet's collection (design 23, section 4.2).
 *
 *   observed 3s ago · 34 nodes · 2 offline · 4 agent versions     [Enroll]
 *   [search] [status] [group by: owner] [cards|list] [Filters] [Columns]
 *   v cd   16 · 15 online · offline: DMIT-4
 *     ● hetzner-fsn  203.0.113.29  0.3.9  3s ago  12%  HOME     [...]
 *
 * Search, status, grouping, the filters and the layout live in the address,
 * so a reload or a pasted link lands on the same list. A row opens the node
 * sheet on `?open=`; Terminal, Rotate and Disable are in the row's one menu.
 * Status is not a column (the name cell carries it); a column that holds
 * one value on every node leaves for the head. Enroll is in the header.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Ban, KeyRound, LayoutGrid, List, Plus, Power, RotateCw, Search, Server, SquareTerminal, X } from "lucide-vue-next";

import { api, unwrap, type GroupView, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useMediaQuery } from "@/composables/useMediaQuery";
import { createConfirmReturn } from "./confirmFocus";
import { useAuthStore } from "@/stores/auth";
import { countryName, splitNamePrefix } from "@/lib/fleet";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { agentConfigBadges, nodeHasAgentCapability, nodeHasArchOsToken } from "@/lib/nodeFilterExpressions";
import {
  NODE_STATUSES,
  compareByAttention,
  countNodeStatuses,
  describeNodeStatus,
  isReporting,
  nodeStatus,
  nodeStatusSince,
} from "@/lib/nodeStatus";
import { formatAge } from "@/lib/format";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";
import { groupRows } from "@/components/common/tableGroupModel";
import { partitionBatchResults, runWithConcurrency } from "@/views/operations/approvalsModel";
import { planBulkDisable, pruneSelection, summarizeBulk, type BulkOutcome } from "./fleetBulkModel";
import {
  NODE_COLUMNS,
  NODE_COLUMNS_STORAGE_KEY,
  NODE_GROUP_BYS,
  NODE_GROUP_PARAM,
  NODE_STATUS_PARAM,
  NODES_LAYOUT_PARAM,
  agentVersions,
  archOsText,
  canonicalLayoutQuery,
  compareNodeIdentity,
  isNodesLayout,
  lastSeenMillis,
  nameParts,
  nodeGroupByCodec,
  nodeGroupKey,
  nodeGroupOrder,
  nodeGroupSummary,
  nodeListCodec,
  nodeOwner,
  nodeSearchCodec,
  nodeStatusFilterCodec,
  parseHiddenColumns,
  ratioPercent,
  searchScore,
  serializeHiddenColumns,
  shownPercent,
  uniformColumns,
  type NodeGroupBy,
  type NodeGroupSummary,
  type NodesLayout,
} from "./nodesTableModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import NodeCard from "@/components/common/NodeCard.vue";
import FilterPanel from "@/components/common/FilterPanel.vue";
import TableColumnManager from "@/components/common/TableColumnManager.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import NodeSheet from "@/components/fleet/NodeSheet.vue";
import EnrollSheet from "@/components/fleet/EnrollSheet.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const auth = useAuthStore();
const { t, locale } = useI18n();
const canAdminNodes = computed(() => auth.can("node:admin"));
const canOpenTerminal = computed(() => auth.can("terminal:open"));

const nodesQuery = useAsyncData<Node[]>((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
});
// Suspected duplicates (NAT-safe; clustered on the server). Polled lazily.
const duplicatesQuery = useAsyncData((signal) => api.nodes.duplicates({ signal }).then((r) => r.groups), {
  pollInterval: 30_000,
});
// Group names for the cards and the enroll form; a read without group:read
// degrades to no chips.
const groupsQuery = useAsyncData<GroupView[]>((signal) => api.groups.list({ signal }).then((r) => r.groups));

const nodes = computed(() => nodesQuery.data.value ?? []);
const counts = computed(() => countNodeStatuses(nodes.value));

/* ------------------------------ address state ----------------------------- */

const owned = useOwnedRoute();
{
  // An old ?view=card|list link moves to ?layout= once.
  const legacy = canonicalLayoutQuery(owned.query());
  if (legacy) owned.replace(legacy.query);
}
const search = bindQueryParam(owned, "q", nodeSearchCodec);
const statusFilter = bindQueryParam(owned, NODE_STATUS_PARAM, nodeStatusFilterCodec);
const groupBy = bindQueryParam(owned, NODE_GROUP_PARAM, nodeGroupByCodec);
const agentFilter = bindQueryParam(owned, "agent", nodeListCodec);
const tagFilter = bindQueryParam(owned, "tag", nodeListCodec);
const osFilter = bindQueryParam(owned, "os", nodeListCodec);

/** The layout: `?layout=` wins, then the operator's last choice, then the list. */
const LAYOUT_STORAGE_KEY = "lattice.nodes.viewMode";
let savedLayout: NodesLayout = "list";
try {
  const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (isNodesLayout(saved)) savedLayout = saved;
} catch {
  /* storage may be refused */
}
const layoutParam = bindQueryParam<NodesLayout>(owned, NODES_LAYOUT_PARAM, {
  parse: (raw) => (isNodesLayout(raw) ? raw : savedLayout),
  format: (value) => value,
});
const layout = computed<NodesLayout>({
  get: () => layoutParam.value,
  set: (value) => {
    savedLayout = value;
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, value);
    } catch {
      /* storage may be refused */
    }
    layoutParam.value = value;
  },
});

const sheet = bindRouteOpen(owned);

/* --------------------------------- filters -------------------------------- */

function toggleIn(list: { value: string[] }, value: string): void {
  list.value = list.value.includes(value) ? list.value.filter((entry) => entry !== value) : [...list.value, value];
}

const toggleAgent = (token: string) => toggleIn(agentFilter, token);
const toggleOs = (token: string) => toggleIn(osFilter, token);
const toggleTag = (tag: string) => toggleIn(tagFilter, tag);

const AGENT_TOKENS = ["exec", "root", "terminal", "stream", "poll", "singbox", "no-source"] as const;
const OS_TOKENS = ["linux", "darwin", "amd64", "arm64"] as const;

const availableAgent = computed(() => AGENT_TOKENS.filter((token) => nodes.value.some((node) => nodeHasAgentCapability(node, token))));
const availableOs = computed(() => OS_TOKENS.filter((token) => nodes.value.some((node) => nodeHasArchOsToken(node, token))));
const allTags = computed(() => {
  const set = new Set<string>();
  for (const node of nodes.value) for (const tag of node.tags ?? []) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
});

function agentLabel(token: string): string {
  return token === "no-source" ? t("fleet.nodes.filters.noSource") : token === "singbox" ? "sing-box" : token;
}

function matches(node: Node): boolean {
  if (statusFilter.value !== "all" && nodeStatus(node) !== statusFilter.value) return false;
  if (!agentFilter.value.every((token) => nodeHasAgentCapability(node, token))) return false;
  if (!osFilter.value.every((token) => nodeHasArchOsToken(node, token))) return false;
  if (tagFilter.value.length && !tagFilter.value.every((tag) => (node.tags ?? []).includes(tag))) return false;
  if (search.value.trim() && searchScore(node, search.value) === 0) return false;
  return true;
}

/** Worst first, then by name; with a search, the best matches float up. */
const shown = computed(() => {
  const filtered = nodes.value.filter(matches).sort((a, b) => compareByAttention(a, b) || compareNodeIdentity(a, b));
  const q = search.value.trim();
  if (!q) return filtered;
  return [...filtered].sort((a, b) => searchScore(b, q) - searchScore(a, q));
});

const panelCount = computed(() => agentFilter.value.length + tagFilter.value.length + osFilter.value.length);
const filtered = computed(() => !!search.value.trim() || statusFilter.value !== "all" || panelCount.value > 0);

interface Applied {
  key: string;
  label: string;
  clear: () => void;
}
const applied = computed<Applied[]>(() => [
  ...agentFilter.value.map((token) => ({ key: `agent:${token}`, label: agentLabel(token), clear: () => toggleIn(agentFilter, token) })),
  ...osFilter.value.map((token) => ({ key: `os:${token}`, label: token, clear: () => toggleIn(osFilter, token) })),
  ...tagFilter.value.map((tag) => ({ key: `tag:${tag}`, label: tag, clear: () => toggleIn(tagFilter, tag) })),
]);

function clearPanel(): void {
  agentFilter.value = [];
  tagFilter.value = [];
  osFilter.value = [];
}

function clearFilters(): void {
  // One write: three bound keys written in one tick build on each other (useOwnedRoute).
  search.value = "";
  statusFilter.value = "all";
  clearPanel();
}

/* --------------------------------- columns -------------------------------- */

const hiddenColumns = ref<ReadonlySet<string>>(parseHiddenColumns(null));
try {
  hiddenColumns.value = parseHiddenColumns(localStorage.getItem(NODE_COLUMNS_STORAGE_KEY));
} catch {
  /* storage may be refused */
}
function storeHidden(next: ReadonlySet<string>): void {
  hiddenColumns.value = next;
  try {
    localStorage.setItem(NODE_COLUMNS_STORAGE_KEY, serializeHiddenColumns(next));
  } catch {
    /* storage may be refused */
  }
}
function toggleColumn(id: string): void {
  const next = new Set(hiddenColumns.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  storeHidden(next);
}
const optionalColumns = computed(() => NODE_COLUMNS.filter((column) => column.optional).map((column) => ({ id: column.id, label: t(column.labelKey) })));

/** Columns that hold one value on every node leave for the head (design 23, 4.2). */
const uniform = computed(() => uniformColumns(nodes.value, ["owner", "agent", "archOs", "agentConfig", "role"]));
const uniformIds = computed(() => new Set(uniform.value.map((entry) => entry.id)));

const ALIGN_RIGHT = new Set(["cpu", "memory", "disk"]);
const SORT_VALUE: Record<string, (node: Node) => unknown> = {
  name: (node) => (node.name || node.id).toLowerCase(),
  owner: (node) => nodeOwner(node).toLowerCase(),
  address: (node) => node.public_ip ?? "",
  agent: (node) => node.agent_version ?? "",
  lastSeen: (node) => lastSeenMillis(node),
  cpu: (node) => shownPercent(node.metrics?.cpu_percent) ?? -1,
  memory: (node) => ratioPercent(node.metrics?.memory_used, node.metrics?.memory_total) ?? -1,
  disk: (node) => ratioPercent(node.metrics?.disk_used, node.metrics?.disk_total) ?? -1,
  tags: (node) => (node.tags ?? []).join(" "),
  hostname: (node) => node.host_facts?.hostname ?? "",
  role: (node) => node.role ?? "",
  archOs: (node) => archOsText(node),
  agentConfig: (node) => agentConfigBadges(node).join(" "),
};

const columns = computed<DataTableColumn<Node>[]>(() => [
  ...NODE_COLUMNS.filter((column) => !(column.optional && hiddenColumns.value.has(column.id)) && !uniformIds.value.has(column.id)).map(
    (column): DataTableColumn<Node> => ({
      key: column.id,
      label: t(column.labelKey),
      sortable: true,
      align: ALIGN_RIGHT.has(column.id) ? "right" : undefined,
      value: SORT_VALUE[column.id],
      // From 768 px only: on a phone the pinned column's cap (38vw with the checkbox) governs.
      class: column.id === "name" ? "md:min-w-48" : undefined,
    }),
  ),
  // 44 px on a phone: the menu trigger, no padding around it (a 68 px column left 43 px for the rest).
  { key: "actions", label: "", class: "w-12 max-md:w-11 max-md:px-0", pin: "end" },
]);

/* -------------------------------- grouping -------------------------------- */

const collapsedGroups = ref(new Set<string>());
const groupKeyFn = computed(() => (groupBy.value === "none" ? undefined : (node: Node) => nodeGroupKey(node, groupBy.value)));
const groupOrder = computed(() => nodeGroupOrder(shown.value, groupBy.value));

function groupLabel(key: string, by: NodeGroupBy = groupBy.value): string {
  switch (by) {
    case "owner":
      return key || t("fleet.nodes.groupBy.noOwner");
    case "status":
      return t(describeNodeStatus(key as Node["status"] & string).labelKey);
    case "country":
      return key ? countryName(key, locale.value) : t("fleet.nodes.groupBy.noCountry");
    case "agent":
      return key || t("fleet.nodes.groupBy.noAgent");
    default:
      return key;
  }
}

/** What each group row says, computed once per list rather than per cell. */
const summaries = computed(() => {
  const map = new Map<string, NodeGroupSummary>();
  if (groupBy.value === "none") return map;
  for (const group of groupRows(shown.value, (node) => nodeGroupKey(node, groupBy.value))) map.set(group.key, nodeGroupSummary(group.rows));
  return map;
});
const EMPTY_SUMMARY: NodeGroupSummary = { total: 0, online: 0, degraded: 0, disabled: 0, down: [] };
function summaryOf(key: string): NodeGroupSummary {
  return summaries.value.get(key) ?? EMPTY_SUMMARY;
}
/** "DMIT-4, tmp +2": the members not reporting, three by name. */
function downNames(names: readonly string[]): string {
  const head = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${head} +${names.length - 3}` : head;
}

const cardGroups = computed(() =>
  groupBy.value === "none"
    ? [{ key: "", rows: shown.value }]
    : groupRows(shown.value, (node) => nodeGroupKey(node, groupBy.value), groupOrder.value),
);

/* ------------------------------- proof line ------------------------------- */

const proof = useProof(nodesQuery);

const proofSegments = computed<ProofSegment[]>(() => {
  const c = counts.value;
  const out: ProofSegment[] = [{ key: "nodes", text: t("fleet.nodes.proof.nodes", { n: c.total }, c.total) }];
  const status = (key: string, n: number, tone: ProofSegment["tone"], word: string) => {
    if (n > 0) out.push({ key, text: t(`fleet.nodes.proof.${word}`, { n }), tone, to: { query: { status: key } } });
  };
  status("offline", c.offline, "destructive", "offline");
  status("never_reported", c.never_reported, "warning", "neverReported");
  status("degraded", c.degraded, "warning", "degraded");
  status("disabled", c.disabled, "muted", "disabled");
  const versions = agentVersions(nodes.value);
  if (versions.length > 1) {
    out.push({ key: "versions", text: t("fleet.nodes.proof.versions", { n: versions.length }), to: { query: { group: "agent" } } });
  }
  for (const entry of uniform.value) {
    out.push({ key: `uniform-${entry.id}`, text: t(`fleet.nodes.proof.uniform.${entry.id}`, { value: entry.value }), tone: "muted" });
  }
  return out;
});

/* -------------------------------- attention ------------------------------- */

const nodeName = (id: string) => nodes.value.find((node) => node.id === id)?.name || id;

const attention = computed<AttentionItem[]>(() =>
  (duplicatesQuery.data.value ?? []).map((group, index) => ({
    key: `dup:${index}:${group.node_ids.join(",")}`,
    tone: group.confidence === "high" ? ("warning" as const) : ("info" as const),
    claim: t("fleet.nodes.duplicates.claim", { names: group.node_ids.map(nodeName).join(", ") }),
    proof: t(`fleet.nodes.duplicates.reason.${group.reason}`),
    action: group.node_ids[0] ? { label: t("fleet.nodes.duplicates.open"), run: () => sheet.open(group.node_ids[0]!) } : undefined,
  })),
);

/* ---------------------------------- cells --------------------------------- */

/** Under an owner group the row drops the "[cd]-" its group already says; the title keeps it. */
function displayName(node: Node): string {
  return groupBy.value === "owner" && nodeOwner(node) ? splitNamePrefix(node).body : node.name || node.id;
}

function statusWord(node: Node): string {
  const status = nodeStatus(node);
  if (status === "online") return "";
  const since = nodeStatusSince(node);
  const label = t(describeNodeStatus(status).labelKey);
  return since ? `${label} ${formatAge(Date.now() - Date.parse(since), locale.value)}` : label;
}

const STATUS_TEXT: Record<string, string> = {
  success: "text-muted-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function lastSeenText(node: Node): string {
  const ms = lastSeenMillis(node);
  return ms ? formatRelativeTime(ms) : t("fleet.nodes.list.neverSeen");
}

/* --------------------------------- actions -------------------------------- */

const pendingNode = ref<string | undefined>();
/** A confirm opened from a row menu hands focus back to that menu. */
const confirmReturn = createConfirmReturn();
const rotateTarget = ref<Node | undefined>();
const disableTarget = ref<Node | undefined>();
const rotated = ref<{ node: string; token: string } | undefined>();

const rotateOpen = computed({
  get: () => rotateTarget.value !== undefined,
  set: (open: boolean) => {
    if (!open && pendingNode.value !== rotateTarget.value?.id) rotateTarget.value = undefined;
  },
});
const disableOpen = computed({
  get: () => disableTarget.value !== undefined,
  set: (open: boolean) => {
    if (!open && pendingNode.value !== disableTarget.value?.id) disableTarget.value = undefined;
  },
});
const rotatedOpen = computed({
  get: () => rotated.value !== undefined,
  set: (open: boolean) => {
    if (!open) rotated.value = undefined;
  },
});

function openTerminal(node: Node): void {
  if (!canOpenTerminal.value || !isReporting(node)) return;
  window.open(`/terminal?node_id=${encodeURIComponent(node.id)}&connect=1`, "_blank", "noopener");
}

function menuFor(node: Node): RowMenuItem[] {
  const reporting = isReporting(node);
  return [
    {
      key: "terminal",
      label: t("fleet.nodes.list.openTerminal"),
      icon: SquareTerminal,
      hidden: !canOpenTerminal.value,
      disabled: !reporting,
      reason: reporting ? undefined : t("fleet.nodes.sheet.terminalNotReporting"),
      run: () => openTerminal(node),
    },
    {
      key: "rotate",
      label: t("fleet.nodes.list.rotateToken"),
      icon: KeyRound,
      hidden: !canAdminNodes.value,
      disabled: pendingNode.value === node.id,
      run: () => {
        confirmReturn.remember(node.id);
        rotateTarget.value = node;
      },
    },
    // Reversible (design 23, 3.8): an ordinary item, never the red one.
    node.disabled
      ? { key: "enable", label: t("common.actions.enable"), icon: Power, hidden: !canAdminNodes.value, run: () => void applyDisabled(node, false) }
      : {
          key: "disable",
          label: t("common.actions.disable"),
          icon: Ban,
          hidden: !canAdminNodes.value,
          run: () => {
            confirmReturn.remember(node.id);
            disableTarget.value = node;
          },
        },
  ];
}

async function confirmRotate(): Promise<void> {
  const node = rotateTarget.value;
  if (!node) return;
  pendingNode.value = node.id;
  try {
    const response = await api.nodes.rotateToken(node.id);
    rotateTarget.value = undefined;
    rotated.value = { node: node.name || node.id, token: response.token };
    toast.success(t("fleet.nodes.toast.tokenRotated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.rotationFailed"));
  } finally {
    pendingNode.value = undefined;
  }
}

async function applyDisabled(node: Node, disabled: boolean): Promise<boolean> {
  pendingNode.value = node.id;
  try {
    await api.nodes.disable(node.id, disabled);
    toast.success(disabled ? t("fleet.nodes.toast.nodeDisabled") : t("fleet.nodes.toast.nodeEnabled"));
    void nodesQuery.refresh();
    return true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.updateFailed"));
    return false;
  } finally {
    pendingNode.value = undefined;
  }
}

async function confirmDisable(): Promise<void> {
  const node = disableTarget.value;
  if (!node) return;
  if (await applyDisabled(node, true)) disableTarget.value = undefined;
}

/* ------------------------------ bulk enable/disable ------------------------------ */

/**
 * Selection survives filtering (narrowing the list hides rows, it does not
 * drop what was picked). A batch runs every item, never claims work it did
 * not do, and leaves what failed selected so a retry is one click.
 */
const selectedIds = ref(new Set<string>());
const bulkRunning = ref(false);
const bulkProgress = ref({ done: 0, total: 0 });
const bulkDisableOpen = ref(false);

interface BulkReport extends BulkOutcome<Node> {
  disabled: boolean;
  unchanged: number;
  missing: number;
}
const bulkReport = ref<BulkReport | undefined>();

watch(nodes, (list) => {
  const pruned = pruneSelection(selectedIds.value, list.map((node) => node.id));
  if (pruned.size !== selectedIds.value.size) selectedIds.value = pruned;
});

const selectedHidden = computed(() => {
  const visible = new Set(shown.value.map((node) => node.id));
  return [...selectedIds.value].filter((id) => !visible.has(id)).length;
});
const bulkDisableCount = computed(() => planBulkDisable(nodes.value, selectedIds.value, true).targets.length);
/** Enable is offered only when a selected node is disabled; otherwise it would do nothing. */
const bulkEnableCount = computed(() => planBulkDisable(nodes.value, selectedIds.value, false).targets.length);
/**
 * Disabling refuses each agent's token, so the node stops reporting. Past a
 * handful of nodes, or every online node, the confirm asks for the count
 * typed, like any action that takes part of the fleet dark.
 */
const BULK_TYPED_FROM = 5;
const bulkDisableTyped = computed(() => {
  const count = bulkDisableCount.value;
  const online = nodes.value.filter((node) => isReporting(node)).length;
  return count >= BULK_TYPED_FROM || (online > 0 && count >= online) ? String(count) : undefined;
});
const bulkDisableImpact = computed(() => [
  t("fleet.nodes.bulk.impactToken", { count: bulkDisableCount.value }),
  t("fleet.nodes.bulk.impactDark"),
  t("fleet.nodes.bulk.impactWork"),
]);

/**
 * On a touch screen the checkboxes wait for Select: pinned beside the name
 * they took 40 px of the 38vw a phone keeps for it, on every row, for an
 * action taken now and then. A selection already made keeps them showing.
 */
const coarse = useMediaQuery("(pointer: coarse)");
const selecting = ref(false);
const showSelection = computed(() => canAdminNodes.value && (!coarse.value || selecting.value || selectedIds.value.size > 0));
function toggleSelecting(): void {
  if (showSelection.value) {
    selecting.value = false;
    selectedIds.value = new Set();
  } else {
    selecting.value = true;
  }
}

function requestBulk(disabled: boolean): void {
  if (!canAdminNodes.value || bulkRunning.value) return;
  if (disabled && bulkDisableCount.value > 0) {
    confirmReturn.remember();
    bulkDisableOpen.value = true;
    return;
  }
  void runBulk(disabled);
}

async function runBulk(disabled: boolean): Promise<void> {
  bulkDisableOpen.value = false;
  const plan = planBulkDisable(nodes.value, selectedIds.value, disabled);
  bulkReport.value = undefined;
  if (plan.targets.length === 0) {
    toast.info(
      t("fleet.nodes.bulk.nothingToDo", {
        count: plan.unchanged.length,
        state: disabled ? t("fleet.nodes.bulk.stateDisabled") : t("fleet.nodes.bulk.stateEnabled"),
      }),
    );
    return;
  }
  bulkRunning.value = true;
  bulkProgress.value = { done: 0, total: plan.targets.length };
  try {
    const results = await runWithConcurrency(
      plan.targets,
      4,
      (node) => api.nodes.disable(node.id, disabled),
      (done, total) => {
        bulkProgress.value = { done, total };
      },
    );
    const { succeeded, failed } = partitionBatchResults(plan.targets, results);
    const outcome = summarizeBulk(succeeded, failed);
    selectedIds.value = new Set(outcome.retryIds);
    if (outcome.kind === "all") {
      toast.success(
        disabled
          ? t("fleet.nodes.bulk.doneDisabled", { count: outcome.succeeded.length })
          : t("fleet.nodes.bulk.doneEnabled", { count: outcome.succeeded.length }),
      );
    } else {
      bulkReport.value = { ...outcome, disabled, unchanged: plan.unchanged.length, missing: plan.missing.length };
    }
  } finally {
    bulkRunning.value = false;
    void nodesQuery.refresh();
  }
}

/* ---------------------------------- enroll -------------------------------- */

const enrollOpen = ref(false);

/** Why the node read failed, for the sheet; null while a first read retries, so the sheet shows it loading. */
const sheetError = computed(() => (nodesQuery.error.value && !nodesQuery.loading.value ? proofReason(nodesQuery.error.value) : null));
const openNode = computed(() => nodes.value.find((node) => node.id === sheet.openId.value));
const emptyFleet = computed(() => nodesQuery.data.value !== undefined && nodes.value.length === 0);
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.nodes.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="nodesQuery.refresh" />
      </template>
      <template #actions>
        <!-- An empty fleet's empty state carries Enroll; the header does not repeat it. -->
        <Button v-if="canAdminNodes && !emptyFleet" size="sm" type="button" @click="enrollOpen = true">
          <Plus aria-hidden="true" />
          {{ $t('fleet.nodes.list.enrollCta') }}
        </Button>
        <Button variant="outline" size="sm" type="button" :disabled="nodesQuery.refreshing.value" @click="nodesQuery.refresh">
          <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <section :aria-label="$t('fleet.nodes.list.title')" class="space-y-3">
      <!-- The toolbar: what the list shows. Every control is in the address. -->
      <div v-if="nodes.length > 0 || filtered" class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative min-w-0 flex-[1_1_16rem]">
            <Search class="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              v-model="search"
              type="search"
              class="ps-9"
              :placeholder="$t('fleet.nodes.filters.searchPlaceholder')"
              :aria-label="$t('fleet.nodes.filters.searchPlaceholder')"
            />
          </div>
          <Select v-model="statusFilter">
            <SelectTrigger class="w-[calc(50%-0.25rem)] sm:w-40" :aria-label="$t('fleet.nodes.filters.status')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{{ $t('fleet.nodes.filters.statusAll') }}</SelectItem>
              <SelectItem v-for="status in NODE_STATUSES" :key="status" :value="status">{{ $t(describeNodeStatus(status).labelKey) }}</SelectItem>
            </SelectContent>
          </Select>
          <Select v-model="groupBy">
            <SelectTrigger class="w-[calc(50%-0.25rem)] sm:w-44" :aria-label="$t('fleet.nodes.groupBy.label')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="by in NODE_GROUP_BYS" :key="by" :value="by">{{ $t(`fleet.nodes.groupBy.by.${by}`) }}</SelectItem>
            </SelectContent>
          </Select>
          <div class="inline-flex shrink-0 rounded-md border border-input bg-background p-0.5" role="group" :aria-label="$t('fleet.nodes.view.label')">
            <button
              v-for="mode in ['list', 'card'] as const"
              :key="mode"
              type="button"
              :class="cn(
                'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-10',
                layout === mode ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
              )"
              :aria-pressed="layout === mode"
              :aria-label="$t(`fleet.nodes.view.${mode}`)"
              @click="layout = mode"
            >
              <List v-if="mode === 'list'" class="size-4" aria-hidden="true" />
              <LayoutGrid v-else class="size-4" aria-hidden="true" />
              <span class="hidden lg:inline">{{ $t(`fleet.nodes.view.${mode}`) }}</span>
            </button>
          </div>
          <FilterPanel
            :label="$t('fleet.nodes.filters.more')"
            :active-count="panelCount"
            :clear-label="$t('fleet.nodes.filters.clearAdvanced')"
            @clear="clearPanel"
          >
            <div v-if="availableAgent.length" class="space-y-1.5">
              <p class="text-xs font-medium text-muted-foreground">{{ $t('fleet.nodes.filters.agentConfig') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="token in availableAgent"
                  :key="token"
                  type="button"
                  :class="cn(
                    'rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors pointer-coarse:min-h-11',
                    agentFilter.includes(token) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40',
                  )"
                  :aria-pressed="agentFilter.includes(token)"
                  @click="toggleAgent(token)"
                >
                  {{ agentLabel(token) }}
                </button>
              </div>
            </div>
            <div v-if="availableOs.length" class="space-y-1.5">
              <p class="text-xs font-medium text-muted-foreground">{{ $t('fleet.nodes.table.colArchOs') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="token in availableOs"
                  :key="token"
                  type="button"
                  :class="cn(
                    'rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors pointer-coarse:min-h-11',
                    osFilter.includes(token) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40',
                  )"
                  :aria-pressed="osFilter.includes(token)"
                  @click="toggleOs(token)"
                >
                  {{ token }}
                </button>
              </div>
            </div>
            <div v-if="allTags.length" class="space-y-1.5">
              <p class="text-xs font-medium text-muted-foreground">{{ $t('fleet.nodes.table.colTags') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="tag in allTags"
                  :key="tag"
                  type="button"
                  :class="cn(
                    'rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors pointer-coarse:min-h-11',
                    tagFilter.includes(tag) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/40',
                  )"
                  :aria-pressed="tagFilter.includes(tag)"
                  @click="toggleTag(tag)"
                >
                  {{ tag }}
                </button>
              </div>
            </div>
          </FilterPanel>
          <Button
            v-if="coarse && canAdminNodes && layout === 'list'"
            variant="outline"
            size="sm"
            type="button"
            :aria-pressed="showSelection"
            data-testid="nodes-select-mode"
            @click="toggleSelecting"
          >
            {{ showSelection ? $t('fleet.nodes.bulk.doneSelecting') : $t('fleet.nodes.bulk.select') }}
          </Button>
          <TableColumnManager
            v-if="layout === 'list'"
            :columns="optionalColumns"
            :hidden="hiddenColumns"
            @toggle="toggleColumn"
            @reset="storeHidden(parseHiddenColumns(null))"
          />
        </div>

        <div v-if="applied.length || filtered" class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <button
            v-for="filter in applied"
            :key="filter.key"
            type="button"
            class="inline-flex max-w-full items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20 pointer-coarse:min-h-11"
            :aria-label="$t('fleet.nodes.filters.removeFilter', { filter: filter.label })"
            @click="filter.clear()"
          >
            <span class="truncate">{{ filter.label }}</span>
            <X class="size-3 shrink-0" aria-hidden="true" />
          </button>
          <span v-if="filtered" class="tabular">{{ $t('fleet.nodes.filters.showing', { shown: shown.length, total: nodes.length }) }}</span>
          <Button v-if="filtered" variant="ghost" size="sm" class="h-7 px-2 text-xs" type="button" @click="clearFilters">
            <X class="size-3.5" aria-hidden="true" />
            {{ $t('fleet.nodes.filters.clear') }}
          </Button>
        </div>
      </div>

      <!-- What a batch did when it did not all work: stays on the page, names every refusal. -->
      <div v-if="bulkReport" class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm" role="status">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <p class="font-medium">
              {{
                bulkReport.kind === 'partial'
                  ? $t('fleet.nodes.bulk.partialTitle', { done: bulkReport.succeeded.length, total: bulkReport.succeeded.length + bulkReport.failed.length })
                  : $t('fleet.nodes.bulk.failedTitle', { total: bulkReport.failed.length })
              }}
            </p>
            <p class="mt-0.5 text-xs text-muted-foreground">
              {{ $t('fleet.nodes.bulk.failedHint') }}
              <template v-if="bulkReport.unchanged > 0">
                {{ $t('fleet.nodes.bulk.unchangedNote', { count: bulkReport.unchanged, state: bulkReport.disabled ? $t('fleet.nodes.bulk.stateDisabled') : $t('fleet.nodes.bulk.stateEnabled') }) }}
              </template>
              <template v-if="bulkReport.missing > 0">{{ $t('fleet.nodes.bulk.missingNote', { count: bulkReport.missing }) }}</template>
            </p>
            <ul class="mt-2 space-y-1">
              <li v-for="entry in bulkReport.failed" :key="entry.item.id" class="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span class="font-medium">{{ entry.item.name || entry.item.id }}</span>
                <span class="min-w-0 text-muted-foreground">{{ entry.error }}</span>
              </li>
            </ul>
          </div>
          <Button size="icon-sm" variant="ghost" type="button" :aria-label="$t('common.actions.close')" @click="bulkReport = undefined">
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>

      <!-- List: the chassis table, grouped by owner unless asked otherwise. -->
      <DataTable
        v-if="layout === 'list'"
        v-model:selected="selectedIds"
        v-model:collapsed-groups="collapsedGroups"
        state-key="nodes"
        :columns="columns"
        :rows="shown"
        :row-key="(node) => node.id"
        :loading="nodesQuery.loading.value"
        :error="nodesQuery.error.value ?? null"
        :has-data="nodesQuery.data.value !== undefined"
        :selectable="showSelection"
        :expression-filter="false"
        :show-summary="false"
        :group-key="groupKeyFn"
        :group-order="groupOrder"
        :row-click="(node, el) => sheet.open(node.id, el)"
        :active-row-id="sheet.openId.value"
        :select-all-label="$t('fleet.nodes.bulk.selectAllVisible')"
        @retry="nodesQuery.refresh"
      >
        <template #empty>
          <EmptyState
            v-if="filtered"
            :icon="Search"
            :title="$t('fleet.nodes.filters.noMatchTitle')"
            :description="$t('fleet.nodes.filters.noMatchDescription')"
          >
            <Button variant="outline" size="sm" type="button" @click="clearFilters">
              <X aria-hidden="true" />
              {{ $t('fleet.nodes.filters.clear') }}
            </Button>
          </EmptyState>
          <EmptyState v-else :icon="Server" :title="$t('fleet.nodes.list.emptyTitle')" :description="$t('fleet.nodes.list.emptyDescription')">
            <Button v-if="canAdminNodes" size="sm" type="button" @click="enrollOpen = true">
              <Plus aria-hidden="true" />
              {{ $t('fleet.nodes.list.enrollCta') }}
            </Button>
          </EmptyState>
        </template>

        <template #group="{ group }">
          <span class="font-medium text-foreground">{{ groupLabel(group.key) }}</span>
          <span class="tabular text-muted-foreground">
            {{ $t('fleet.nodes.groupRow.summary', { total: summaryOf(group.key).total, online: summaryOf(group.key).online }) }}
          </span>
          <span v-if="summaryOf(group.key).degraded" class="text-warning-text">
            {{ $t('fleet.nodes.groupRow.degraded', { n: summaryOf(group.key).degraded }) }}
          </span>
          <span v-if="summaryOf(group.key).down.length" class="truncate text-destructive">
            {{ $t('fleet.nodes.groupRow.down', { names: downNames(summaryOf(group.key).down) }) }}
          </span>
        </template>

        <template #bulk-actions>
          <span v-if="selectedHidden > 0" class="text-xs text-muted-foreground">{{ $t('fleet.nodes.bulk.hiddenByFilter', { count: selectedHidden }) }}</span>
          <span v-if="bulkRunning" class="text-xs tabular text-muted-foreground">
            {{ $t('fleet.nodes.bulk.running', { done: bulkProgress.done, total: bulkProgress.total }) }}
          </span>
          <div class="ms-auto flex flex-wrap items-center gap-2">
            <Button v-if="bulkEnableCount > 0" size="sm" variant="outline" type="button" :disabled="bulkRunning" @click="requestBulk(false)">
              <Power aria-hidden="true" />
              {{ $t('common.actions.enable') }}
            </Button>
            <Button size="sm" variant="outline" type="button" :disabled="bulkRunning" @click="requestBulk(true)">
              <Ban aria-hidden="true" />
              {{ $t('common.actions.disable') }}
            </Button>
          </div>
        </template>

        <template #cell-name="{ row }">
          <span class="flex min-w-0 items-center gap-2">
            <StatusDot :status="describeNodeStatus(row).health" />
            <span class="flex min-w-0 font-medium" :title="row.name || row.id">
              <span class="truncate">{{ nameParts(displayName(row))[0] }}</span><span class="shrink-0">{{ nameParts(displayName(row))[1] }}</span>
            </span>
            <span
              v-if="statusWord(row)"
              :class="cn('shrink-0 text-xs', STATUS_TEXT[describeNodeStatus(row).tone])"
            >{{ statusWord(row) }}</span>
          </span>
        </template>
        <template #cell-owner="{ row }">
          <span class="text-xs text-muted-foreground">{{ nodeOwner(row) }}</span>
        </template>
        <template #cell-address="{ row }">
          <span class="font-mono text-xs">{{ row.public_ip || '' }}</span>
        </template>
        <template #cell-agent="{ row }">
          <span class="font-mono text-xs">{{ row.agent_version || '' }}</span>
        </template>
        <template #cell-lastSeen="{ row }">
          <span
            :class="cn('whitespace-nowrap text-xs', ['offline', 'never_reported'].includes(nodeStatus(row)) ? 'text-warning-text' : 'text-muted-foreground')"
            :title="row.last_seen"
          >{{ lastSeenText(row) }}</span>
        </template>
        <template #cell-cpu="{ row }">
          <span class="font-mono text-xs tabular">{{ shownPercent(row.metrics?.cpu_percent) === undefined ? '' : `${shownPercent(row.metrics?.cpu_percent)}%` }}</span>
        </template>
        <template #cell-memory="{ row }">
          <span class="font-mono text-xs tabular" :title="row.metrics ? `${formatBytes(row.metrics.memory_used)} / ${formatBytes(row.metrics.memory_total)}` : undefined">
            {{ ratioPercent(row.metrics?.memory_used, row.metrics?.memory_total) === undefined ? '' : `${ratioPercent(row.metrics?.memory_used, row.metrics?.memory_total)}%` }}
          </span>
        </template>
        <template #cell-disk="{ row }">
          <span class="font-mono text-xs tabular" :title="row.metrics ? `${formatBytes(row.metrics.disk_used)} / ${formatBytes(row.metrics.disk_total)}` : undefined">
            {{ ratioPercent(row.metrics?.disk_used, row.metrics?.disk_total) === undefined ? '' : `${ratioPercent(row.metrics?.disk_used, row.metrics?.disk_total)}%` }}
          </span>
        </template>
        <template #cell-tags="{ row }">
          <span class="block max-w-64 truncate text-xs text-muted-foreground" :title="(row.tags ?? []).join(', ')">{{ (row.tags ?? []).join(', ') }}</span>
        </template>
        <template #cell-hostname="{ row }">
          <span class="font-mono text-xs">{{ row.host_facts?.hostname || '' }}</span>
        </template>
        <template #cell-role="{ row }">
          <span class="text-xs">{{ row.role || '' }}</span>
        </template>
        <template #cell-archOs="{ row }">
          <span class="text-xs text-muted-foreground">{{ archOsText(row) }}</span>
        </template>
        <template #cell-agentConfig="{ row }">
          <span class="font-mono text-xs text-muted-foreground">{{ agentConfigBadges(row).join(' ') }}</span>
        </template>
        <template #cell-actions="{ row }">
          <RowMenu :name="row.name || row.id" :items="menuFor(row)" />
        </template>
      </DataTable>

      <!-- Cards: opt-in, for reading nodes one at a time. A card opens the same sheet. -->
      <template v-else>
        <p v-if="nodesQuery.loading.value" class="py-6 text-sm text-muted-foreground">{{ $t('common.proof.reading') }}</p>
        <EmptyState
          v-else-if="nodesQuery.data.value !== undefined && shown.length === 0"
          :icon="filtered ? Search : Server"
          :title="filtered ? $t('fleet.nodes.filters.noMatchTitle') : $t('fleet.nodes.list.emptyTitle')"
          :description="filtered ? $t('fleet.nodes.filters.noMatchDescription') : $t('fleet.nodes.list.emptyDescription')"
        />
        <div v-else class="space-y-5">
          <section v-for="group in cardGroups" :key="group.key" class="space-y-2" :aria-label="groupBy === 'none' ? undefined : groupLabel(group.key)">
            <h3 v-if="groupBy !== 'none'" class="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span class="font-medium">{{ groupLabel(group.key) }}</span>
              <span class="text-xs tabular text-muted-foreground">
                {{ $t('fleet.nodes.groupRow.summary', { total: summaryOf(group.key).total, online: summaryOf(group.key).online }) }}
              </span>
              <span v-if="summaryOf(group.key).down.length" class="text-xs text-destructive">
                {{ $t('fleet.nodes.groupRow.down', { names: downNames(summaryOf(group.key).down) }) }}
              </span>
            </h3>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3">
              <NodeCard
                v-for="node in group.rows"
                :key="node.id"
                compact
                selectable
                :node="node"
                :cpu-label="t('fleet.nodes.metric.cpu')"
                :memory-label="t('fleet.nodes.metric.memory')"
                :disk-label="t('fleet.nodes.metric.disk')"
                :online-label="t('common.nodeStatus.online')"
                :never-label="t('common.nodeStatus.neverReported')"
                :offline-label="t('common.nodeStatus.offline')"
                :degraded-label="t('common.nodeStatus.degraded')"
                :disabled-label="t('common.nodeStatus.disabled')"
                :sparkline-label="t('fleet.nodes.metric.sparklineLabel')"
                @select="sheet.open(node.id)"
              />
            </div>
          </section>
        </div>
      </template>
    </section>

    <NodeSheet
      :node-id="sheet.openId.value"
      :nodes="nodesQuery.data.value"
      :error="sheetError"
      :return-focus="sheet.returnFocus"
      :menu-items="openNode ? menuFor(openNode).filter((item) => item.key !== 'terminal') : []"
      @close="sheet.close"
      @terminal="openTerminal"
      @retry="nodesQuery.refresh"
    />

    <EnrollSheet :open="enrollOpen" :groups="groupsQuery.data.value ?? []" @close="enrollOpen = false" @enrolled="nodesQuery.refresh" />

    <ConfirmDialog
      v-model:open="bulkDisableOpen"
      :title="$t('fleet.nodes.bulk.confirmDisableTitle', { count: bulkDisableCount })"
      :description="$t('fleet.nodes.bulk.confirmDisableDescription', { count: bulkDisableCount, selected: selectedIds.size })"
      :impact="bulkDisableImpact"
      :typed-confirm="bulkDisableTyped"
      :confirm-label="$t('common.actions.disable')"
      :cancel-label="$t('common.actions.cancel')"
      variant="default"
      :return-focus="confirmReturn.target"
      @confirm="runBulk(true)"
    />

    <ConfirmDialog
      v-model:open="rotateOpen"
      :title="$t('fleet.nodes.confirm.rotateTitle')"
      :description="$t('fleet.nodes.confirm.rotateDescription', { name: rotateTarget?.name || rotateTarget?.id })"
      :impact="[$t('fleet.nodes.confirm.rotateImpact', { name: rotateTarget?.name || rotateTarget?.id })]"
      :confirm-label="$t('fleet.nodes.list.rotateToken')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="!!rotateTarget && pendingNode === rotateTarget.id"
      :return-focus="confirmReturn.target"
      @confirm="confirmRotate"
    />

    <ConfirmDialog
      v-model:open="disableOpen"
      :title="$t('fleet.nodes.confirm.disableTitle')"
      :description="$t('fleet.nodes.confirm.disableDescription', { name: disableTarget?.name || disableTarget?.id })"
      :confirm-label="$t('common.actions.disable')"
      :cancel-label="$t('common.actions.cancel')"
      variant="default"
      :pending="!!disableTarget && pendingNode === disableTarget.id"
      :return-focus="confirmReturn.target"
      @confirm="confirmDisable"
    />

    <!-- The rotated token, shown once. -->
    <Dialog v-model:open="rotatedOpen">
      <DialogScrollContent class="w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader class="pe-6">
          <DialogTitle>{{ $t('fleet.nodes.rotated.tokenFor', { id: rotated?.node }) }}</DialogTitle>
          <DialogDescription>{{ $t('fleet.nodes.rotated.hint') }}</DialogDescription>
        </DialogHeader>
        <code class="block overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">{{ rotated?.token }}</code>
        <DialogFooter>
          <CopyButton v-if="rotated" :value="rotated.token" :label="$t('fleet.nodes.rotated.copyToken')" />
          <Button type="button" variant="outline" @click="rotated = undefined">{{ $t('common.actions.close') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
