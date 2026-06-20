<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
import { api, unwrap, type EnrollTokenResponse, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMetricBuffer } from "@/composables/useMetricBuffer";
import { useAuthStore } from "@/stores/auth";
import {
  formatBytes,
  formatBytesPerSec,
  formatDateTime,
  formatRelativeTime,
  shortId,
} from "@/lib/format";
import { fleetTotals, groupNodes, type GroupBy, type NodeGroup } from "@/lib/fleet";
import { groupColor } from "@/lib/groupColors";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import NodeCard from "@/components/common/NodeCard.vue";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const auth = useAuthStore();
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
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
const enrollWireGuardIp = ref("");
const enrollPending = ref(false);
const enrollResult = ref<EnrollTokenResponse | undefined>();

const pendingNode = ref<string | undefined>();
const debugPendingNode = ref<string | undefined>();
const rotatedToken = ref<{ node_id: string; token: string } | undefined>();

/* ----------------------------------------------------------------- */
/* Client-side search / status / tag filtering over the polled list.  */
/* ----------------------------------------------------------------- */
type StatusFilter = "all" | "online" | "offline" | "disabled";
const search = ref("");
const statusFilter = ref<StatusFilter>("all");
const activeTags = ref<string[]>([]);

const nodes = computed(() => nodesQuery.data.value ?? []);
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

function matchesSearch(node: Node): boolean {
  const q = search.value.trim().toLowerCase();
  if (!q) return true;
  return [node.name, node.id, node.host_facts?.hostname]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(q));
}

function matchesTags(node: Node): boolean {
  if (activeTags.value.length === 0) return true;
  const owned = new Set<string>([...(node.role ? [node.role] : []), ...(node.tags ?? [])]);
  return activeTags.value.every((tag) => owned.has(tag));
}

