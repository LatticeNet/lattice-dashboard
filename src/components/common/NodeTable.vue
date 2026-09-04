<script setup lang="ts">
/**
 * NodeTable: the horizontal, scan-many-nodes counterpart to {@link NodeCard}.
 *
 * A grid-cols header + rows wrapped in `overflow-x-auto` so the dense column
 * set scrolls horizontally on narrow viewports instead of wrapping. The grid
 * template is computed from the visible column set (column manager lives in
 * the caller's toolbar), and sortable headers re-emit `toggle-sort`. State
 * ownership stays with NodesView, which persists it.
 *
 * Presentational only. It does NOT fetch and does NOT mutate. It re-emits the
 * same intents NodesView already wires for NodeCard (`open` / `terminal` /
 * `rotate` / `set-disabled`) so the two view modes share one set of handlers.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, KeyRound, Power, SquareTerminal } from "lucide-vue-next";
import type { AgentUpdatePolicy, Node } from "@/lib/api/types";
import { hasNeverReported, statusMeta, type BadgeVariant, type NodeHealth } from "@/lib/status";
import { describeNodeStatus, metricFreshness, nodeStatusReason } from "@/lib/nodeStatus";
import { splitNamePrefix } from "@/lib/fleet";
import { formatBytes, formatBytesPerSec, formatRelativeTime, shortId } from "@/lib/format";
import { agentConfigBadges } from "@/lib/nodeFilterExpressions";
import {
  gridTemplate,
  nameTrackMin,
  visibleColumns,
  type NodeSortState,
  type NodeTableColumn,
} from "@/views/fleet/nodesTableModel";
import { selectionHeaderState } from "@/views/fleet/fleetBulkModel";

import { Checkbox } from "@/components/ui/checkbox";
import StatusDot from "@/components/common/StatusDot.vue";
import MetricBar from "@/components/common/MetricBar.vue";
import { Badge } from "@/components/ui/badge";
import NodeStatusBadge from "@/components/common/NodeStatusBadge.vue";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    /** Rows to render (already filtered/sorted by the caller). */
    nodes: Node[];
    /** Ids of optional columns the caller has hidden. */
    hiddenColumns?: ReadonlySet<string>;
    /** Active sort; drives header indicators and aria-sort. */
    sort?: NodeSortState;
    /** Gate the terminal action. */
    canOpenTerminal?: boolean;
    /** Gate the rotate / disable actions. */
    canAdminNodes?: boolean;
    /** Id of the node with an in-flight mutation (disables its action buttons). */
    pendingNodeId?: string;
    /** Optional per-node agent update policies for the compact status column. */
    updatePolicies?: AgentUpdatePolicy[];
    /** Render the leading selection column. */
    selectable?: boolean;
    /** Ids currently selected, across every group the caller renders. */
    selectedIds?: ReadonlySet<string>;
  }>(),
  {
    hiddenColumns: () => new Set<string>(),
    sort: () => ({ key: "", dir: "asc" }),
    canOpenTerminal: false,
    canAdminNodes: false,
    pendingNodeId: undefined,
    updatePolicies: () => [],
    selectable: false,
    selectedIds: () => new Set<string>(),
  },
);

const emit = defineEmits<{
  /** Row / name activated. Caller opens the node detail page. */
  (e: "open", node: Node): void;
  /** Terminal action button. */
  (e: "terminal", node: Node): void;
  /** Rotate-token action button. */
  (e: "rotate", node: Node): void;
  /** Enable/disable toggle. Second arg is the desired `disabled` value. */
  (e: "set-disabled", node: Node, disabled: boolean): void;
  /** Sortable header activated. Caller advances its sort-state machine. */
  (e: "toggle-sort", columnId: string): void;
  /** One row's selection checkbox changed. */
  (e: "toggle-select", nodeId: string): void;
  /** The header checkbox changed: every row this table renders takes `on`. */
  (e: "toggle-select-all", nodeIds: string[], on: boolean): void;
}>();

