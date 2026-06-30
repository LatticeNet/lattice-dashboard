<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
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
  formatBytesPerSec,
  formatRelativeTime,
  shortId,
} from "@/lib/format";
import { fleetTotals, groupNodes, type GroupBy, type NodeGroup } from "@/lib/fleet";
import { groupColor } from "@/lib/groupColors";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import NodeCard from "@/components/common/NodeCard.vue";
import NodeTable from "@/components/common/NodeTable.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
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
import { Badge } from "@/components/ui/badge";
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
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
});
const agentUpdatesQuery = useAsyncData(() => api.agentUpdates.list().then((r) => unwrap(r, "policies")), {
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
const enrollWireGuardIp = ref("");
const enrollGroups = ref<string[]>([]);
const enrollOpen = ref(false);
const enrollAdvancedOpen = ref(false);
const enrollAllowExec = ref(false);
const enrollAllowRootExec = ref(false);
const enrollNoExec = ref(false);
const enrollAllowTerminal = ref(false);
const enrollTerminalTransport = ref<"poll" | "stream">("poll");
const enrollSSHAlerts = ref(false);
const enrollSingBoxDiscover = ref(false);
const enrollSingBoxBin = ref("sb");
const enrollProxyUsageFile = ref("");
const enrollProxyUsageURL = ref("");
const enrollProxyUsageXrayAPI = ref("");
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
const viewMode = ref<ViewMode>("card");
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

const nodes = computed(() => nodesQuery.data.value ?? []);
const updatePolicies = computed(() => agentUpdatesQuery.data.value ?? []);
// Suspected-duplicate detection (NAT-safe; server-clustered). Polled lazily.
const duplicatesQuery = useAsyncData(() => api.nodes.duplicates().then((r) => r.groups), {
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
    node.wireguard_ip,
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

const baseSorted = computed(() =>
  [...nodes.value].sort((a, b) => {
    if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

const sortedNodes = computed(() => {
  const q = search.value.trim().toLowerCase();
  const filtered = baseSorted.value.filter(
    (n) => matchesStatus(n) && matchesSearch(n) && matchesTags(n) && matchesArchOs(n),
  );
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
    activeArchOs.value.length > 0,
);
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
}

/* ----------------------------------------------------------------- */
/* Grouping: bucket the filtered fleet by region / role / status / …  */
/* so a 16+ node fleet reads as clusters, not one long wall of cards.  */
/* ----------------------------------------------------------------- */
const groupBy = ref<GroupBy>("region");
const collapsed = ref<Set<string>>(new Set());

// Group metadata (id -> name/color/leader) for group chips on every card AND the
// "Group" grouping mode. Fetched EAGERLY so chips render on first paint (it used
// to be lazy — only on groupBy==='group'); degrades to no chips / a single
// Ungrouped bucket if the request fails (e.g. the token lacks group:read).
const fleetGroupsQuery = useAsyncData(() => api.groups.list().then((r) => r.groups), {
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
  groupNodes(sortedNodes.value, groupBy.value, locale.value, fleetGroupsQuery.data.value ?? []),
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

function enrollAgentLaunch(): AgentLaunchConfig {
  return {
    allow_exec: enrollAllowExec.value,
    allow_root_exec: enrollAllowRootExec.value,
    no_exec: enrollNoExec.value,
    allow_terminal: enrollAllowTerminal.value,
    terminal_transport: enrollAllowTerminal.value ? enrollTerminalTransport.value : undefined,
    ssh_alerts: enrollSSHAlerts.value,
    singbox_discover: enrollSingBoxDiscover.value,
    singbox_bin: enrollSingBoxDiscover.value ? enrollSingBoxBin.value.trim() || "sb" : undefined,
    proxy_usage_file: enrollProxyUsageFile.value.trim() || undefined,
    proxy_usage_url: enrollProxyUsageURL.value.trim() || undefined,
    proxy_usage_xray_api: enrollProxyUsageXrayAPI.value.trim() || undefined,
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
      wireguard_ip: enrollWireGuardIp.value.trim() || undefined,
      group_ids: enrollGroups.value.length ? [...enrollGroups.value] : undefined,
      agent_launch: enrollAgentLaunch(),
    });
    enrollName.value = "";
    enrollId.value = "";
    enrollRole.value = "";
    enrollTags.value = "";
    enrollComment.value = "";
    enrollWireGuardIp.value = "";
    enrollGroups.value = [];
    enrollAllowExec.value = false;
    enrollAllowRootExec.value = false;
    enrollNoExec.value = false;
    enrollAllowTerminal.value = false;
    enrollTerminalTransport.value = "poll";
    enrollSSHAlerts.value = false;
    enrollSingBoxDiscover.value = false;
    enrollSingBoxBin.value = "sb";
    enrollProxyUsageFile.value = "";
    enrollProxyUsageURL.value = "";
    enrollProxyUsageXrayAPI.value = "";
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

async function rotateToken(node: Node) {
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
  }
}

async function setDisabled(node: Node, disabled: boolean) {
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
      <p class="text-sm font-medium text-warning">
        ⚠ {{ $t('fleet.nodes.duplicates.title', { count: duplicateGroups.length }) }}
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

    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.stats.total') }}</p>
            <p class="text-2xl font-semibold">{{ nodes.length }}</p>
          </div>
          <Server class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.stats.online') }}</p>
            <p class="text-2xl font-semibold text-success">{{ onlineCount }}</p>
          </div>
          <Wifi class="size-5 text-success" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.stats.disabled') }}</p>
            <p class="text-2xl font-semibold text-muted-foreground">{{ disabledCount }}</p>
          </div>
          <Power class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.stats.bandwidth') }}</p>
          <div class="mt-1 flex items-center gap-3 text-lg font-semibold tabular">
            <span class="inline-flex items-center gap-1 text-foreground">
              <ArrowDown class="size-4 text-success" aria-hidden="true" />{{ formatBytesPerSec(totals.netRxSpeed) }}
            </span>
            <span class="inline-flex items-center gap-1 text-foreground">
              <ArrowUp class="size-4 text-primary" aria-hidden="true" />{{ formatBytesPerSec(totals.netTxSpeed) }}
            </span>
          </div>
        </CardContent>
      </Card>
    </div>

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
          <div class="grid gap-2">
            <Label for="enroll-wg">{{ $t('fleet.nodes.enroll.wireguardIp') }}</Label>
            <Input id="enroll-wg" v-model="enrollWireGuardIp" :placeholder="$t('common.misc.optional')" />
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
              <input v-model="enrollAllowExec" type="checkbox" class="mt-0.5 size-4" :disabled="enrollNoExec" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowExec') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowExecHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <input v-model="enrollAllowRootExec" type="checkbox" class="mt-0.5 size-4" :disabled="enrollNoExec || !enrollAllowExec" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowRootExec') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowRootExecHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <input v-model="enrollNoExec" type="checkbox" class="mt-0.5 size-4" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.noExec') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.noExecHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <input v-model="enrollAllowTerminal" type="checkbox" class="mt-0.5 size-4" :disabled="enrollNoExec" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowTerminal') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowTerminalHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <input v-model="enrollSSHAlerts" type="checkbox" class="mt-0.5 size-4" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.sshAlerts') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.sshAlertsHint') }}</span>
              </span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
              <input v-model="enrollSingBoxDiscover" type="checkbox" class="mt-0.5 size-4" />
              <span>
                <span class="block font-medium">{{ $t('fleet.nodes.enroll.singBoxDiscover') }}</span>
                <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.singBoxDiscoverHint') }}</span>
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
            <div class="grid gap-1.5">
              <Label>{{ $t('fleet.nodes.enroll.singBoxBin') }}</Label>
              <Input v-model="enrollSingBoxBin" :disabled="!enrollSingBoxDiscover" placeholder="sb" />
            </div>
            <div class="grid gap-1.5">
              <Label>{{ $t('fleet.nodes.enroll.proxyUsageFile') }}</Label>
              <Input v-model="enrollProxyUsageFile" placeholder="/run/lattice/proxy-usage.json" />
            </div>
            <div class="grid gap-1.5">
              <Label>{{ $t('fleet.nodes.enroll.proxyUsageUrl') }}</Label>
              <Input v-model="enrollProxyUsageURL" placeholder="http://127.0.0.1:19090/stats" />
            </div>
            <div class="grid gap-1.5 md:col-span-2">
              <Label>{{ $t('fleet.nodes.enroll.proxyUsageXray') }}</Label>
              <Input v-model="enrollProxyUsageXrayAPI" placeholder="127.0.0.1:10085" />
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
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                enrollPlatform === 'linux' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )"
              @click="enrollPlatform = 'linux'"
            >
              {{ $t('fleet.nodes.enroll.platformLinux') }}
            </button>
            <button
              type="button"
              :class="cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                enrollPlatform === 'manual' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )"
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
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium transition-colors',
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
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium transition-colors',
                  viewMode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )"
                :aria-pressed="viewMode === 'list'"
                @click="viewMode = 'list'"
              >
                <List class="size-4" aria-hidden="true" />
                <span class="hidden sm:inline">{{ $t('fleet.nodes.view.list') }}</span>
              </button>
            </div>
          </div>

          <div v-if="availableArchOs.length || allTags.length" class="flex flex-wrap items-center gap-1.5">
            <!-- Arch / OS quick filters (computed from the fleet's host facts). -->
            <button
              v-for="tok in availableArchOs"
              :key="`archos:${tok}`"
              type="button"
              :class="cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors surface-interactive',
                activeArchOs.includes(tok)
                  ? 'border-info bg-info/10 text-info'
                  : 'border-border text-muted-foreground hover:bg-muted/40',
              )"
              :aria-pressed="activeArchOs.includes(tok)"
              @click="toggleArchOs(tok)"
            >
              {{ tok }}
            </button>
            <span
              v-if="availableArchOs.length && allTags.length"
              class="mx-1 h-4 w-px bg-border"
              aria-hidden="true"
            ></span>
            <button
              v-for="tag in allTags"
              :key="tag"
              type="button"
              :class="cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors surface-interactive',
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

          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>{{ $t('fleet.nodes.filters.showing', { shown: sortedNodes.length, total: nodes.length }) }}</span>
            <Button v-if="hasFilters" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="clearFilters">
              <X class="size-3.5" aria-hidden="true" />
              {{ $t('fleet.nodes.filters.clear') }}
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
              :description="$t('fleet.nodes.list.emptyDescriptionAlt')"
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
                  :offline-label="t('common.status.offline')"
                  :disabled-label="t('common.status.disabled')"
                  :sparkline-label="t('fleet.nodes.metric.sparklineLabel')"
                  @select="openNode(node)"
                  @group-select="goToGroup"
                >
                  <template #footer="{ node: cardNode }">
                    <p class="mt-3 font-mono text-xs text-muted-foreground">
                      {{ shortId(cardNode.id, 16) }} · {{ $t('fleet.nodes.list.lastSeen', { time: formatRelativeTime(cardNode.last_seen) }) }}
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
                  :can-open-terminal="canOpenTerminal"
                  :can-admin-nodes="canAdminNodes"
                  :pending-node-id="pendingNode"
                  :update-policies="updatePolicies"
                  @open="openNode"
                  @terminal="openTerminal"
                  @rotate="rotateToken"
                  @set-disabled="setDisabled"
                />
              </div>
            </section>
          </div>
        </DataState>
      </CardContent>
    </Card>

  </div>
</template>
