<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  KeyRound,
  Layers,
  LayoutGrid,
  List,
  Plus,
  Power,
  RefreshCw,
  CircleAlert,
  CheckSquare,
  RotateCw,
  Search,
  Server,
  SquareTerminal,
  Wifi,
  X,
} from "lucide-vue-next";
import { api, unwrap, type AgentLaunchConfig, type AgentUpdatePolicy, type EnrollTokenResponse, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMetricBuffer } from "@/composables/useMetricBuffer";
import { useAuthStore } from "@/stores/auth";
import {
  formatBytes,
  formatBytesPerSec,
  formatRelativeTime,
  shortId,
} from "@/lib/format";
import { fleetTotals, groupNodes, type GroupBy, type NodeGroup } from "@/lib/fleet";
import { groupColor } from "@/lib/groupColors";
import { cn } from "@/lib/utils";
import {
  agentConfigBadges,
  evalFilterExpression,
  nodeHasAgentCapability,
  nodeHasArchOsToken,
  nodeHasTagToken,
} from "@/lib/nodeFilterExpressions";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import NodeCard from "@/components/common/NodeCard.vue";
import NodeTable from "@/components/common/NodeTable.vue";
import TableColumnManager from "@/components/common/TableColumnManager.vue";
import FilterPanel from "@/components/common/FilterPanel.vue";
import MetricStrip, { type Metric } from "@/components/common/MetricStrip.vue";
import {
  nameList,
  planBulkDisable,
  pruneSelection,
  selectionHeaderState,
  setSelected,
  summarizeBulk,
  toggleSelected,
  type BulkOutcome,
} from "./fleetBulkModel";
import { partitionBatchResults, runWithConcurrency } from "@/views/operations/approvalsModel";
import {
  NODE_TABLE_COLUMNS,
  compareNodeIdentity,
  nextSortState,
  parseHiddenColumns,
  parseSortState,
  serializeHiddenColumns,
  serializeSortState,
  sortNodes,
  type NodeSortState,
} from "./nodesTableModel";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Checkbox } from "@/components/ui/checkbox";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { hasNeverReported } from "@/lib/status";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const auth = useAuthStore();
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
});
const agentUpdatesQuery = useAsyncData((signal) => api.agentUpdates.list({ signal }).then((r) => unwrap(r, "policies")), {
  pollInterval: 15000,
});
// Client-side ring buffer: record each poll so NodeCard sparklines have history.
const metricBuffer = useMetricBuffer();
watch(
  () => nodesQuery.data.value,
  (list) => {
    for (const node of list ?? []) metricBuffer.record(node.id, node.metrics);
  },
  { immediate: true },
);

const enrollName = ref("");
const enrollId = ref("");
const enrollRole = ref("");
const enrollTags = ref("");
const enrollComment = ref("");
const enrollAgentSourceAllowlist = ref("");
const enrollGroups = ref<string[]>([]);
const enrollOpen = ref(false);
const enrollAdvancedOpen = ref(false);
const enrollAllowExec = ref(false);
const enrollAllowRootExec = ref(false);
const enrollNoExec = ref(false);
const enrollAllowTerminal = ref(false);
const enrollTerminalTransport = ref<"poll" | "stream">("stream");
const enrollSSHAlerts = ref(false);
const enrollPending = ref(false);
const enrollResult = ref<EnrollTokenResponse | undefined>();
const enrollPlatform = ref<"linux" | "manual">("linux");

const pendingNode = ref<string | undefined>();
const rotatedToken = ref<{ node_id: string; token: string } | undefined>();

/* ----------------------------------------------------------------- */
/* Client-side search / status / tag filtering over the polled list.  */
/* ----------------------------------------------------------------- */
type StatusFilter = "all" | "online" | "offline" | "disabled";
const search = ref("");
const statusFilter = ref<StatusFilter>("all");
const activeTags = ref<string[]>([]);
/** arch/os quick-filter tokens currently engaged (every selected must match). */
const activeArchOs = ref<string[]>([]);
type AgentCapabilityFilter = "exec" | "root" | "terminal" | "stream" | "poll";
const activeAgentCaps = ref<AgentCapabilityFilter[]>([]);
const agentExpr = ref("");
const archOsExpr = ref("");
const tagsExpr = ref("");

// Seed the status filter from a deep-link (e.g. the Overview "online" KPI tile
// links to /nodes?status=online), so drill-through lands pre-filtered.
{
  const seeded = route.query.status;
  if (seeded === "online" || seeded === "offline" || seeded === "disabled") {
    statusFilter.value = seeded;
  }
}

/* ----------------------------------------------------------------- */
/* Card / list view mode. Persisted to localStorage AND reflected in  */
/* `?view=` (mirrors the `?status=` seeding) so it is shareable and    */
/* survives reloads. The URL wins over the saved preference on load.   */
/* ----------------------------------------------------------------- */
type ViewMode = "card" | "list";
const VIEW_STORAGE_KEY = "lattice.nodes.viewMode";
// List is the default: nodes are the highest-cardinality operator data and
// belong in the dense table; the card wall stays one click away.
const viewMode = ref<ViewMode>("list");
{
  const seeded = route.query.view;
  if (seeded === "card" || seeded === "list") {
    viewMode.value = seeded;
  } else {
    try {
      const saved = localStorage.getItem(VIEW_STORAGE_KEY);
      if (saved === "card" || saved === "list") viewMode.value = saved;
    } catch {
      /* ignore storage errors */
    }
  }
}
watch(viewMode, (mode) => {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    /* ignore storage errors */
  }
  if (route.query.view !== mode) {
    router.replace({ query: { ...route.query, view: mode } }).catch(() => {});
  }
});

/* ----------------------------------------------------------------- */
/* Table sort + column visibility (list mode). Both persist so the    */
/* operator's working set survives reloads; the model lives in        */
/* nodesTableModel.ts and is covered by node --test.                  */
/* ----------------------------------------------------------------- */
const SORT_STORAGE_KEY = "lattice.nodes.sort";
const COLUMNS_STORAGE_KEY = "lattice.nodes.hiddenColumns";
const tableSort = ref<NodeSortState>({ key: "", dir: "asc" });
const hiddenColumns = ref<ReadonlySet<string>>(new Set<string>());
{
  try {
    tableSort.value = parseSortState(localStorage.getItem(SORT_STORAGE_KEY));
    hiddenColumns.value = parseHiddenColumns(localStorage.getItem(COLUMNS_STORAGE_KEY));
  } catch {
    /* ignore storage errors */
  }
}

function toggleTableSort(columnId: string) {
  tableSort.value = nextSortState(tableSort.value, columnId);
  try {
    localStorage.setItem(SORT_STORAGE_KEY, serializeSortState(tableSort.value));
  } catch {
    /* ignore storage errors */
  }
}

function persistHiddenColumns(next: ReadonlySet<string>) {
  hiddenColumns.value = next;
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, serializeHiddenColumns(next));
  } catch {
    /* ignore storage errors */
  }
}