const { t } = useI18n();

const columns = computed(() => visibleColumns(props.hiddenColumns));
/** The name track never drops below what the longest name in these rows needs. */
const nameMin = computed(() => nameTrackMin(props.nodes));
/** The selection column is a fixed leading track, so hiding columns still works. */
const SELECT_TRACK = "36px";
const gridStyle = computed(() => ({
  gridTemplateColumns: props.selectable
    ? `${SELECT_TRACK} ${gridTemplate(props.hiddenColumns, nameMin.value)}`
    : gridTemplate(props.hiddenColumns, nameMin.value),
}));

const rowIds = computed(() => props.nodes.map((node) => node.id));
const allSelected = computed(() => selectionHeaderState(props.selectedIds, rowIds.value));
function isSelected(node: Node): boolean {
  return props.selectedIds.has(node.id);
}
/** The min width shrinks as columns are hidden: roughly the sum of fixed
 *  tracks plus room for the flexible ones, the name at its content minimum. */
const minWidth = computed(() => {
  let px = 0;
  for (const column of columns.value) {
    const fixed = /^(\d+)px$/.exec(column.width);
    if (fixed) px += Number(fixed[1]);
    else px += column.id === "name" ? nameMin.value : 200;
  }
  if (props.selectable) px += 36 + 12;
  return `${px + (columns.value.length - 1) * 12 + 24}px`;
});

function show(id: string): boolean {
  return columns.value.some((c) => c.id === id);
}

function headerLabel(column: NodeTableColumn): string {
  return t(column.labelKey);
}

function ariaSort(column: NodeTableColumn): "ascending" | "descending" | "none" {
  if (!column.sortKey || props.sort.key !== column.sortKey) return "none";
  return props.sort.dir === "asc" ? "ascending" : "descending";
}

/** One reading per row: the control plane's status word, from the status module. */
function info(node: Node) {
  return describeNodeStatus(node);
}

/** The agent is in contact: online or degraded. Disabled outranks a live agent. */
function isLive(node: Node): boolean {
  return info(node).reporting;
}

/** The dot, the badge colour and the badge text all read the same word. */
function dotStatus(node: Node): NodeHealth {
  return info(node).health;
}

function statusLabel(node: Node): string {
  return t(info(node).labelKey);
}

/**
 * The leading cells stay put while the rest of the row scrolls under them.
 *
 * `left` is the cell's resting offset (the row's px-3, plus the selection
 * track and its gap when there is one) so a pinned cell sits exactly where an
 * unpinned one did. Painted opaque so scrolled cells pass behind, which means
 * the row's translucent hover tint has to be composited onto it by hand.
 *
 * From sm up only. Below it the pinned cells would be the whole viewport:
 * a 239px name track plus the selection track is 299px of a 327px-wide table
 * on a 375px phone, leaving 28px for everything else to scroll through. There
 * the table scrolls freely and the name scrolls with it.
 */
const STICKY_CELL =
  "sm:sticky z-10 bg-background group-hover/row:bg-[color-mix(in_oklab,var(--foreground)_3%,var(--background))]";
const stickyLeft = computed(() => (props.selectable ? "sm:left-15" : "sm:left-3"));

/** The server's one-sentence account, shown on hover so the word can be checked. */
function statusTitle(node: Node): string {
  return nodeStatusReason(node) || t(info(node).hintKey);
}

/**
 * Say "never checked in" rather than formatting the server's zero time, which
 * renders as a six-figure number of days ago. The reading itself lives in
 * `@/lib/status`; this used to be a private copy of it in each of three views.
 */
function lastSeenLabel(node: Node): string {
  if (hasNeverReported(node)) return t("fleet.nodes.list.neverSeen");
  return formatRelativeTime(node.last_seen);
}

function statusVariant(node: Node): BadgeVariant {
  return statusMeta(dotStatus(node)).badgeVariant;
}

