<script setup lang="ts">
/**
 * NodeCard: the canonical fleet node card.
 *
 * Consolidates the two hand-rolled (and divergent) node cards previously inlined
 * in OverviewView and NodesView into one reusable, correctly-typed component:
 *  - StatusDot, the badge colour and the badge text all read the control
 *    plane's status word through `@/lib/nodeStatus`, so a disabled / degraded /
 *    offline / never-reported node renders the same word as every other page,
 *    and the pulse only animates when the agent is in contact.
 *  - Three {@link MetricBar}s (CPU / Memory / Disk).
 *  - An optional compact per-node trend sparkline (CPU or net), drawn as a tiny
 *    inline SVG fed by {@link useMetricBuffer}'s shared ring buffer. CSP-safe:
 *    no canvas, no echarts, no runtime style/script injection.
 *  - A footer with net rx/tx, uptime, and last-seen.
 *
 * Presentational only. It does NOT fetch and does NOT record samples (a parent
 * owns the poll loop and `record()`s into the shared buffer). User-facing text is
 * exposed as props with plain-English defaults so callers can pass translated
 * strings later; this component never imports the locale files.
 *
 * Emits `select` (header / name activated) and `action` (a footer action button)
 * so call sites keep ownership of navigation, dialogs, and mutations.
 */
import { computed, type HTMLAttributes } from "vue";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Clock,
  Cpu,
  Crown,
  HardDrive,
  MemoryStick,
} from "lucide-vue-next";
import type { Node } from "@/lib/api/types";
import { statusMeta } from "@/lib/status";
import { describeNodeStatus, nodeStatusReason, type NodeStatus } from "@/lib/nodeStatus";
import { splitNamePrefix } from "@/lib/fleet";
import { groupColor } from "@/lib/groupColors";
import {
  formatBytes,
  formatBytesPerSec,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  ratio,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMetricBuffer, type MetricKey } from "@/composables/useMetricBuffer";

import StatusDot from "@/components/common/StatusDot.vue";
import MetricBar from "@/components/common/MetricBar.vue";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

/** A group chip shown near the role/tag badges; clicking emits `group-select`. */
export interface NodeCardGroup {
  /** Group id (echoed through the `group-select` event). */
  id: string;
  /** Display name. */
  name: string;
  /** groupColors design-token name (e.g. "sky"); falls back to slate. */
  color?: string | null;
  /** True when this node is the group's leader. Renders a crown marker. */
  leader?: boolean;
}

/** A single declarative footer action surfaced as a button; emitted via `action`. */
export interface NodeCardAction {
  /** Stable identifier echoed back through the `action` event. */
  id: string;
  /** Button text. */
  label: string;
  /** Optional lucide icon component. */
  icon?: unknown;
  /** reka-ui / shadcn button variant. Defaults to `outline`. */
  variant?: "default" | "outline" | "secondary" | "destructive" | "ghost" | "link";
  /** Disable the button without removing it. */
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    /** The node to render. */
    node: Node;
    /** Tighter spacing + smaller sparkline for dense grids. */
    compact?: boolean;
    /** Group chips (color dot + name) rendered next to the role/tag badges. */
    groups?: NodeCardGroup[];
    /** Render the footer action row (emits `action`). */
    showActions?: boolean;
    /** Declarative footer actions; only shown when `showActions` is true. */
    actions?: NodeCardAction[];
    /** Render the compact trend sparkline above the metric bars. */
    showSparkline?: boolean;
    /** Which channel the sparkline plots. */
    sparklineMetric?: MetricKey;
    /** Make the name a button that emits `select` (keeps cards keyboard-reachable). */
    selectable?: boolean;
    /** Render the multi-select checkbox in the header. Distinct from `selectable`,
     *  which only means "this card is clickable". */
    checkable?: boolean;
    /** Whether this card is part of the current multi-selection. */
    checked?: boolean;
    /** Accessible label for the multi-select checkbox. */
    checkLabel?: string;
    /** Labels (English defaults; pass translated strings from a caller). */
    cpuLabel?: string;
    memoryLabel?: string;
    diskLabel?: string;
    /** Footer status words / aria text. */
    onlineLabel?: string;
    offlineLabel?: string;
    neverLabel?: string;
    degradedLabel?: string;
    disabledLabel?: string;
    /** Accessible label for the sparkline. */
    sparklineLabel?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    compact: false,
    groups: () => [],
    showActions: false,
    actions: () => [],
    showSparkline: false,
    sparklineMetric: "cpu",
    selectable: true,
    checkable: false,
    checked: false,
    checkLabel: "Select node",
    cpuLabel: "CPU",
    memoryLabel: "Memory",
    diskLabel: "Disk",
    onlineLabel: "Online",
    offlineLabel: "Offline",
    neverLabel: "Never reported",
    degradedLabel: "Degraded",
    disabledLabel: "Disabled",
    sparklineLabel: "Recent trend",
    class: undefined,
  },
);