const baseSorted = computed(() =>
  [...nodes.value].sort((a, b) => {
    if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

const sortedNodes = computed(() =>
  baseSorted.value.filter((n) => matchesStatus(n) && matchesSearch(n) && matchesTags(n)),
);

const hasFilters = computed(
  () => !!search.value.trim() || statusFilter.value !== "all" || activeTags.value.length > 0,
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
}

/* ----------------------------------------------------------------- */
/* Grouping: bucket the filtered fleet by region / role / status / …  */
/* so a 16+ node fleet reads as clusters, not one long wall of cards.  */
/* ----------------------------------------------------------------- */
const groupBy = ref<GroupBy>("region");
const collapsed = ref<Set<string>>(new Set());

// Group metadata (id -> name/color) for the "Group" grouping mode. Fetched
// lazily the first time the operator picks group grouping; degrades to a single
// Ungrouped bucket if the request fails (e.g. the token lacks group:read).
const fleetGroupsQuery = useAsyncData(() => api.groups.list().then((r) => r.groups), {
  immediate: false,
});
watch(
  groupBy,
  (by) => {
    if (by === "group" && !fleetGroupsQuery.data.value) void fleetGroupsQuery.refresh();
  },
  { immediate: true },
);

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

/* ----------------------------------------------------------------- */
/* Deep-linkable node-detail modal bound to a ?node=<id> query param.  */
/* ----------------------------------------------------------------- */
const selectedNode = computed<Node | undefined>(() => {
  const id = route.query.node;
  if (typeof id !== "string" || !id) return undefined;
  return nodes.value.find((n) => n.id === id);
});

function openNode(node: Node) {
  router.push({ query: { ...route.query, node: node.id } });
}

function closeDetail(open: boolean) {
  if (open) return;
  const next = { ...route.query };
  delete next.node;
  router.replace({ query: next });
}

function parseTags(): string[] {
  return enrollTags.value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Scroll the enroll form into view and focus its first field. */
function focusEnroll() {
  document
    .getElementById("enroll-node-section")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      wireguard_ip: enrollWireGuardIp.value.trim() || undefined,
    });
    enrollName.value = "";
    enrollId.value = "";
    enrollRole.value = "";
    enrollTags.value = "";
    enrollWireGuardIp.value = "";
    toast.success(t("fleet.nodes.toast.tokenCreated"));
    nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.enrollFailed"));
  } finally {
    enrollPending.value = false;
  }
}

async function rotateToken(node: Node) {
  pendingNode.value = node.id;
  rotatedToken.value = undefined;
  try {
    rotatedToken.value = await api.nodes.rotateToken(node.id);
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

async function setNodeDebug(node: Node, enabled: boolean, collect?: boolean) {
  if (!canAdminNodes.value) return;
  debugPendingNode.value = node.id;
  try {
    await api.nodes.setDebug(node.id, enabled, collect);
    toast.success(t("fleet.nodes.toast.debugUpdated"));
    nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.debugFailed"));
  } finally {
    debugPendingNode.value = undefined;
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
        <Button variant="outline" size="sm" :disabled="nodesQuery.refreshing.value" @click="nodesQuery.refresh">
          <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

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

    <Card v-if="canAdminNodes" id="enroll-node-section">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Plus class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('fleet.nodes.enroll.title') }}
        </CardTitle>
        <CardDescription>{{ $t('fleet.nodes.enroll.description') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <form class="grid gap-3 lg:grid-cols-[1.2fr_1fr_0.7fr_1fr_1fr_auto]" @submit.prevent="enrollNode">
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

        <div v-if="enrollResult" class="grid gap-3 rounded-md border border-success/40 bg-success/5 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="text-sm font-medium">{{ $t('fleet.nodes.enroll.tokenFor', { id: enrollResult.node_id }) }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.tokenHint') }}</p>
            </div>
            <CopyButton :value="enrollResult.command || enrollResult.token" :label="$t('fleet.nodes.enroll.copyCommand')" />
          </div>
          <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">
            {{ enrollResult.command || enrollResult.token }}
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
          </div>

          <div v-if="allTags.length" class="flex flex-wrap items-center gap-1.5">
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
                :class="cn('grid gap-3 xl:grid-cols-2', groupBy !== 'none' && 'mt-3')"
              >
                <NodeCard
                  v-for="node in group.nodes"
                  :key="node.id"
                  :node="node"
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
                >
                  <template #footer="{ node: cardNode }">
                    <p class="mt-3 font-mono text-xs text-muted-foreground">
                      {{ shortId(cardNode.id, 16) }} · {{ $t('fleet.nodes.list.lastSeen', { time: formatRelativeTime(cardNode.last_seen) }) }}
                    </p>
                    <div v-if="canOpenTerminal || canAdminNodes" class="mt-3 flex flex-wrap gap-2">
                      <Button
                        v-if="canOpenTerminal"
                        size="sm"
                        variant="outline"
                        :disabled="!cardNode.online || cardNode.disabled"
                        @click="openTerminal(cardNode)"
                      >
                        <SquareTerminal class="size-4" aria-hidden="true" />
                        {{ $t('fleet.nodes.list.openTerminal') }}
                      </Button>
                      <Button v-if="canAdminNodes" size="sm" variant="outline" :disabled="pendingNode === cardNode.id" @click="rotateToken(cardNode)">
                        <KeyRound class="size-4" aria-hidden="true" />
                        {{ $t('fleet.nodes.list.rotateToken') }}
                      </Button>
                      <Button
                        v-if="canAdminNodes"
                        size="sm"
                        :variant="cardNode.disabled ? 'outline' : 'destructive'"
                        :disabled="pendingNode === cardNode.id"
                        @click="setDisabled(cardNode, !cardNode.disabled)"
                      >
                        <Power class="size-4" aria-hidden="true" />
                        {{ cardNode.disabled ? $t('common.actions.enable') : $t('common.actions.disable') }}
                      </Button>
                    </div>
                  </template>
                </NodeCard>
              </div>
            </section>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <Dialog :open="!!selectedNode" @update:open="closeDetail">
      <DialogContent class="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ selectedNode?.name || selectedNode?.id }}</DialogTitle>
          <DialogDescription>
            {{ selectedNode?.id }} · {{ selectedNode?.online ? $t('common.status.online') : $t('common.status.offline') }}
          </DialogDescription>
        </DialogHeader>
        <div v-if="selectedNode" class="space-y-5">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.nodes.detail.agent') }}</p>
              <p class="mt-1 text-sm">{{ selectedNode.agent_version || $t('fleet.nodes.detail.unknown') }}</p>
            </div>
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.nodes.detail.lastSeen') }}</p>
              <p class="mt-1 text-sm">{{ formatDateTime(selectedNode.last_seen) }}</p>
            </div>
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.nodes.detail.publicIp') }}</p>
              <p class="mt-1 font-mono text-sm">{{ selectedNode.public_ip || selectedNode.public_ipv6 || $t('fleet.nodes.detail.unknown') }}</p>
            </div>
            <div class="rounded-md border border-border p-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.nodes.detail.wireguard') }}</p>
              <p class="mt-1 font-mono text-sm">{{ selectedNode.wireguard_ip || $t('fleet.nodes.detail.notSet') }}</p>
            </div>
          </div>

          <div v-if="canAdminNodes" class="rounded-md border border-border p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="space-y-1">
                <h3 class="text-sm font-medium">{{ $t('fleet.nodes.detail.diagnostics') }}</h3>
                <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.debugDescription') }}</p>
              </div>
              <Badge :variant="selectedNode.agent_debug?.enabled ? 'warning' : 'secondary'">
                {{ selectedNode.agent_debug?.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
              </Badge>
            </div>
            <div class="mt-4 grid gap-3">
              <label class="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-primary"
                  :checked="!!selectedNode.agent_debug?.enabled"
                  :disabled="debugPendingNode === selectedNode.id"
                  @change="setNodeDebug(selectedNode, ($event.target as HTMLInputElement).checked, selectedNode.agent_debug?.collect ?? true)"
                />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('fleet.nodes.detail.debugEnabled') }}</span>
                  <span class="block text-muted-foreground">{{ $t('fleet.nodes.detail.debugLocalHint') }}</span>
                </span>
              </label>
              <label class="flex items-start gap-3 text-sm" :class="!selectedNode.agent_debug?.enabled && 'opacity-60'">
                <input
                  type="checkbox"
                  class="mt-0.5 size-4 accent-primary"
                  :checked="!!selectedNode.agent_debug?.collect"
                  :disabled="!selectedNode.agent_debug?.enabled || debugPendingNode === selectedNode.id"
                  @change="setNodeDebug(selectedNode, true, ($event.target as HTMLInputElement).checked)"
                />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('fleet.nodes.detail.debugCollect') }}</span>
                  <span class="block text-muted-foreground">{{ $t('fleet.nodes.detail.debugCollectHint', { path: `agent-debug://${selectedNode.id}` }) }}</span>
                </span>
              </label>
            </div>
          </div>

          <div v-if="canOpenTerminal" class="rounded-md border border-border p-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="space-y-1">
                <h3 class="text-sm font-medium">{{ $t('fleet.nodes.detail.terminal') }}</h3>
                <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.terminalDescription') }}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                :disabled="!selectedNode.online || selectedNode.disabled"
                @click="openTerminal(selectedNode)"
              >
                <SquareTerminal class="size-4" aria-hidden="true" />
                {{ $t('fleet.nodes.list.openTerminal') }}
              </Button>
            </div>
          </div>

          <div v-if="selectedNode.host_facts" class="space-y-3">
            <h3 class="text-sm font-medium">{{ $t('fleet.nodes.detail.hostFacts') }}</h3>
            <div class="grid gap-2 sm:grid-cols-2">
              <div class="rounded-md bg-muted/40 p-3 text-sm">{{ $t('fleet.nodes.detail.os', { value: selectedNode.host_facts.os || $t('fleet.nodes.detail.unknown') }) }}</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm">{{ $t('fleet.nodes.detail.arch', { value: selectedNode.host_facts.arch || $t('fleet.nodes.detail.unknown') }) }}</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm">{{ $t('fleet.nodes.detail.cpuCores', { value: selectedNode.host_facts.cpu_cores || "?" }) }}</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm">{{ $t('fleet.nodes.detail.memory', { value: formatBytes(selectedNode.host_facts.memory_total) }) }}</div>
              <div class="rounded-md bg-muted/40 p-3 text-sm sm:col-span-2">{{ $t('fleet.nodes.detail.kernel', { value: selectedNode.host_facts.kernel || $t('fleet.nodes.detail.unknown') }) }}</div>
            </div>
          </div>

          <div v-else class="flex items-center gap-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
            <AlertTriangle class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.noHostFacts') }}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