/**
 * Nothing was ever measured on this machine. The bars print the no-value mark
 * instead of a zero, the same mark the network cell already printed, so one
 * row does not answer the same absence in two different ways.
 */
function noSample(node: Node): boolean {
  return metricFreshness(node, !!node.metrics) === "none";
}

/**
 * The one state that needs no emphasis. Everything else - degraded, offline,
 * never reported, disabled - is something an operator may have to act on, and
 * keeps its pill.
 */
function isHealthy(node: Node): boolean {
  return !info(node).attention;
}

/**
 * The identifier printed beside the name, or "" when it would just repeat it.
 *
 * The hostname is the useful second value when it differs from the display
 * name; when it does not (the common case on a fleet named after its hosts)
 * the node id is what actually disambiguates two machines sharing a name.
 * Printing a duplicate of the name in every row is what the old two-line cell
 * did, and it cost 15px of row height to say nothing.
 */
function namePrefix(node: Node): string {
  return splitNamePrefix(node).prefix;
}
function nameBody(node: Node): string {
  return splitNamePrefix(node).body;
}

function secondaryLabel(node: Node): string {
  const name = node.name || node.id;
  const hostname = node.host_facts?.hostname ?? "";
  if (hostname && hostname !== name) return hostname;
  const id = shortId(node.id, 16);
  return id === name ? "" : id;
}

function archOs(node: Node): string {
  return node.host_facts?.os || node.host_facts?.platform || t("common.misc.none");
}

function sortedTags(node: Node): string[] {
  return [...(node.tags ?? [])].sort((a, b) => a.localeCompare(b));
}

function updatePolicy(node: Node): AgentUpdatePolicy | undefined {
  return props.updatePolicies.find((p) => p.node_id === node.id);
}

function updateLabel(policy?: AgentUpdatePolicy): string {
  if (!policy) return t("fleet.nodes.list.noUpdatePolicy");
  if (policy.enabled && policy.auto_plan) return t("fleet.nodes.list.autoUpdate");
  return t("fleet.nodes.list.manualUpdate");
}

function updateVariant(policy?: AgentUpdatePolicy): "success" | "secondary" | "outline" {
  if (!policy) return "outline";
  if (policy.enabled && policy.auto_plan) return "success";
  return "secondary";
}

function agentBadges(node: Node): string[] {
  return agentConfigBadges(node);
}

/** Public IPv4 is the primary column; the rest ride along in the cell tooltip. */
function ipTooltip(node: Node): string {
  const lines = [
    `${t("fleet.nodes.detail.publicIp")}: ${node.public_ip || t("common.misc.none")}`,
    `${t("fleet.nodes.detail.publicIpv6")}: ${node.public_ipv6 || t("common.misc.none")}`,
    `${t("fleet.nodes.detail.internalIp")}: ${node.internal_ip || t("common.misc.none")}`,
    `${t("fleet.nodes.detail.internalIpv6")}: ${node.internal_ipv6 || t("common.misc.none")}`,
  ];
  return lines.join("\n");
}

function onOpen(node: Node): void {
  emit("open", node);
}

/**
 * Enter or Space on the row opens the node, but only when the row itself has
 * focus. Without the guard, keyboard use of the selection checkbox or a
 * per-row action button would also navigate away.
 */