function toggleColumn(id: string) {
  const next = new Set(hiddenColumns.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  persistHiddenColumns(next);
}

function resetColumns() {
  persistHiddenColumns(new Set());
}

const optionalColumns = computed(() =>
  NODE_TABLE_COLUMNS.filter((c) => c.optional).map((c) => ({ id: c.id, label: t(c.labelKey) })),
);

const nodes = computed(() => nodesQuery.data.value ?? []);
const updatePolicies = computed(() => agentUpdatesQuery.data.value ?? []);
// Suspected-duplicate detection (NAT-safe; server-clustered). Polled lazily.
const duplicatesQuery = useAsyncData((signal) => api.nodes.duplicates({ signal }).then((r) => r.groups), {
  pollInterval: 30000,
});
const duplicateGroups = computed(() => duplicatesQuery.data.value ?? []);
const nodeName = (id: string) => nodes.value.find((n) => n.id === id)?.name || id;
const onlineCount = computed(() => nodes.value.filter((n) => n.online && !n.disabled).length);
const disabledCount = computed(() => nodes.value.filter((n) => n.disabled).length);
const canAdminNodes = computed(() => auth.can("node:admin"));
const canOpenTerminal = computed(() => auth.can("terminal:open"));

/** Every role + tag present in the fleet, surfaced as clickable filter chips. */
const allTags = computed(() => {
  const set = new Set<string>();
  for (const node of nodes.value) {
    if (node.role) set.add(node.role);
    for (const tag of node.tags ?? []) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
});

function matchesStatus(node: Node): boolean {
  switch (statusFilter.value) {
    case "online":
      return !!node.online && !node.disabled;
    case "offline":
      return !node.online && !node.disabled;
    case "disabled":
      return !!node.disabled;
    default:
      return true;
  }
}

/**
 * Tiny hand-rolled, CSP-safe subsequence fuzzy matcher (no new dependency):
 * returns true when every char of `needle` appears in `haystack` in order.
 * "gmhk" matches "gomami-hkg", "ubu24" matches "ubuntu-24-04", etc.
 */
function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** Every searchable text field for a node, lowercased (name, id, role, every
 *  IP, hostname, and arch/os/platform). Empty values are dropped. */
function searchFields(node: Node): string[] {
  return [
    node.name,
    node.id,
    node.role,
    node.public_ip,
    node.public_ipv6,
    node.internal_ip,
    node.internal_ipv6,
    node.host_facts?.hostname,
    node.host_facts?.arch,
    node.host_facts?.os,
    node.host_facts?.platform,
    ...(node.tags ?? []),
  ]
    .filter((v): v is string => !!v)
    .map((v) => v.toLowerCase());
}

/** "mac" is a friendly alias for macOS, whose os/platform reports as "darwin". */
function matchesMacAlias(node: Node, q: string): boolean {
  if (!q.includes("mac")) return false;
  const osp = `${node.host_facts?.os ?? ""} ${node.host_facts?.platform ?? ""}`.toLowerCase();
  return osp.includes("darwin");
}

function matchesSearch(node: Node): boolean {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  const fields = searchFields(node);
  if (fields.some((f) => f.includes(q))) return true;
  if (matchesMacAlias(node, q)) return true;
  return fields.some((f) => fuzzyMatch(f, q));
}

/** Relevance score for ranking matched nodes: exact > prefix > substring >
 *  fuzzy; the "mac"→darwin alias scores like a strong substring hit. */
function searchScore(node: Node, q: string): number {
  if (!q) return 0;
  let best = 0;
  for (const f of searchFields(node)) {
    if (f === q) best = Math.max(best, 100);
    else if (f.startsWith(q)) best = Math.max(best, 70);
    else if (f.includes(q)) best = Math.max(best, 50);
    else if (fuzzyMatch(f, q)) best = Math.max(best, 20);
  }
  if (matchesMacAlias(node, q)) best = Math.max(best, 60);
  return best;
}

function matchesTags(node: Node): boolean {
  if (tagsExpr.value.trim() && !evalFilterExpression(tagsExpr.value, (token) => nodeHasTagToken(node, token)).value) return false;
  if (activeTags.value.length === 0) return true;
  const owned = new Set<string>([...(node.role ? [node.role] : []), ...(node.tags ?? [])]);
  return activeTags.value.every((tag) => owned.has(tag));
}

/* ----------------------------------------------------------------- */
/* Arch / OS quick filters. The fixed token set is intersected with    */
/* what the fleet actually reports so empty chips never show.          */
/* ----------------------------------------------------------------- */
const ARCH_OS_TOKENS = ["linux", "darwin", "amd64", "arm64"] as const;

function archOsHaystack(node: Node): string {
  return `${node.host_facts?.os ?? ""} ${node.host_facts?.platform ?? ""} ${node.host_facts?.arch ?? ""}`.toLowerCase();
}

const availableArchOs = computed(() => {
  const present = new Set<string>();
  for (const node of nodes.value) {
    const hay = archOsHaystack(node);
    for (const tok of ARCH_OS_TOKENS) if (hay.includes(tok)) present.add(tok);
  }
  return ARCH_OS_TOKENS.filter((tok) => present.has(tok));
});

function matchesArchOs(node: Node): boolean {
  if (archOsExpr.value.trim() && !evalFilterExpression(archOsExpr.value, (token) => nodeHasArchOsToken(node, token)).value) return false;
  if (activeArchOs.value.length === 0) return true;
  const hay = archOsHaystack(node);
  return activeArchOs.value.every((tok) => hay.includes(tok));
}

function toggleArchOs(tok: string) {
  const next = new Set(activeArchOs.value);
  if (next.has(tok)) next.delete(tok);
  else next.add(tok);
  activeArchOs.value = [...next];
}

const AGENT_CAP_FILTERS: AgentCapabilityFilter[] = ["exec", "root", "terminal", "stream", "poll"];

const availableAgentCaps = computed(() =>
  AGENT_CAP_FILTERS.filter((cap) => nodes.value.some((node) => nodeMatchesAgentCap(node, cap))),
);

function nodeMatchesAgentCap(node: Node, cap: AgentCapabilityFilter): boolean {
  return nodeHasAgentCapability(node, cap);
}

function matchesAgentCaps(node: Node): boolean {
  if (activeAgentCaps.value.length > 0 && !activeAgentCaps.value.every((cap) => nodeMatchesAgentCap(node, cap))) return false;
  if (!agentExpr.value.trim()) return true;
  return evalFilterExpression(agentExpr.value, (token) => nodeHasAgentCapability(node, token)).value;
}

function toggleAgentCap(cap: AgentCapabilityFilter) {
  const next = new Set(activeAgentCaps.value);
  if (next.has(cap)) next.delete(cap);
  else next.add(cap);
  activeAgentCaps.value = [...next];
}

/** Default order with no column sort: live nodes first, then by name, then by
 *  id so two machines sharing a name cannot trade places between polls. */
const baseSorted = computed(() =>
  [...nodes.value].sort((a, b) => {
    if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return compareNodeIdentity(a, b);
  }),
);

const sortedNodes = computed(() => {
  const q = search.value.trim().toLowerCase();
  const filtered = baseSorted.value.filter(
    (n) => matchesStatus(n) && matchesSearch(n) && matchesTags(n) && matchesArchOs(n) && matchesAgentCaps(n),
  );
  // An explicit column sort (list mode only - card mode has no headers to
  // show it) wins over search-relevance floating.
  if (viewMode.value === "list" && tableSort.value.key) {
    return sortNodes(filtered, tableSort.value);
  }
  // With an active query, float the best matches up (stable sort keeps the
  // disabled/online/name order from baseSorted for equal scores).
  if (!q) return filtered;
  return [...filtered].sort((a, b) => searchScore(b, q) - searchScore(a, q));
});

const hasFilters = computed(
  () =>
    !!search.value.trim() ||
    statusFilter.value !== "all" ||
    activeTags.value.length > 0 ||
    activeArchOs.value.length > 0 ||
    activeAgentCaps.value.length > 0 ||
    !!agentExpr.value.trim() ||
    !!archOsExpr.value.trim() ||
    !!tagsExpr.value.trim(),
);

/**
 * How many filters are applied from inside the panel, i.e. everything except
 * the two the toolbar shows on its face. This is the number on the Filters
 * badge, and it is what stops a collapsed panel from hiding the reason a list
 * came back empty.
 */
const advancedFilterCount = computed(
  () =>
    activeTags.value.length +
    activeArchOs.value.length +
    activeAgentCaps.value.length +
    (agentExpr.value.trim() ? 1 : 0) +
    (archOsExpr.value.trim() ? 1 : 0) +
    (tagsExpr.value.trim() ? 1 : 0),
);

/**
 * The applied filters, flattened into one removable list.
 *
 * Rendering every *available* tag as a button is what made the old filter block
 * fourteen chips wide on a fleet with fourteen tags, and it scaled with the
 * fleet rather than with the operator's intent. What belongs on the page is
 * what is currently on; the full catalog belongs in the panel.
 */
type AppliedFilter = { key: string; label: string; clear: () => void };

const appliedFilters = computed<AppliedFilter[]>(() => {
  const out: AppliedFilter[] = [];
  for (const cap of activeAgentCaps.value) {
    out.push({
      key: `cap:${cap}`,
      label: t(`fleet.nodes.filters.agentCaps.${cap}`),
      clear: () => toggleAgentCap(cap),
    });
  }
  for (const tok of activeArchOs.value) {
    out.push({ key: `os:${tok}`, label: tok, clear: () => toggleArchOs(tok) });
  }
  for (const tag of activeTags.value) {
    out.push({ key: `tag:${tag}`, label: tag, clear: () => toggleTag(tag) });
  }
  // The expression fields are one filter each, and their value is the label:
  // an operator who typed `AND(exec, root)` recognises it faster than any name
  // this could invent for it.
  if (agentExpr.value.trim()) {
    out.push({
      key: "expr:agent",
      label: `${t("fleet.nodes.filters.agentExpression")}: ${agentExpr.value.trim()}`,
      clear: () => (agentExpr.value = ""),
    });
  }
  if (archOsExpr.value.trim()) {
    out.push({
      key: "expr:os",
      label: `${t("fleet.nodes.filters.osExpression")}: ${archOsExpr.value.trim()}`,
      clear: () => (archOsExpr.value = ""),
    });
  }
  if (tagsExpr.value.trim()) {
    out.push({
      key: "expr:tags",
      label: `${t("fleet.nodes.filters.tagsExpression")}: ${tagsExpr.value.trim()}`,
      clear: () => (tagsExpr.value = ""),
    });
  }
  return out;
});

/** Reset only what the panel owns; search and status keep their own controls. */
function clearAdvancedFilters() {
  activeTags.value = [];
  activeArchOs.value = [];
  activeAgentCaps.value = [];
  agentExpr.value = "";
  archOsExpr.value = "";
  tagsExpr.value = "";
}
/** Raw list non-empty but filters hid everything → distinct no-match state. */
const noMatches = computed(() => nodes.value.length > 0 && sortedNodes.value.length === 0);

function toggleTag(tag: string) {
  const next = new Set(activeTags.value);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  activeTags.value = [...next];
}

function clearFilters() {
  search.value = "";
  statusFilter.value = "all";
  activeTags.value = [];
  activeArchOs.value = [];
  activeAgentCaps.value = [];
  agentExpr.value = "";
  archOsExpr.value = "";
  tagsExpr.value = "";
}

function agentBadges(node: Node): string[] {
  return agentConfigBadges(node);
}

/* ----------------------------------------------------------------- */
/* Grouping: bucket the filtered fleet by region / role / status / …  */
/* so a 16+ node fleet reads as clusters, not one long wall of cards.  */
/* ----------------------------------------------------------------- */
/**
 * The headline band above the fleet table.
 *
 * Download and upload are separate segments rather than one two-line cell: they
 * are two numbers, and pairing them was the reason the old card grid stretched
 * every sibling to 160px to match its tallest member.
 */
const fleetMetrics = computed<Metric[]>(() => [
  { key: "total", label: t("fleet.nodes.stats.total"), value: nodes.value.length, icon: Server },
  {
    key: "online",
    label: t("fleet.nodes.stats.online"),
    value: onlineCount.value,
    hint: `/ ${nodes.value.length}`,
    tone: "success",
    icon: Wifi,
  },
  {
    key: "disabled",
    label: t("fleet.nodes.stats.disabled"),
    value: disabledCount.value,
    // A zero here is the good outcome and should not be coloured like a fault.
    tone: disabledCount.value > 0 ? "warning" : "default",
    icon: Power,
  },
  {
    key: "rx",
    label: t("fleet.nodes.stats.download"),
    value: formatBytesPerSec(totals.value.netRxSpeed),
    hint: formatBytes(totals.value.netRxBytes),
    icon: ArrowDown,
  },
  {
    key: "tx",
    label: t("fleet.nodes.stats.upload"),
    value: formatBytesPerSec(totals.value.netTxSpeed),
    hint: formatBytes(totals.value.netTxBytes),
    icon: ArrowUp,
  },
]);

/**
 * Ungrouped by default.
 *
 * The default used to be "region", which is derived from NodeGeo. Geo is
 * resolved per node and is empty until someone resolves it, so on a fresh or
 * partly-resolved fleet the console opened on a single collapsible group
 * labelled "Unknown" holding every node - a header that carried no information
 * and cost a row of vertical space plus the implication that grouping was doing
 * something. Grouping is a lens an operator reaches for; the table sorts on
 * every column already, so it does not need one imposed at load.
 */
const groupBy = ref<GroupBy>("none");
const collapsed = ref<Set<string>>(new Set());

// Group metadata (id -> name/color/leader) for group chips on every card AND the
// "Group" grouping mode. Fetched EAGERLY so chips render on first paint (it used
// to be lazy, only on groupBy==='group'); degrades to no chips / a single
// Ungrouped bucket if the request fails (e.g. the token lacks group:read).
const fleetGroupsQuery = useAsyncData((signal) => api.groups.list({ signal }).then((r) => r.groups), {
  immediate: true,
});

/** id -> chip metadata, so each card can resolve node.group_ids into chips. */
const groupMetaById = computed(() => {
  const m: Record<string, { name: string; color?: string; leaderId?: string }> = {};
  for (const g of fleetGroupsQuery.data.value ?? []) {
    m[g.id] = { name: g.name, color: g.color, leaderId: g.leader_id };
  }
  return m;
});

/** Resolve a node's resolved group_ids into chip descriptors for NodeCard. */
function nodeGroups(node: Node) {
  return (node.group_ids ?? []).map((id) => {
    const g = groupMetaById.value[id];
    return { id, name: g?.name ?? id, color: g?.color, leader: g?.leaderId === node.id };
  });
}

/**
 * Say "never checked in" rather than formatting the server's zero time, which
 * renders as a six-figure number of days ago. The reading itself lives in
 * `@/lib/status`; this used to be a private copy of it in each of three views.
 */
function lastSeenText(node: Node): string {
  if (hasNeverReported(node)) return t("fleet.nodes.list.neverSeen");
  return t("fleet.nodes.list.lastSeen", { time: formatRelativeTime(node.last_seen) });
}

function nodeUpdatePolicy(node: Node): AgentUpdatePolicy | undefined {
  return updatePolicies.value.find((p) => p.node_id === node.id);
}

function nodeUpdateLabel(node: Node): string {
  const policy = nodeUpdatePolicy(node);
  if (!policy) return t("fleet.nodes.list.noUpdatePolicy");
  if (policy.enabled && policy.auto_plan) return t("fleet.nodes.list.autoUpdate");
  return t("fleet.nodes.list.manualUpdate");
}

function nodeUpdateVariant(node: Node): "success" | "secondary" | "outline" {
  const policy = nodeUpdatePolicy(node);
  if (!policy) return "outline";
  if (policy.enabled && policy.auto_plan) return "success";
  return "secondary";
}

/** Cross-link a group chip to the Groups page with that group pre-selected. */
function goToGroup(id: string) {
  router.push({ name: "groups", query: { selected: id } });
}

/** Groups offered as assignable at enrollment (same eager fleet group list). */
const enrollGroupOptions = computed(() => fleetGroupsQuery.data.value ?? []);

function toggleEnrollGroup(id: string) {
  const next = new Set(enrollGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  enrollGroups.value = [...next];
}

const groups = computed<NodeGroup[]>(() =>
  groupNodes(sortedNodes.value, groupBy.value, locale.value, fleetGroupsQuery.data.value ?? [], {
    preserveOrder: true,
  }),
);

/** Aggregate bandwidth across the (unfiltered) fleet for the header stat. */
const totals = computed(() => fleetTotals(nodes.value));

function groupLabel(g: NodeGroup): string {
  return g.i18nKey ? t(g.i18nKey) : g.label;
}

function toggleGroup(key: string) {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

function openNode(node: Node) {
  router.push({ name: "node-detail", params: { id: node.id } });
}

function parseTags(): string[] {
  return enrollTags.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function parseAgentSourceAllowlist(): string[] {
  return enrollAgentSourceAllowlist.value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function enrollAgentLaunch(): AgentLaunchConfig {
  return {
    allow_exec: enrollAllowExec.value,
    allow_root_exec: enrollAllowRootExec.value,
    no_exec: enrollNoExec.value,
    allow_terminal: enrollAllowTerminal.value,
    terminal_transport: enrollAllowTerminal.value ? enrollTerminalTransport.value : undefined,
    ssh_alerts: enrollSSHAlerts.value,
  };
}

/** Scroll the enroll form into view and focus its first field. */
async function focusEnroll() {
  enrollOpen.value = true;
  await nextTick();
  document.getElementById("enroll-node-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const input = document.getElementById("enroll-name");
  if (input instanceof HTMLInputElement) input.focus({ preventScroll: true });
}

async function enrollNode() {
  if (!enrollName.value.trim()) return;
  enrollPending.value = true;
  enrollResult.value = undefined;
  try {
    enrollResult.value = await api.nodes.enrollToken({
      node_id: enrollId.value.trim() || undefined,
      name: enrollName.value.trim(),
      role: enrollRole.value.trim() || undefined,
      tags: parseTags(),
      comment: enrollComment.value.trim() || undefined,
      agent_source_allowlist: parseAgentSourceAllowlist(),
      group_ids: enrollGroups.value.length ? [...enrollGroups.value] : undefined,
      agent_launch: enrollAgentLaunch(),
    });
    enrollName.value = "";
    enrollId.value = "";
    enrollRole.value = "";
    enrollTags.value = "";
    enrollComment.value = "";
    enrollAgentSourceAllowlist.value = "";
    enrollGroups.value = [];
    enrollAllowExec.value = false;
    enrollAllowRootExec.value = false;
    enrollNoExec.value = false;
    enrollAllowTerminal.value = false;
    enrollTerminalTransport.value = "stream";
    enrollSSHAlerts.value = false;
    toast.success(t("fleet.nodes.toast.tokenCreated"));
    nodesQuery.refresh();
    agentUpdatesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.enrollFailed"));
  } finally {
    enrollPending.value = false;
  }
}

const enrollCommand = computed(() => {
  if (!enrollResult.value) return "";
  return enrollResult.value.commands?.[enrollPlatform.value] || enrollResult.value.command || enrollResult.value.token;
});

/* Destructive node actions are confirmed before they run. Both the card footer
   and the table row emit into these handlers, so gating here covers every entry
   point. Re-enabling a node is not destructive and still runs straight away. */
const rotateTarget = ref<Node | undefined>(undefined);
const disableTarget = ref<Node | undefined>(undefined);

const rotateOpen = computed({
  get: () => rotateTarget.value !== undefined,
  set: (open: boolean) => {
    if (!open) rotateTarget.value = undefined;
  },
});
const disableOpen = computed({
  get: () => disableTarget.value !== undefined,
  set: (open: boolean) => {
    if (!open) disableTarget.value = undefined;
  },
});

function rotateToken(node: Node) {
  rotateTarget.value = node;
}

async function confirmRotateToken() {
  const node = rotateTarget.value;
  if (!node) return;
  pendingNode.value = node.id;
  rotatedToken.value = undefined;
  try {
    rotatedToken.value = await api.nodes.rotateToken(node.id);
    enrollOpen.value = true;
    toast.success(t("fleet.nodes.toast.tokenRotated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.rotationFailed"));
  } finally {
    pendingNode.value = undefined;
    rotateTarget.value = undefined;
  }
}

function setDisabled(node: Node, disabled: boolean) {
  if (!disabled) {
    void applyDisabled(node, false);
    return;
  }
  disableTarget.value = node;
}

async function confirmDisable() {
  const node = disableTarget.value;
  if (!node) return;
  try {
    await applyDisabled(node, true);
  } finally {
    disableTarget.value = undefined;
  }
}

async function applyDisabled(node: Node, disabled: boolean) {
  pendingNode.value = node.id;
  try {
    await api.nodes.disable(node.id, disabled);
    toast.success(disabled ? t("fleet.nodes.toast.nodeDisabled") : t("fleet.nodes.toast.nodeEnabled"));
    nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.updateFailed"));
  } finally {
    pendingNode.value = undefined;
  }
}

/* ── Fleet selection and bulk enable/disable ─────────────────────────────── */
/**
 * Disabling six nodes was six trips through a per-row menu. Selection spans
 * both view modes and every group, and survives filtering: narrowing the list
 * hides rows, it does not silently drop what the operator already picked. The
 * bar says when part of the selection is out of sight.
 *
 * The batch itself is the careful part. It never claims work it did not do,
 * it runs every item to completion instead of stopping at the first failure,
 * and what failed stays selected so a retry is one click.
 */
const selectedIds = ref<Set<string>>(new Set());
const bulkRunning = ref(false);
const bulkProgress = ref({ done: 0, total: 0 });

interface BulkReport extends BulkOutcome<Node> {
  /** The direction that was asked for; drives the wording. */
  disabled: boolean;
  /** Selected nodes already in that state, so no call was made for them. */
  unchanged: number;
  /** Selected ids that had left the fleet by the time the batch ran. */
  missing: number;
}
const bulkReport = ref<BulkReport | undefined>(undefined);

/** Ids the current filter actually shows, in display order. */
const visibleIds = computed(() => sortedNodes.value.map((node) => node.id));
const selectedCount = computed(() => selectedIds.value.size);
const allVisibleState = computed(() => selectionHeaderState(selectedIds.value, visibleIds.value));
/** Part of the selection sits behind the current filter; the bar has to say so. */
const selectedHiddenCount = computed(() => {
  const visible = new Set(visibleIds.value);
  let hidden = 0;
  for (const id of selectedIds.value) if (!visible.has(id)) hidden += 1;
  return hidden;
});

// A node deleted elsewhere must not linger in the selection and be acted on.
watch(nodes, (list) => {
  const pruned = pruneSelection(selectedIds.value, list.map((node) => node.id));
  if (pruned.size !== selectedIds.value.size) selectedIds.value = pruned;
});

function toggleSelect(nodeId: string) {
  selectedIds.value = toggleSelected(selectedIds.value, nodeId);
}

function toggleSelectMany(nodeIds: string[], on: boolean) {
  selectedIds.value = setSelected(selectedIds.value, nodeIds, on);
}

function clearSelection() {
  selectedIds.value = new Set();
  bulkReport.value = undefined;
}

const bulkDisableOpen = ref(false);

/**
 * Disabling is destructive and is confirmed; re-enabling runs straight away.
 *
 * A selection that would change nothing skips the dialog: asking an operator
 * to confirm "disable 0 nodes" is a prompt with no decision in it. runBulk
 * says what is actually the case instead.
 */
function requestBulk(disabled: boolean) {
  if (!canAdminNodes.value || bulkRunning.value) return;
  if (disabled && bulkDisableCount.value > 0) {
    bulkDisableOpen.value = true;
    return;
  }
  void runBulk(disabled);
}

function confirmBulkDisable() {
  bulkDisableOpen.value = false;
  void runBulk(true);
}

/** How many of the selected nodes the requested change would actually touch. */
const bulkDisableCount = computed(() => planBulkDisable(nodes.value, selectedIds.value, true).targets.length);

async function runBulk(disabled: boolean) {
  const plan = planBulkDisable(nodes.value, selectedIds.value, disabled);
  bulkReport.value = undefined;

  // Nothing to call. Say that plainly rather than flash a success toast for
  // work that never happened.
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
    // Keep only what failed selected, so retry is one click and a clean run
    // leaves an empty bar rather than a stale one.
    selectedIds.value = new Set(outcome.retryIds);
    if (outcome.kind === "all") {
      toast.success(
        disabled
          ? t("fleet.nodes.bulk.doneDisabled", { count: outcome.succeeded.length })
          : t("fleet.nodes.bulk.doneEnabled", { count: outcome.succeeded.length }),
      );
    }
    // A partial or total failure gets a panel, not a toast that scrolls away.
    if (outcome.kind !== "all") {
      bulkReport.value = {
        ...outcome,
        disabled,
        unchanged: plan.unchanged.length,
        missing: plan.missing.length,
      };
    }
  } finally {
    bulkRunning.value = false;
    nodesQuery.refresh();
  }
}

/** "fra-edge-01, ams-relay-02 and 3 more" for the failure panel heading. */
function failedNames(report: BulkReport): { names: string; extra: number } {
  return nameList(report.failed.map((entry) => entry.item), 3);
}

function openTerminal(node: Node) {
  if (!canOpenTerminal.value || !node.online || node.disabled) return;
  window.open(`/terminal?node_id=${encodeURIComponent(node.id)}&connect=1`, "_blank", "noopener");
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('fleet.nodes.title')" :description="$t('fleet.nodes.description')">
      <template #status>
        <FreshnessLabel :last-updated="nodesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button v-if="canAdminNodes" size="sm" @click="focusEnroll">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('fleet.nodes.list.enrollCta') }}
        </Button>
        <Button variant="outline" size="sm" :disabled="nodesQuery.refreshing.value" @click="nodesQuery.refresh">
          <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div
      v-if="duplicateGroups.length"
      class="rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-2"
    >
      <p class="flex items-center gap-1.5 text-sm font-medium text-warning">
        <AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
        {{ $t('fleet.nodes.duplicates.title', { count: duplicateGroups.length }) }}
      </p>
      <ul class="space-y-1 text-sm text-muted-foreground">
        <li
          v-for="(g, i) in duplicateGroups"
          :key="i"
          class="flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          <Badge :variant="g.confidence === 'high' ? 'destructive' : 'secondary'">
            {{ $t(`fleet.nodes.duplicates.reason.${g.reason}`) }}
          </Badge>
          <template v-for="(id, j) in g.node_ids" :key="id">
            <button
              type="button"
              class="underline underline-offset-2 hover:text-foreground"
              @click="router.push({ name: 'node-detail', params: { id } })"
            >
              {{ nodeName(id) }}
            </button>
            <span v-if="j < g.node_ids.length - 1" aria-hidden="true">·</span>
          </template>
        </li>
      </ul>
    </div>

    <!-- Fleet headline numbers. One band rather than four stretched cards: the
         answer an operator came for is in the table below, and this used to eat
         160px above it to carry four integers. -->
    <MetricStrip :metrics="fleetMetrics" :columns="5" />

    <Card v-if="canAdminNodes && enrollOpen" id="enroll-node-section" class="border-primary/30 bg-primary/5">
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <Plus class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.enroll.title') }}
            </CardTitle>
            <CardDescription class="mt-1">{{ $t('fleet.nodes.enroll.description') }}</CardDescription>
          </div>
          <Button variant="ghost" size="icon-sm" :aria-label="$t('common.actions.close')" @click="enrollOpen = false">
            <X class="size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardHeader>
      <CardContent class="space-y-4">
        <form class="grid gap-3 lg:grid-cols-6" @submit.prevent="enrollNode">
          <div class="grid gap-2">
            <Label for="enroll-name">{{ $t('fleet.nodes.enroll.name') }}</Label>
            <Input id="enroll-name" v-model="enrollName" required />
          </div>
          <div class="grid gap-2">
            <Label for="enroll-id">{{ $t('fleet.nodes.enroll.nodeId') }}</Label>
            <Input id="enroll-id" v-model="enrollId" :placeholder="$t('common.misc.optional')" />
          </div>
          <div class="grid gap-2">
            <Label for="enroll-role">{{ $t('fleet.nodes.enroll.role') }}</Label>
            <Input id="enroll-role" v-model="enrollRole" :placeholder="$t('fleet.nodes.enroll.rolePlaceholder')" />
          </div>
          <div class="grid gap-2">
            <Label for="enroll-tags">{{ $t('fleet.nodes.enroll.tags') }}</Label>
            <Input id="enroll-tags" v-model="enrollTags" :placeholder="$t('fleet.nodes.enroll.tagsPlaceholder')" />
          </div>
          <div class="grid gap-2 lg:col-span-2">
            <Label for="enroll-comment">{{ $t('fleet.nodes.enroll.comment') }}</Label>
            <Input id="enroll-comment" v-model="enrollComment" :placeholder="$t('common.misc.optional')" />
          </div>
          <div class="grid gap-2 lg:col-span-2">
            <Label for="enroll-agent-source-allowlist">{{ $t('fleet.nodes.enroll.agentSourceAllowlist') }}</Label>
            <Textarea
              id="enroll-agent-source-allowlist"
              v-model="enrollAgentSourceAllowlist"
              rows="3"
              :placeholder="$t('fleet.nodes.enroll.agentSourceAllowlistPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.agentSourceAllowlistHint') }}</p>
          </div>
          <div class="flex items-end">
            <Button type="submit" :disabled="enrollPending || !enrollName.trim()">
              <RefreshCw v-if="enrollPending" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t('fleet.nodes.enroll.submit') }}
            </Button>
          </div>
        </form>

        <!-- Optional: assign the node into one or more groups at enrollment. -->
        <div v-if="enrollGroupOptions.length" class="grid gap-2">
          <Label>{{ $t('fleet.nodes.enroll.groups') }}</Label>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.groupsHint') }}</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="g in enrollGroupOptions"
              :key="g.id"
              type="button"
              :class="cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors surface-interactive',
                enrollGroups.includes(g.id)
                  ? cn(groupColor(g.color).border, groupColor(g.color).soft, groupColor(g.color).text)
                  : 'border-border text-muted-foreground hover:bg-muted/40',
              )"
              :aria-pressed="enrollGroups.includes(g.id)"
              @click="toggleEnrollGroup(g.id)"
            >
              <span :class="cn('size-2 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
              {{ g.name }}
            </button>
          </div>
        </div>

        <div class="rounded-lg border border-border bg-background/70">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
            :aria-expanded="enrollAdvancedOpen"
            @click="enrollAdvancedOpen = !enrollAdvancedOpen"
          >
            <span>
              <span class="block text-sm font-medium">{{ $t('fleet.nodes.enroll.agentProfile') }}</span>
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.agentProfileHint') }}</span>
            </span>
            <ChevronDown
              :class="cn('size-4 shrink-0 text-muted-foreground transition-transform', enrollAdvancedOpen && 'rotate-180')"
              aria-hidden="true"
            />
          </button>
          <div v-if="enrollAdvancedOpen" class="grid gap-2 border-t border-border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-3">
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <Checkbox v-model="enrollAllowExec" class="mt-0.5" :disabled="enrollNoExec" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowExec') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowExecHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <Checkbox v-model="enrollAllowRootExec" class="mt-0.5" :disabled="enrollNoExec || !enrollAllowExec" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowRootExec') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowRootExecHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <Checkbox v-model="enrollNoExec" class="mt-0.5" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.noExec') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.noExecHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <Checkbox v-model="enrollAllowTerminal" class="mt-0.5" :disabled="enrollNoExec" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowTerminal') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowTerminalHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <Checkbox v-model="enrollSSHAlerts" class="mt-0.5" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.sshAlerts') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.sshAlertsHint') }}</span>
              </span>
            </label>
          </div>
          <div v-if="enrollAdvancedOpen" class="grid gap-3 px-3 pb-3 md:grid-cols-4">
            <div class="grid gap-1.5">
              <Label>{{ $t('fleet.nodes.enroll.terminalTransport') }}</Label>
              <Select v-model="enrollTerminalTransport" :disabled="!enrollAllowTerminal">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="poll">poll</SelectItem>
                  <SelectItem value="stream">stream</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div v-if="enrollResult" class="grid gap-3 rounded-md border border-success/40 bg-success/5 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="text-sm font-medium">{{ $t('fleet.nodes.enroll.tokenFor', { id: enrollResult.node_id }) }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.tokenHint') }}</p>
            </div>
            <CopyButton :value="enrollCommand" :label="$t('fleet.nodes.enroll.copyCommand')" />
          </div>
          <div class="inline-flex w-fit rounded-md border border-border bg-background/70 p-1">
            <button
              type="button"
              :class="cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                enrollPlatform === 'linux' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )"
              :aria-pressed="enrollPlatform === 'linux'"
              @click="enrollPlatform = 'linux'"
            >
              {{ $t('fleet.nodes.enroll.platformLinux') }}
            </button>
            <button
              type="button"
              :class="cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                enrollPlatform === 'manual' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )"
              :aria-pressed="enrollPlatform === 'manual'"
              @click="enrollPlatform = 'manual'"
            >
              {{ $t('fleet.nodes.enroll.platformManual') }}
            </button>
          </div>
          <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">
            {{ enrollCommand }}
          </code>
        </div>

        <div v-if="rotatedToken" class="grid gap-3 rounded-md border border-warning/40 bg-warning/5 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="text-sm font-medium">{{ $t('fleet.nodes.rotated.tokenFor', { id: rotatedToken.node_id }) }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.rotated.hint') }}</p>
            </div>
            <CopyButton :value="rotatedToken.token" :label="$t('fleet.nodes.rotated.copyToken')" />
          </div>
          <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">
            {{ rotatedToken.token }}
          </code>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>{{ $t('fleet.nodes.list.title') }}</CardTitle>
        <CardDescription>{{ $t('fleet.nodes.list.description', { online: onlineCount, total: nodes.length }) }}</CardDescription>
      </CardHeader>
      <CardContent>
        <!-- Search / status / tag filters over the polled list (client-side). -->
        <div v-if="nodes.length > 0" class="mb-4 space-y-3">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div class="relative flex-1">
              <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                v-model="search"
                class="pl-9"
                :placeholder="$t('fleet.nodes.filters.searchPlaceholder')"
                :aria-label="$t('fleet.nodes.filters.searchPlaceholder')"
              />
            </div>
            <Select v-model="statusFilter">
              <SelectTrigger class="sm:w-40">
                <SelectValue :placeholder="$t('fleet.nodes.filters.status')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ $t('fleet.nodes.filters.statusAll') }}</SelectItem>
                <SelectItem value="online">{{ $t('common.status.online') }}</SelectItem>
                <SelectItem value="offline">{{ $t('common.status.offline') }}</SelectItem>
                <SelectItem value="disabled">{{ $t('common.status.disabled') }}</SelectItem>
              </SelectContent>
            </Select>
            <Select v-model="groupBy">
              <SelectTrigger class="sm:w-44">
                <Layers class="size-4 text-muted-foreground" aria-hidden="true" />
                <SelectValue :placeholder="$t('fleet.nodes.groupBy.label')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="region">{{ $t('fleet.nodes.groupBy.region') }}</SelectItem>
                <SelectItem value="country">{{ $t('fleet.nodes.groupBy.country') }}</SelectItem>
                <SelectItem value="role">{{ $t('fleet.nodes.groupBy.role') }}</SelectItem>
                <SelectItem value="group">{{ $t('fleet.nodes.groupBy.group') }}</SelectItem>
                <SelectItem value="status">{{ $t('fleet.nodes.groupBy.status') }}</SelectItem>
                <SelectItem value="tag">{{ $t('fleet.nodes.groupBy.tag') }}</SelectItem>
                <SelectItem value="none">{{ $t('fleet.nodes.groupBy.none') }}</SelectItem>
              </SelectContent>
            </Select>

            <!-- Card / list view toggle (segmented control, mirrors the enroll
                 + monitoring toggles). -->
            <div
              class="inline-flex shrink-0 rounded-md border border-input bg-background p-0.5"
              role="group"
              :aria-label="$t('fleet.nodes.view.label')"
            >
              <button
                type="button"
                :class="cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  viewMode === 'card' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )"
                :aria-pressed="viewMode === 'card'"
                @click="viewMode = 'card'"
              >
                <LayoutGrid class="size-4" aria-hidden="true" />
                <span class="hidden sm:inline">{{ $t('fleet.nodes.view.card') }}</span>
              </button>
              <button
                type="button"
                :class="cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )"
                :aria-pressed="viewMode === 'list'"
                @click="viewMode = 'list'"
              >
                <List class="size-4" aria-hidden="true" />
                <span class="hidden sm:inline">{{ $t('fleet.nodes.view.list') }}</span>
              </button>
            </div>

            <!-- Everything past search / status / grouping lives behind one
                 button with a count. See FilterPanel for why. -->
            <FilterPanel
              :label="$t('fleet.nodes.filters.more')"
              :active-count="advancedFilterCount"
              :clear-label="$t('fleet.nodes.filters.clearAdvanced')"
              @clear="clearAdvancedFilters"
            >
              <div v-if="availableAgentCaps.length" class="space-y-1.5">
                <p class="text-xs font-medium uppercase text-muted-foreground">
                  {{ $t('fleet.nodes.filters.agentConfig') }}
                </p>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="cap in availableAgentCaps"
                    :key="`agent:${cap}`"
                    type="button"
                    :class="cn(
                      'rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors surface-interactive',
                      activeAgentCaps.includes(cap)
                        ? 'border-warning bg-warning/10 text-warning-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted/40',
                    )"
                    :aria-pressed="activeAgentCaps.includes(cap)"
                    @click="toggleAgentCap(cap)"
                  >
                    {{ $t(`fleet.nodes.filters.agentCaps.${cap}`) }}
                  </button>
                </div>
              </div>

              <!-- Named for what these chips are, not for the expression field
                   further down. Both used to print "OS expression", which read
                   as the same control appearing twice. -->
              <div v-if="availableArchOs.length" class="space-y-1.5">
                <p class="text-xs font-medium uppercase text-muted-foreground">
                  {{ $t('fleet.nodes.table.colArchOs') }}
                </p>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="tok in availableArchOs"
                    :key="`archos:${tok}`"
                    type="button"
                    :class="cn(
                      'rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors surface-interactive',
                      activeArchOs.includes(tok)
                        ? 'border-info bg-info/10 text-info'
                        : 'border-border text-muted-foreground hover:bg-muted/40',
                    )"
                    :aria-pressed="activeArchOs.includes(tok)"
                    @click="toggleArchOs(tok)"
                  >
                    {{ tok }}
                  </button>
                </div>
              </div>

              <div v-if="allTags.length" class="space-y-1.5">
                <p class="text-xs font-medium uppercase text-muted-foreground">
                  {{ $t('fleet.nodes.table.colTags') }}
                </p>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="tag in allTags"
                    :key="tag"
                    type="button"
                    :class="cn(
                      'rounded-sm border px-2 py-0.5 text-xs font-medium transition-colors surface-interactive',
                      activeTags.includes(tag)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted/40',
                    )"
                    :aria-pressed="activeTags.includes(tag)"
                    @click="toggleTag(tag)"
                  >
                    {{ tag }}
                  </button>
                </div>
              </div>

              <div class="grid gap-1.5">
                <Label for="nodes-agent-expr" class="text-xs text-muted-foreground">{{ $t('fleet.nodes.filters.agentExpression') }}</Label>
                <Input
                  id="nodes-agent-expr"
                  v-model="agentExpr"
                  class="font-mono text-xs"
                  :placeholder="$t('fleet.nodes.filters.agentExpressionPlaceholder')"
                />
              </div>
              <div class="grid gap-1.5">
                <Label for="nodes-os-expr" class="text-xs text-muted-foreground">{{ $t('fleet.nodes.filters.osExpression') }}</Label>
                <Input
                  id="nodes-os-expr"
                  v-model="archOsExpr"
                  class="font-mono text-xs"
                  :placeholder="$t('fleet.nodes.filters.osExpressionPlaceholder')"
                />
              </div>
              <div class="grid gap-1.5">
                <Label for="nodes-tags-expr" class="text-xs text-muted-foreground">{{ $t('fleet.nodes.filters.tagsExpression') }}</Label>
                <Input
                  id="nodes-tags-expr"
                  v-model="tagsExpr"
                  class="font-mono text-xs"
                  :placeholder="$t('fleet.nodes.filters.tagsExpressionPlaceholder')"
                />
              </div>
            </FilterPanel>

            <TableColumnManager
              v-if="viewMode === 'list'"
              :columns="optionalColumns"
              :hidden="hiddenColumns"
              @toggle="toggleColumn"
              @reset="resetColumns"
            />
          </div>

          <!-- What is actually on, as removable chips. Only the applied ones:
               the catalog lives in the panel. -->
          <div v-if="appliedFilters.length" class="flex flex-wrap items-center gap-1.5">
            <button
              v-for="filter in appliedFilters"
              :key="filter.key"
              type="button"
              class="inline-flex max-w-full items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              :aria-label="$t('fleet.nodes.filters.removeFilter', { filter: filter.label })"
              @click="filter.clear()"
            >
              <span class="truncate">{{ filter.label }}</span>
              <X class="size-3 shrink-0" aria-hidden="true" />
            </button>
          </div>

          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <div class="flex items-center gap-2">
              <label v-if="canAdminNodes && sortedNodes.length > 0" class="flex items-center gap-2">
                <Checkbox
                  :model-value="allVisibleState"
                  :aria-label="$t('fleet.nodes.bulk.selectAllVisible')"
                  @update:model-value="(value) => toggleSelectMany(visibleIds, value === true)"
                />
                <span>{{ $t('fleet.nodes.bulk.selectAllVisible') }}</span>
              </label>
              <span>{{ $t('fleet.nodes.filters.showing', { shown: sortedNodes.length, total: nodes.length }) }}</span>
            </div>
            <Button v-if="hasFilters" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="clearFilters">
              <X class="size-3.5" aria-hidden="true" />
              {{ $t('fleet.nodes.filters.clear') }}
            </Button>
          </div>
        </div>

        <!-- Bulk bar. Present only while something is selected, and it names
             what the next action would really touch, not the selection size. -->
        <div
          v-if="canAdminNodes && selectedCount > 0"
          class="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm"
        >
          <CheckSquare class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="font-medium tabular-nums">{{ $t('fleet.nodes.bulk.selected', { count: selectedCount }) }}</span>
          <span v-if="selectedHiddenCount > 0" class="text-xs text-muted-foreground">
            {{ $t('fleet.nodes.bulk.hiddenByFilter', { count: selectedHiddenCount }) }}
          </span>
          <span v-if="bulkRunning" class="text-xs tabular-nums text-muted-foreground">
            {{ $t('fleet.nodes.bulk.running', { done: bulkProgress.done, total: bulkProgress.total }) }}
          </span>
          <div class="ms-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" :disabled="bulkRunning" @click="requestBulk(false)">
              <Power class="size-4" aria-hidden="true" />
              {{ $t('common.actions.enable') }}
            </Button>
            <Button size="sm" variant="destructive" :disabled="bulkRunning" @click="requestBulk(true)">
              <Power class="size-4" aria-hidden="true" />
              {{ $t('common.actions.disable') }}
            </Button>
            <Button size="sm" variant="ghost" :disabled="bulkRunning" @click="clearSelection">
              <X class="size-4" aria-hidden="true" />
              {{ $t('fleet.nodes.bulk.clear') }}
            </Button>
          </div>
        </div>

        <!-- What a batch actually did, when it did not all work. Stays on the
             page rather than scrolling away as a toast, names every node that
             refused and why, and those nodes are still selected. -->
        <div
          v-if="bulkReport"
          class="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          role="status"
        >
          <div class="flex items-start gap-2">
            <CircleAlert class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <p class="font-medium">
                {{
                  bulkReport.kind === 'partial'
                    ? $t('fleet.nodes.bulk.partialTitle', {
                        done: bulkReport.succeeded.length,
                        total: bulkReport.succeeded.length + bulkReport.failed.length,
                      })
                    : $t('fleet.nodes.bulk.failedTitle', { total: bulkReport.failed.length })
                }}
              </p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                {{ $t('fleet.nodes.bulk.failedHint') }}
                <template v-if="bulkReport.unchanged > 0">
                  {{ $t('fleet.nodes.bulk.unchangedNote', {
                    count: bulkReport.unchanged,
                    state: bulkReport.disabled ? $t('fleet.nodes.bulk.stateDisabled') : $t('fleet.nodes.bulk.stateEnabled'),
                  }) }}
                </template>
                <template v-if="bulkReport.missing > 0">
                  {{ $t('fleet.nodes.bulk.missingNote', { count: bulkReport.missing }) }}
                </template>
              </p>
              <ul class="mt-2 space-y-1">
                <li
                  v-for="entry in bulkReport.failed"
                  :key="entry.item.id"
                  class="flex flex-wrap items-baseline gap-x-2 text-xs"
                >
                  <span class="font-medium">{{ entry.item.name || entry.item.id }}</span>
                  <span class="min-w-0 text-muted-foreground">{{ entry.error }}</span>
                </li>
              </ul>
            </div>
            <Button size="sm" variant="ghost" @click="bulkReport = undefined">
              <X class="size-4" aria-hidden="true" />
              <span class="sr-only">{{ $t('common.actions.close') }}</span>
            </Button>
          </div>
        </div>

        <DataState
          :loading="nodesQuery.loading.value"
          :error="nodesQuery.error.value"
          :has-data="nodesQuery.data.value !== undefined"
          :is-empty="nodes.length === 0"
          :empty-title="$t('fleet.nodes.list.emptyTitle')"
          :empty-description="$t('fleet.nodes.list.emptyDescription')"
          @retry="nodesQuery.refresh"
        >
          <template #empty>
            <EmptyState
              :icon="Server"
              :title="$t('fleet.nodes.list.emptyTitle')"
              :description="$t('fleet.nodes.list.emptyDescription')"
            >
              <Button v-if="canAdminNodes" size="sm" @click="focusEnroll">
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('fleet.nodes.list.enrollCta') }}
              </Button>
            </EmptyState>
          </template>

          <!-- Filters hid every node: distinct no-match state, not the first-run CTA. -->
          <EmptyState
            v-if="noMatches"
            :icon="Search"
            :title="$t('fleet.nodes.filters.noMatchTitle')"
            :description="$t('fleet.nodes.filters.noMatchDescription')"
          >
            <Button variant="outline" size="sm" @click="clearFilters">
              <X class="size-4" aria-hidden="true" />
              {{ $t('fleet.nodes.filters.clear') }}
            </Button>
          </EmptyState>

          <div v-else class="space-y-6">
            <section v-for="group in groups" :key="group.key">
              <!-- Group header (hidden when grouping is off) -->
              <button
                v-if="groupBy !== 'none'"
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-muted/40"
                :aria-expanded="!collapsed.has(group.key)"
                @click="toggleGroup(group.key)"
              >
                <ChevronDown
                  :class="cn('size-4 shrink-0 text-muted-foreground transition-transform', collapsed.has(group.key) && '-rotate-90')"
                  aria-hidden="true"
                />
                <span
                  v-if="group.color"
                  :class="cn('size-2.5 shrink-0 rounded-full', groupColor(group.color).dot)"
                  aria-hidden="true"
                ></span>
                <span v-if="group.glyph" class="text-base leading-none">{{ group.glyph }}</span>
                <span class="font-semibold">{{ groupLabel(group) }}</span>
                <Badge variant="secondary" class="ml-1 tabular">
                  {{ $t('fleet.nodes.groupBy.count', { online: group.online, total: group.total }) }}
                </Badge>
                <span class="ml-auto h-px flex-1 bg-border"></span>
              </button>

              <div
                v-show="!collapsed.has(group.key)"
                :class="cn(groupBy !== 'none' && 'mt-3')"
              >
                <div v-if="viewMode === 'card'" class="grid gap-3 xl:grid-cols-2">
                <NodeCard
                  v-for="node in group.nodes"
                  :key="node.id"
                  :node="node"
                  :groups="nodeGroups(node)"
                  show-sparkline
                  sparkline-metric="cpu"
                  :cpu-label="t('fleet.nodes.metric.cpu')"
                  :memory-label="t('fleet.nodes.metric.memory')"
                  :disk-label="t('fleet.nodes.metric.disk')"
                  :online-label="t('common.status.online')"
                  :never-label="t('common.status.neverReported')"
                  :offline-label="t('common.status.offline')"
                  :degraded-label="t('common.status.degraded')"
                  :unknown-label="t('common.status.unknown')"
                  :disabled-label="t('common.status.disabled')"
                  :sparkline-label="t('fleet.nodes.metric.sparklineLabel')"
                  :checkable="canAdminNodes"
                  :checked="selectedIds.has(node.id)"
                  :check-label="t('fleet.nodes.bulk.selectRow', { name: node.name || node.id })"
                  @select="openNode(node)"
                  @group-select="goToGroup"
                  @toggle-check="toggleSelect(node.id)"
                >
                  <template #footer="{ node: cardNode }">
                    <div class="mt-3 flex flex-wrap items-center gap-1.5">
                      <span class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.nodes.filters.agentConfig') }}</span>
                      <Badge
                        v-for="badge in agentBadges(cardNode)"
                        :key="`${cardNode.id}:${badge}`"
                        variant="outline"
                      >
                        {{ badge }}
                      </Badge>
                      <span v-if="agentBadges(cardNode).length === 0" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
                    </div>
                    <p class="mt-3 font-mono text-xs text-muted-foreground">
                      {{ shortId(cardNode.id, 16) }} · {{ lastSeenText(cardNode) }}
                    </p>
                    <div v-if="canOpenTerminal || canAdminNodes" class="mt-3 flex flex-wrap gap-2">
                      <Badge :variant="nodeUpdateVariant(cardNode)">
                        {{ nodeUpdateLabel(cardNode) }}
                      </Badge>
                      <Button
                        v-if="canOpenTerminal"
                        size="sm"
                        variant="outline"
                        :disabled="!cardNode.online || cardNode.disabled"
                        @click.stop="openTerminal(cardNode)"
                      >
                        <SquareTerminal class="size-4" aria-hidden="true" />
                        {{ $t('fleet.nodes.list.openTerminal') }}
                      </Button>
                      <Button v-if="canAdminNodes" size="sm" variant="outline" :disabled="pendingNode === cardNode.id" @click.stop="rotateToken(cardNode)">
                        <KeyRound class="size-4" aria-hidden="true" />
                        {{ $t('fleet.nodes.list.rotateToken') }}
                      </Button>
                      <Button
                        v-if="canAdminNodes"
                        size="sm"
                        :variant="cardNode.disabled ? 'outline' : 'destructive'"
                        :disabled="pendingNode === cardNode.id"
                        @click.stop="setDisabled(cardNode, !cardNode.disabled)"
                      >
                        <Power class="size-4" aria-hidden="true" />
                        {{ cardNode.disabled ? $t('common.actions.enable') : $t('common.actions.disable') }}
                      </Button>
                    </div>
                  </template>
                </NodeCard>
                </div>
                <NodeTable
                  v-else
                  :nodes="group.nodes"
                  :hidden-columns="hiddenColumns"
                  :sort="tableSort"
                  :can-open-terminal="canOpenTerminal"
                  :can-admin-nodes="canAdminNodes"
                  :pending-node-id="pendingNode"
                  :update-policies="updatePolicies"
                  :selectable="canAdminNodes"
                  :selected-ids="selectedIds"
                  @open="openNode"
                  @terminal="openTerminal"
                  @rotate="rotateToken"
                  @set-disabled="setDisabled"
                  @toggle-sort="toggleTableSort"
                  @toggle-select="toggleSelect"
                  @toggle-select-all="toggleSelectMany"
                />
              </div>
            </section>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <!-- The count is what the batch would really change, not the selection
         size: picking six when two are already off is a four-node change. -->
    <ConfirmDialog
      v-model:open="bulkDisableOpen"
      :title="$t('fleet.nodes.bulk.confirmDisableTitle', { count: bulkDisableCount })"
      :description="$t('fleet.nodes.bulk.confirmDisableDescription', { count: bulkDisableCount, selected: selectedCount })"
      :confirm-label="$t('common.actions.disable')"
      :cancel-label="$t('common.actions.cancel')"
      variant="destructive"
      @confirm="confirmBulkDisable"
    />

    <ConfirmDialog
      v-model:open="rotateOpen"
      :title="$t('fleet.nodes.confirm.rotateTitle')"
      :description="$t('fleet.nodes.confirm.rotateDescription', { name: rotateTarget?.name || rotateTarget?.id })"
      :confirm-label="$t('fleet.nodes.list.rotateToken')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="!!rotateTarget && pendingNode === rotateTarget.id"
      @confirm="confirmRotateToken"
    />

    <ConfirmDialog
      v-model:open="disableOpen"
      :title="$t('fleet.nodes.confirm.disableTitle')"
      :description="$t('fleet.nodes.confirm.disableDescription', { name: disableTarget?.name || disableTarget?.id })"
      :confirm-label="$t('common.actions.disable')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="!!disableTarget && pendingNode === disableTarget.id"
      @confirm="confirmDisable"
    />
  </div>
</template>
