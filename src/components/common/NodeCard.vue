<script setup lang="ts">
/**
 * NodeCard — the canonical fleet node card.
 *
 * Consolidates the two hand-rolled (and divergent) node cards previously inlined
 * in OverviewView and NodesView into one reusable, correctly-typed component:
 *  - StatusDot is bound to REAL health via `nodeStatusMeta(node).dotStatus`
 *    (NOT a non-existent `:active` prop) so a disabled / degraded / offline node
 *    renders the right colour, and the pulse only animates when truly online.
 *  - Three {@link MetricBar}s (CPU / Memory / Disk).
 *  - An optional compact per-node trend sparkline (CPU or net), drawn as a tiny
 *    inline SVG fed by {@link useMetricBuffer}'s shared ring buffer. CSP-safe:
 *    no canvas, no echarts, no runtime style/script injection.
 *  - A footer with net rx/tx, uptime, and last-seen.
 *
 * Presentational only — it does NOT fetch and does NOT record samples (a parent
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
import { nodeStatusMeta } from "@/lib/status";
import { groupColor } from "@/lib/groupColors";
import {
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

/** A group chip shown near the role/tag badges; clicking emits `group-select`. */
export interface NodeCardGroup {
  /** Group id (echoed through the `group-select` event). */
  id: string;
  /** Display name. */
  name: string;
  /** groupColors design-token name (e.g. "sky"); falls back to slate. */
  color?: string | null;
  /** True when this node is the group's leader — renders a crown marker. */
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
    /** Labels (English defaults; pass translated strings from a caller). */
    cpuLabel?: string;
    memoryLabel?: string;
    diskLabel?: string;
    /** Footer status words / aria text. */
    onlineLabel?: string;
    offlineLabel?: string;
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
    cpuLabel: "CPU",
    memoryLabel: "Memory",
    diskLabel: "Disk",
    onlineLabel: "Online",
    offlineLabel: "Offline",
    disabledLabel: "Disabled",
    sparklineLabel: "Recent trend",
    class: undefined,
  },
);

const emit = defineEmits<{
  /** Header / name activated — caller decides what "select" means (open detail, route…). */
  (e: "select", node: Node): void;
  /** A footer action button was clicked. */
  (e: "action", payload: { id: string; node: Node }): void;
  /** A group chip was clicked — caller routes to the group (keeps nav ownership). */
  (e: "group-select", id: string): void;
}>();

/** Real, derived visual treatment (drives the dot colour + the status badge). */
const meta = computed(() => nodeStatusMeta(props.node));

/** A disabled node is operationally down even if the agent last reported online. */
const isLive = computed(() => props.node.online && !props.node.disabled);

const displayName = computed(() => props.node.name || props.node.id);

const statusBadge = computed(() => {
  if (props.node.disabled) {
    return { variant: "secondary" as const, label: props.disabledLabel };
  }
  return {
    variant: meta.value.badgeVariant,
    label: props.node.online ? props.onlineLabel : props.offlineLabel,
  };
});

/** First two tags only — keeps the header from wrapping on dense grids. */
const visibleTags = computed(() => (props.node.tags ?? []).slice(0, 2));

/* ---------------------------------------------------------------- */
/* Sparkline — tiny inline SVG from the shared client-side ring.     */
/* ---------------------------------------------------------------- */

const buffer = useMetricBuffer();

/** net channels are bytes/sec; cpu/memory/disk are 0–100 percent. */
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

/** Polyline points mapped into [pad, H-pad]; percent series clamp to a 0–100 axis. */
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
        'rounded-lg border border-border bg-background/40 transition-colors',
        compact ? 'p-3' : 'p-4',
        isLive ? 'hover:bg-muted/40' : 'opacity-60',
        selectable &&
          'cursor-pointer hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.class,
      )
    "
    :role="selectable ? 'button' : undefined"
    :tabindex="selectable ? 0 : undefined"
    :aria-label="selectable ? displayName : undefined"
    @click="selectable && onSelect()"
    @keydown.enter.prevent="selectable && onSelect()"
    @keydown.space.prevent="selectable && onSelect()"
  >
    <!-- Header -->
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2 font-medium">
          <StatusDot :status="meta.dotStatus" :pulse="isLive" />
          <span class="truncate">{{ displayName }}</span>
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
      <div class="flex shrink-0 flex-wrap justify-end gap-1">
        <Badge :variant="statusBadge.variant">{{ statusBadge.label }}</Badge>
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
      </span>
      <span class="inline-flex items-center gap-1">
        <ArrowUp class="size-3" aria-hidden="true" />
        {{ formatBytesPerSec(node.metrics?.net_tx_speed) }}
      </span>
      <span class="inline-flex items-center gap-1">
        <Activity class="size-3" aria-hidden="true" />
        {{ formatDuration(node.metrics?.uptime_seconds) }}
      </span>
      <span class="inline-flex items-center gap-1">
        <Clock class="size-3" aria-hidden="true" />
        {{ formatRelativeTime(node.last_seen) }}
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