function onRowKey(node: Node, event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return;
  emit("open", node);
}
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-border">
    <div :style="{ minWidth }">
      <!-- Header.
           Not sticky vertically, deliberately. `overflow-x-auto` on the wrapper
           makes it the nearest scroll container in both axes, so a
           `position: sticky` header here would stick to a box that never
           scrolls vertically and do nothing at all. Pinning it needs the table
           to own its vertical scroll (a bounded height inside the page pane),
           which is a page-scroll change, not a table change. Horizontally the
           wrapper does scroll, so from sm up the leading cells of the header
           and of every row pin to the left edge and the name stays readable
           while the metric columns pass underneath it. -->
      <div
        class="grid h-8 items-center gap-3 border-b border-border bg-card px-3 text-xs font-medium text-muted-foreground"
        :style="gridStyle"
        role="row"
      >
        <span v-if="selectable" class="z-10 flex items-center bg-card sm:sticky sm:left-3">
          <Checkbox
            :model-value="allSelected"
            :aria-label="$t('fleet.nodes.bulk.selectAllVisible')"
            @update:model-value="(value) => emit('toggle-select-all', rowIds, value === true)"
          />
        </span>
        <template v-for="column in columns" :key="column.id">
          <button
            v-if="column.sortKey"
            type="button"
            class="inline-flex items-center gap-1 text-left transition-colors hover:text-foreground"
            :class="[column.id === 'actions' && 'justify-end', column.id === 'name' && ['z-10 bg-card sm:sticky', stickyLeft]]"
            :aria-sort="ariaSort(column)"
            :title="$t('common.table.sortBy', { column: headerLabel(column) })"
            @click="emit('toggle-sort', column.id)"
          >
            <span>{{ headerLabel(column) }}</span>
            <ChevronUp
              v-if="sort.key === column.sortKey && sort.dir === 'asc'"
              class="size-3 text-foreground"
              aria-hidden="true"
            />
            <ChevronDown
              v-else-if="sort.key === column.sortKey && sort.dir === 'desc'"
              class="size-3 text-foreground"
              aria-hidden="true"
            />
          </button>
          <span v-else :class="column.id === 'actions' && 'text-right'">{{ headerLabel(column) }}</span>
        </template>
      </div>

      <!-- Rows.
           One fixed height for every row, taken from --row-h so the density
           toggle reaches all of them at once. Nothing in a cell may wrap: a
           row that grows to fit its tag list drags every column beside it out
           of alignment, and the cost lands on the scan, which is the only
           thing this view is for. Cells that can overflow truncate and put the
           full value in a tooltip or on the detail page. -->
      <div
        v-for="node in nodes"
        :key="node.id"
        class="group/row grid h-(--row-h) items-center gap-3 border-b border-border/60 px-3 text-sm transition-colors last:border-b-0 hover:bg-foreground/3 focus-visible:bg-foreground/5 focus-visible:outline-none"
        :style="gridStyle"
        :class="!isLive(node) && 'opacity-60'"
        role="button"
        :tabindex="0"
        :aria-label="node.name || node.id"
        :aria-selected="selectable ? isSelected(node) : undefined"
        @click="onOpen(node)"
        @keydown.enter.prevent="onRowKey(node, $event)"
        @keydown.space.prevent="onRowKey(node, $event)"
      >
        <!-- Selection. Stops both click and key so the checkbox can be used
             without the row's open-node handler firing underneath it. -->
        <span v-if="selectable" :class="['flex items-center sm:left-3', STICKY_CELL]" @click.stop @keydown.stop>
          <Checkbox
            :model-value="isSelected(node)"
            :aria-label="$t('fleet.nodes.bulk.selectRow', { name: node.name || node.id })"
            @update:model-value="emit('toggle-select', node.id)"
          />
        </span>

        <!-- Name + status dot. The name never truncates: the track is at
             least as wide as the longest name in the table (nameTrackMin) and
             the table scrolls past that, so a long name pushes the metric
             columns right rather than losing characters. It used to share the
             line with the identifier, shrinking in proportion to it, which on
             a fleet whose hostnames all differ from their names cut every
             long name to "Akkocloud-UK-Lond...". The identifier now sits on a
             second line inside the fixed 40px row (20px name over 16px
             hostname). It is the tiebreak for two machines sharing a name,
             not something anyone reads across 200 rows, so it goes away where
             there is no room for it: at compact density (a 32px row) and
             below sm. The tooltip carries both. -->
        <div
          :class="['flex min-w-0 items-center gap-2', STICKY_CELL, stickyLeft]"
          :title="secondaryLabel(node) ? `${node.name || node.id}\n${secondaryLabel(node)}` : node.name || node.id"
        >
          <StatusDot :status="dotStatus(node)" :pulse="isLive(node)" class="shrink-0" />
          <Badge v-if="namePrefix(node)" variant="outline" class="shrink-0 px-1 py-0 text-[10px] leading-4">{{ namePrefix(node) }}</Badge>
          <div class="min-w-0">
            <p class="whitespace-nowrap text-sm leading-5 font-medium">{{ nameBody(node) }}</p>
            <p
              v-if="secondaryLabel(node)"
              class="density-secondary hidden truncate font-mono text-xs leading-4 text-muted-foreground tabular sm:block"
            >{{ secondaryLabel(node) }}</p>
          </div>
        </div>

        <!-- Status. A healthy node says so quietly: the dot beside the name
             already carries the colour, so a filled pill on every row of a
             33-row fleet is 33 pieces of emphasis competing for none. Only the
             states that want an operator keep the pill. -->
        <div class="min-w-0">
          <NodeStatusBadge
            v-if="!isHealthy(node)"
            :variant="statusVariant(node)"
            :label="statusLabel(node)"
            :reason="statusTitle(node)"
            class="max-w-full truncate"
          />
          <span v-else class="text-xs text-muted-foreground">{{ statusLabel(node) }}</span>
        </div>

        <!-- Role -->
        <div v-if="show('role')" class="min-w-0">
          <!-- An unset role renders as nothing, matching every other role
               surface; a column of "none" was noise wearing a label. -->
          <Badge v-if="node.role" variant="secondary" class="max-w-full truncate">{{ node.role }}</Badge>
        </div>

        <!-- Tags. Capped at two on one line with a count for the rest, and the
             full list in the cell tooltip. Wrapping this cell is what made row
             heights uneven across the table. -->
        <div
          v-if="show('tags')"
          class="flex min-w-0 items-center gap-1 overflow-hidden"
          :title="sortedTags(node).join(', ')"
        >
          <Badge
            v-for="tag in sortedTags(node).slice(0, 2)"
            :key="tag"
            variant="outline"
            class="max-w-full shrink truncate"
          >
            {{ tag }}
          </Badge>
          <Badge v-if="sortedTags(node).length > 2" variant="secondary" class="shrink-0">
            +{{ sortedTags(node).length - 2 }}
          </Badge>
          <span v-if="sortedTags(node).length === 0" class="text-muted-foreground">{{ $t('common.misc.none') }}</span>
        </div>

        <!-- Public IPv4 (other addresses in the tooltip) -->
        <div v-if="show('publicIp')" class="min-w-0" :title="ipTooltip(node)">
          <p class="truncate font-mono text-xs">{{ node.public_ip || $t('common.misc.none') }}</p>
        </div>

        <!-- Arch / OS -->
        <div v-if="show('archOs')" class="min-w-0">
          <p class="truncate">{{ archOs(node) }}</p>
          <p class="truncate text-xs text-muted-foreground">{{ node.host_facts?.arch || $t('common.misc.none') }}</p>
        </div>

        <!-- Agent runtime capabilities -->
        <div
          v-if="show('agentConfig')"
          class="flex min-w-0 items-center gap-1 overflow-hidden"
          :title="agentBadges(node).join(', ')"
        >
          <Badge
            v-for="badge in agentBadges(node).slice(0, 2)"
            :key="`${node.id}:${badge}`"
            variant="outline"
            class="max-w-full shrink truncate"
          >
            {{ badge }}
          </Badge>
          <Badge v-if="agentBadges(node).length > 2" variant="secondary" class="shrink-0">
            +{{ agentBadges(node).length - 2 }}
          </Badge>
          <span v-if="agentBadges(node).length === 0" class="text-muted-foreground">{{ $t('common.misc.none') }}</span>
        </div>

        <!-- CPU / Memory / Disk mini-bars -->
        <MetricBar
          v-if="show('cpu')"
          tone="cpu"
          :percent="node.metrics?.cpu_percent"
          :unavailable="noSample(node)"
        />
        <MetricBar
          v-if="show('memory')"
          tone="memory"
          :used="node.metrics?.memory_used"
          :total="node.metrics?.memory_total"
          :unavailable="noSample(node)"
        />
        <MetricBar
          v-if="show('disk')"
          tone="disk"
          :used="node.metrics?.disk_used"
          :total="node.metrics?.disk_total"
          :unavailable="noSample(node)"
        />

        <!-- Net rx / tx -->
        <div
          v-if="show('network')"
          class="grid grid-cols-2 gap-x-2 text-xs text-muted-foreground tabular"
          :title="`RX total: ${formatBytes(node.metrics?.net_rx_bytes)}\nTX total: ${formatBytes(node.metrics?.net_tx_bytes)}`"
        >
          <p class="flex items-center gap-1 whitespace-nowrap">
            <ArrowDown class="size-3 shrink-0 text-success" aria-hidden="true" />
            <span>{{ formatBytesPerSec(node.metrics?.net_rx_speed) }}</span>
          </p>
          <p class="flex items-center gap-1 whitespace-nowrap">
            <ArrowUp class="size-3 shrink-0 text-primary" aria-hidden="true" />
            <span>{{ formatBytesPerSec(node.metrics?.net_tx_speed) }}</span>
          </p>
          <span class="whitespace-nowrap text-[10px] text-muted-foreground/80">{{
            formatBytes(node.metrics?.net_rx_bytes)
          }}</span>
          <span class="whitespace-nowrap text-[10px] text-muted-foreground/80">{{
            formatBytes(node.metrics?.net_tx_bytes)
          }}</span>
        </div>

        <!-- Last seen -->
        <span v-if="show('lastSeen')" class="text-xs text-muted-foreground tabular">{{
          lastSeenLabel(node)
        }}</span>

        <!-- Agent update mode. The target version rides in the tooltip rather
             than on a second line, which the fixed row height has no room for. -->
        <div
          v-if="show('update')"
          class="min-w-0"
          :title="updatePolicy(node)?.target_version || undefined"
        >
          <Badge :variant="updateVariant(updatePolicy(node))" class="max-w-full truncate">
            {{ updateLabel(updatePolicy(node)) }}
          </Badge>
        </div>

        <!-- Actions (reuse the same intents NodeCard wires).
             Revealed on row hover or keyboard focus rather than drawn on every
             row: three ghost buttons times a 200-node fleet is 600 controls
             competing with the data for attention, and none of them is the
             thing an operator came to read. They stay in the DOM and in the tab
             order, so keyboard and screen-reader users lose nothing. -->
        <div
          class="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-within:opacity-100"
        >
          <Button
            v-if="canOpenTerminal"
            variant="ghost"
            size="icon-sm"
            :disabled="!isLive(node)"
            :title="$t('fleet.nodes.list.openTerminal')"
            :aria-label="$t('fleet.nodes.list.openTerminal')"
            @click.stop="emit('terminal', node)"
          >
            <SquareTerminal class="size-4" aria-hidden="true" />
          </Button>
          <Button
            v-if="canAdminNodes"
            variant="ghost"
            size="icon-sm"
            :disabled="pendingNodeId === node.id"
            :title="$t('fleet.nodes.list.rotateToken')"
            :aria-label="$t('fleet.nodes.list.rotateToken')"
            @click.stop="emit('rotate', node)"
          >
            <KeyRound class="size-4" aria-hidden="true" />
          </Button>
          <Button
            v-if="canAdminNodes"
            variant="ghost"
            size="icon-sm"
            :disabled="pendingNodeId === node.id"
            :title="node.disabled ? $t('common.actions.enable') : $t('common.actions.disable')"
            :aria-label="node.disabled ? $t('common.actions.enable') : $t('common.actions.disable')"
            @click.stop="emit('set-disabled', node, !node.disabled)"
          >
            <Power :class="['size-4', !node.disabled && 'text-destructive']" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