const emit = defineEmits<{
  /** Header / name activated. Caller decides what "select" means (open detail, route…). */
  (e: "select", node: Node): void;
  /** A footer action button was clicked. */
  (e: "action", payload: { id: string; node: Node }): void;
  /** A group chip was clicked. Caller routes to the group (keeps nav ownership). */
  (e: "group-select", id: string): void;
  /** The multi-select checkbox was toggled. */
  (e: "toggle-check", node: Node): void;
}>();

/** One reading for the dot, the badge colour and the badge text: the status word. */
const info = computed(() => describeNodeStatus(props.node));
const meta = computed(() => statusMeta(info.value.health));

/** The agent is in contact: online or degraded. Disabled outranks a live agent. */
const isLive = computed(() => info.value.reporting);

const displayName = computed(() => splitNamePrefix(props.node));

const dotStatus = computed(() => info.value.health);

/** The badge prints the label the caller passed for the node's status word. */
const statusBadge = computed(() => {
  const labels: Record<NodeStatus, string> = {
    online: props.onlineLabel,
    degraded: props.degradedLabel,
    offline: props.offlineLabel,
    never_reported: props.neverLabel,
    disabled: props.disabledLabel,
  };
  return { variant: meta.value.badgeVariant, label: labels[info.value.status] };
});

/** The server's one-sentence account, on hover, so the word can be checked. */
const statusTitle = computed(() => nodeStatusReason(props.node));

/** First two tags only. Keeps the header from wrapping on dense grids. */
const visibleTags = computed(() =>
  [...(props.node.tags ?? [])].sort((a, b) => a.localeCompare(b)).slice(0, 2),
);

/* ---------------------------------------------------------------- */
/* Sparkline. Tiny inline SVG from the shared client-side ring.     */
/* ---------------------------------------------------------------- */

const buffer = useMetricBuffer();

/** net channels are bytes/sec; cpu/memory/disk are 0 to 100 percent. */
const isNetMetric = computed(
  () => props.sparklineMetric === "netRx" || props.sparklineMetric === "netTx",
);

const series = computed(() =>
  buffer
    .series(props.node.id, props.sparklineMetric)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
);

const hasSpark = computed(() => props.showSparkline && series.value.length >= 2);

/** Fixed coordinate space; SVG scales to container width, stroke stays crisp. */
const SPARK_W = 120;
const SPARK_H = computed(() => (props.compact ? 24 : 32));

/** Polyline points mapped into [pad, H-pad]; percent series clamp to a 0 to 100 axis. */
const sparkPoints = computed(() => {
  const vs = series.value;
  if (vs.length < 2) return "";
  const h = SPARK_H.value;
  const pad = 2;
  const usable = h - pad * 2;

  let min = vs[0]!;
  let max = vs[0]!;
  for (const v of vs) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // Percent channels: pin the axis to 0..max(100, peak) so a calm CPU line sits
  // low rather than amplifying noise to full height.
  if (!isNetMetric.value) {
    min = 0;
    max = Math.max(100, max);
  }
  const span = max - min;

  return vs
    .map((v, i) => {
      const x = vs.length <= 1 ? SPARK_W / 2 : (i / (vs.length - 1)) * SPARK_W;
      const y = span <= 0 ? h / 2 : pad + (1 - (v - min) / span) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
});

/** Colour-track the metric: percent uses node health, net uses a neutral accent. */
const sparkClass = computed(() => (isNetMetric.value ? "text-primary" : meta.value.textClass));

/**
 * Enter or Space opens the node, but only when the card itself has focus, so
 * keyboard use of the selection checkbox does not also navigate away.
 */
function onCardKey(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return;
  onSelect();
}

function onSelect() {
  emit("select", props.node);
}

function onAction(id: string) {
  emit("action", { id, node: props.node });
}

function onGroup(id: string) {
  emit("group-select", id);
}
</script>

<template>
  <div
    :class="
      cn(
        // A container, so the header can stack on the card's own width rather
        // than the viewport's: these cards are narrow in the Overview grid at
        // 1440 too, not only on a phone.
        '@container rounded-lg border border-border bg-background/40 transition-colors',
        compact ? 'p-3' : 'p-4',
        isLive ? 'hover:bg-muted/40' : 'opacity-60',
        selectable &&
          'cursor-pointer hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.class,
      )
    "
    :role="selectable ? 'button' : undefined"
    :tabindex="selectable ? 0 : undefined"
    :aria-label="selectable ? node.name || node.id : undefined"
    :aria-selected="checkable ? checked : undefined"
    @click="selectable && onSelect()"
    @keydown.enter.prevent="selectable && onCardKey($event)"
    @keydown.space.prevent="selectable && onCardKey($event)"
  >
    <!-- Header. Below ~384px of card width the badges drop under the name
         instead of squeezing it to an ellipsis and overflowing the card. -->
    <div class="flex flex-col gap-2 @sm:flex-row @sm:items-start @sm:justify-between">
      <div class="flex min-w-0 items-start gap-2">
        <!-- Stops click and key so the checkbox works without opening the node. -->
        <span v-if="checkable" class="mt-0.5 flex items-center" @click.stop @keydown.stop>
          <Checkbox
            :model-value="checked"
            :aria-label="checkLabel"
            @update:model-value="emit('toggle-check', node)"
          />
        </span>
        <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2 font-medium" :title="node.name || node.id">
          <StatusDot :status="dotStatus" :pulse="isLive" />
          <!-- The bracketed fleet prefix as a small badge, so it stops eating
               the name's width; the full name stays in the title. -->
          <Badge v-if="displayName.prefix" variant="outline" class="shrink-0 px-1 py-0 text-[10px] leading-4">{{ displayName.prefix }}</Badge>
          <span class="truncate">{{ displayName.body }}</span>
        </div>
        <p
          v-if="node.host_facts"
          class="mt-1 truncate font-mono text-xs text-muted-foreground tabular"
        >
          {{ node.host_facts.hostname || node.id }}
          <template v-if="node.host_facts.os"> · {{ node.host_facts.os }}</template>
          <template v-if="node.host_facts.arch"> · {{ node.host_facts.arch }}</template>
        </p>
        </div>
      </div>
      <div class="flex min-w-0 flex-wrap gap-1 @sm:shrink-0 @sm:justify-end">
        <Badge :variant="statusBadge.variant" :title="statusTitle">{{ statusBadge.label }}</Badge>
        <Badge v-if="node.role" variant="secondary">{{ node.role }}</Badge>
        <Badge v-for="tag in visibleTags" :key="tag" variant="outline">{{ tag }}</Badge>
        <button
          v-for="g in groups"
          :key="g.id"
          type="button"
          :class="
            cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              groupColor(g.color).border,
              groupColor(g.color).soft,
              groupColor(g.color).text,
            )
          "
          @click.stop="onGroup(g.id)"
        >
          <span :class="cn('size-1.5 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
          <span class="truncate">{{ g.name }}</span>
          <Crown v-if="g.leader" class="size-3 shrink-0" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- Sparkline (optional) -->
    <svg
      v-if="hasSpark"
      :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`"
      :style="{ height: SPARK_H + 'px' }"
      :class="cn('mt-3 block w-full', compact && 'mt-2')"
      preserveAspectRatio="none"
      role="img"
      :aria-label="sparklineLabel"
    >
      <polyline
        :points="sparkPoints"
        fill="none"
        :class="['stroke-current', sparkClass]"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>

    <!-- Metrics -->
    <div :class="cn(compact ? 'mt-3 space-y-2' : 'mt-4 space-y-2.5')">
      <MetricBar
        :label="cpuLabel"
        :icon="Cpu"
        tone="cpu"
        :percent="node.metrics?.cpu_percent ?? 0"
        :value-text="formatPercent(node.metrics?.cpu_percent)"
      />
      <MetricBar
        :label="memoryLabel"
        :icon="MemoryStick"
        tone="memory"
        :percent="ratio(node.metrics?.memory_used, node.metrics?.memory_total)"
        :used="node.metrics?.memory_used"
        :total="node.metrics?.memory_total"
      />
      <MetricBar
        :label="diskLabel"
        :icon="HardDrive"
        tone="disk"
        :percent="ratio(node.metrics?.disk_used, node.metrics?.disk_total)"
        :used="node.metrics?.disk_used"
        :total="node.metrics?.disk_total"
      />
    </div>

    <!-- Footer stats -->
    <div
      class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular"
    >
      <span class="inline-flex items-center gap-1">
        <ArrowDown class="size-3" aria-hidden="true" />
        {{ formatBytesPerSec(node.metrics?.net_rx_speed) }}
        <span class="text-[10px] text-muted-foreground/80">({{ formatBytes(node.metrics?.net_rx_bytes) }})</span>
      </span>
      <span class="inline-flex items-center gap-1">
        <ArrowUp class="size-3" aria-hidden="true" />
        {{ formatBytesPerSec(node.metrics?.net_tx_speed) }}
        <span class="text-[10px] text-muted-foreground/80">({{ formatBytes(node.metrics?.net_tx_bytes) }})</span>
      </span>
      <span class="inline-flex items-center gap-1">
        <Activity class="size-3" aria-hidden="true" />
        {{ formatDuration(node.metrics?.uptime_seconds) }}
      </span>
      <!-- A node that never reported carries the zero time as last_seen;
           formatting it printed "739,861 days ago" under the card. -->
      <span class="inline-flex items-center gap-1">
        <Clock class="size-3" aria-hidden="true" />
        {{ info.status === "never_reported" ? neverLabel : formatRelativeTime(node.last_seen) }}
      </span>
    </div>

    <!-- Actions (optional) -->
    <div v-if="showActions && actions.length" class="mt-4 flex flex-wrap gap-2">
      <button
        v-for="a in actions"
        :key="a.id"
        type="button"
        :disabled="a.disabled"
        :class="
          cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
            a.variant === 'destructive'
              ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
              : 'border-border hover:bg-muted/40',
          )
        "
        @click.stop="onAction(a.id)"
      >
        <component :is="a.icon" v-if="a.icon" class="size-3.5" aria-hidden="true" />
        {{ a.label }}
      </button>
    </div>

    <!-- Caller-supplied extras (e.g. richer action rows) render after the footer. -->
    <slot name="footer" :node="node" />
  </div>
</template>
