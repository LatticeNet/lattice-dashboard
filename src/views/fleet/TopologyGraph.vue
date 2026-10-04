<script setup lang="ts">
/**
 * The Topology layer's drawing (topologyModel holds every rule; this file
 * only places and words what it says).
 *
 * Edges are one SVG under the boxes; every node, source, check and the
 * control plane is an HTML button over it, so text stays crisp, every box
 * takes focus and the screen reader reads a list of buttons rather than a
 * picture. Hovering or focusing anything lights it and everything one edge
 * away and dims the rest; a card says the numbers and when they were heard.
 * Edges answer the pointer through a 14 px transparent stroke. The keyboard
 * reaches every path through the boxes (a focused box's card lists its
 * paths) and through the List presentation.
 */
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useResizeObserver } from "@vueuse/core";
import { ChevronDown, ChevronRight } from "lucide-vue-next";

import { formatAge } from "@/lib/format";
import { cn } from "@/lib/utils";

import { BAND_STYLE, formatLoss, formatMs, latencyBand } from "./latencyModel";
import {
  CONTROL_PLANE,
  edgeStyle,
  edgesOf,
  layoutTopology,
  neighbourhood,
  rowProbe,
  worstLive,
  type LayoutEdge,
  type LayoutRow,
  type TopoCheck,
  type TopoEdge,
  type TopoNode,
  type TopologyModel,
} from "./topologyModel";
import { edgeValue, freshnessDot, freshnessText, lastSampleText, partialText, quietText, stateLabel } from "./topologyCopy";

const props = defineProps<{
  model: TopologyModel;
  now: number;
  windowLabel: string;
}>();

const emit = defineEmits<{
  openNode: [id: string, el: HTMLElement | null];
  openPair: [source: string, target: string];
  openMonitor: [id: string, el: HTMLElement | null];
}>();

const { t, locale } = useI18n();

const PAD = 16;
const frame = ref<HTMLElement | null>(null);
const inner = ref<HTMLElement | null>(null);
const frameWidth = ref(1100);
useResizeObserver(frame, (entries) => {
  const width = entries[0]?.contentRect.width;
  if (width) frameWidth.value = Math.floor(width);
});

const expanded = shallowRef<Set<string>>(new Set());
function toggleCountry(code: string): void {
  const next = new Set(expanded.value);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  expanded.value = next;
}

const layout = computed(() => layoutTopology(props.model, { width: frameWidth.value - PAD * 2, expanded: expanded.value }));

/* ---- Hover and focus ---- */

type Target =
  | { type: "edge"; key: string; x: number; y: number }
  | { type: "node" | "source" | "check" | "cp" | "country"; key: string; x: number; y: number; anchored: true };

const hover = ref<Target | null>(null);
// A layer or window switch rebuilds everything under the pointer.
watch(() => [props.model.layer, props.model.window], () => (hover.value = null));

const edgeByKey = computed(() => new Map(layout.value.edges.map((e) => [e.key, e])));
const rowByKey = computed(() => new Map(layout.value.rows.map((r) => [r.key, r])));
const checkById = computed(() => new Map(props.model.checks.map((c) => [c.id, c])));

/** The endpoints a hover lights, or null when nothing is hovered. */
const lit = computed<Set<string> | null>(() => {
  const h = hover.value;
  if (!h) return null;
  if (h.type === "edge") {
    const le = edgeByKey.value.get(h.key);
    if (!le) return null;
    return new Set(le.bundle.flatMap((e) => [e.from, e.to]));
  }
  if (h.type === "cp") {
    const out = new Set<string>([CONTROL_PLANE]);
    for (const node of props.model.nodes.values()) if (node.freshness && node.freshness !== "fresh") out.add(node.id);
    for (const edge of props.model.edges) if (edge.from === CONTROL_PLANE) out.add(edge.to);
    return out;
  }
  if (h.type === "check") {
    const check = checkById.value.get(h.key);
    return new Set([h.key, ...(check?.sourceIds ?? [])]);
  }
  if (h.type === "country") {
    const row = rowByKey.value.get(h.key);
    if (row?.type !== "country") return null;
    const out = new Set<string>();
    for (const member of row.members) for (const id of neighbourhood(props.model, member.id)) out.add(id);
    return out;
  }
  return neighbourhood(props.model, h.key);
});

function edgeLit(le: LayoutEdge): boolean {
  const h = hover.value;
  if (!h) return true;
  if (h.type === "edge") return h.key === le.key;
  const set = lit.value;
  if (!set) return true;
  if (h.type === "cp") return le.bundle.some((e) => e.from === CONTROL_PLANE);
  if (h.type === "check") return le.bundle.some((e) => e.to === h.key);
  if (h.type === "country") return le.bundle.some((e) => set.has(e.from) && set.has(e.to));
  return le.bundle.some((e) => e.from === h.key || e.to === h.key);
}

const dimmed = (id: string) => !!lit.value && !lit.value.has(id);
const rowDimmed = (row: LayoutRow) => {
  if (!lit.value) return false;
  if (row.type === "node") return !lit.value.has(row.node.id);
  if (row.type === "country") return !row.members.some((m) => lit.value!.has(m.id));
  return false;
};

function local(event: PointerEvent): { x: number; y: number } {
  const box = inner.value?.getBoundingClientRect();
  return box ? { x: event.clientX - box.left, y: event.clientY - box.top } : { x: 0, y: 0 };
}

function onEdgeMove(le: LayoutEdge, event: PointerEvent): void {
  const { x, y } = local(event);
  hover.value = { type: "edge", key: le.key, x, y };
}

function onEdgeLeave(le: LayoutEdge): void {
  if (hover.value?.type === "edge" && hover.value.key === le.key) hover.value = null;
}

function onBoxEnter(type: "node" | "source" | "check" | "cp" | "country", key: string, event: Event): void {
  const el = event.currentTarget as HTMLElement;
  const box = el.getBoundingClientRect();
  const host = inner.value?.getBoundingClientRect();
  const x = host ? box.right - host.left : 0;
  const y = host ? box.top - host.top : 0;
  hover.value = { type, key, x, y, anchored: true };
}

function onBoxLeave(key: string): void {
  if (hover.value && hover.value.type !== "edge" && hover.value.key === key) hover.value = null;
}

function onEdgeClick(le: LayoutEdge): void {
  const edge = le.edge;
  if (le.bundle.length > 1) {
    // A folded bundle opens the country it goes into.
    const toRow = layout.value.anchorOf.get(edge.to);
    const row = toRow ? rowByKey.value.get(toRow) : undefined;
    if (row?.type === "country") toggleCountry(row.country);
    return;
  }
  if (edge.kind === "probe") emit("openPair", edge.from, edge.to);
  else if (edge.kind === "check" && edge.monitorId) emit("openMonitor", edge.monitorId, null);
  else if (edge.kind === "chain") emit("openNode", edge.from, null);
}

/* ---- Drawing helpers ---- */

function dash(le: LayoutEdge): string | undefined {
  const style = edgeStyle(le.edge);
  if (style.stroke === "dashed") return "5 4";
  if (style.stroke === "dotted") return "1.5 3.5";
  return undefined;
}

function edgeWidth(le: LayoutEdge): number {
  const base = edgeStyle(le.edge).width;
  return le.bundle.length > 1 ? base + 1 : base;
}

/** Chains and checks end in an arrow; a probe's direction is the layout's (source left). */
function arrow(le: LayoutEdge): string | undefined {
  if (le.edge.kind === "probe") return undefined;
  const { x, y, dir } = le.end;
  const back = x - dir * 7;
  return `M${x} ${y} L${back} ${y - 4} L${back} ${y + 4} Z`;
}

const nodeName = (id: string) => {
  if (id === CONTROL_PLANE) return t("fleet.monitoring.topology.cp.title");
  return props.model.nodes.get(id)?.name ?? checkById.value.get(id)?.name ?? id;
};

interface RowValue {
  text: string;
  tone: string;
  loss?: string;
  more: number;
}

/** Each drawn node's value, worked out once per model rather than once per binding. */
const rowValues = computed(() => {
  const out = new Map<string, RowValue>();
  const probes = props.model.layer === "all" || props.model.layer === "probes";
  for (const row of layout.value.rows) {
    if (row.type !== "node") continue;
    const node = row.node;
    const probe = rowProbe(props.model, node.id);
    if (probe) out.set(node.id, { ...edgeValue(t, probe.edge), more: probe.count > 1 ? probe.count - 1 : 0 });
    else if (node.probeTarget === "not_probeable" && probes) out.set(node.id, { text: t("fleet.monitoring.topology.value.notProbed"), tone: "text-muted-foreground", more: 0 });
  }
  return out;
});
const rowValue = (node: TopoNode): RowValue | undefined => rowValues.value.get(node.id);

/**
 * A folded country: the median p50 of its measured paths (the bundle's line
 * already shows the worst), and how many of its paths are failing, lossy or
 * quiet, so one bad node in 78 reads as one, not as the whole country.
 */
const countrySummaries = computed(() => {
  const out = new Map<string, ReturnType<typeof summarizeCountry>>();
  for (const row of layout.value.rows) if (row.type === "country") out.set(row.key, summarizeCountry(row));
  return out;
});
const countrySummary = (row: Extract<LayoutRow, { type: "country" }>) => countrySummaries.value.get(row.key);

function summarizeCountry(row: Extract<LayoutRow, { type: "country" }>) {
  const ids = new Set(row.members.map((m) => m.id));
  const into = props.model.edges.filter((e) => e.kind === "probe" && ids.has(e.to));
  if (into.length === 0) return undefined;
  const measured = into.filter((e) => (e.state === "measured" || e.state === "lossy") && e.p50Ms !== undefined).map((e) => e.p50Ms!).sort((a, b) => a - b);
  const problems = into.filter((e) => e.state === "failing" || e.state === "lossy" || e.state === "quiet").length;
  const median = measured.length ? measured[Math.floor(measured.length / 2)]! : undefined;
  const band = median !== undefined ? latencyBand(median) : undefined;
  return {
    text: median !== undefined ? formatMs(median) : edgeValue(t, worstLive(into)).text,
    tone: band ? BAND_STYLE[band].text : "text-muted-foreground",
    problems,
  };
}

function sourcePaths(node: TopoNode): number {
  return props.model.edges.filter((e) => e.kind === "probe" && e.from === node.id).length;
}

function checkLine(check: TopoCheck): { text: string; tone: string } {
  if (!check.enabled) return { text: t("fleet.monitoring.topology.check.disabled"), tone: "text-muted-foreground" };
  const total = check.sourceIds.length;
  if (check.summary.failing > 0) return { text: t("fleet.monitoring.topology.check.failing", { n: check.summary.failing, total }), tone: "text-destructive" };
  return { text: t("fleet.monitoring.topology.check.summary", { up: check.summary.up, total }), tone: check.summary.up === total ? "text-muted-foreground" : "text-warning-text" };
}

function checkFrom(check: TopoCheck): string {
  if (check.serverEvaluated) return t("fleet.monitoring.topology.check.control");
  if (check.assignAll) return t("fleet.monitoring.topology.check.every");
  return t("fleet.monitoring.topology.check.from", { n: check.sourceIds.length }, check.sourceIds.length);
}

const cpLine = computed(() => {
  const cp = props.model.cp;
  if (!cp.known) return [{ key: "unread", text: t("fleet.monitoring.topology.cp.unread"), tone: "text-muted-foreground" }];
  const out = [{ key: "beating", text: t("fleet.monitoring.topology.cp.beating", { fresh: cp.fresh, total: cp.total }), tone: "text-foreground" }];
  if (cp.quiet) out.push({ key: "quiet", text: t("fleet.monitoring.topology.cp.quiet", { n: cp.quiet }), tone: "text-destructive" });
  if (cp.degraded) out.push({ key: "degraded", text: t("fleet.monitoring.topology.cp.degraded", { n: cp.degraded }), tone: "text-warning-text" });
  if (cp.never) out.push({ key: "never", text: t("fleet.monitoring.topology.cp.never", { n: cp.never }), tone: "text-muted-foreground" });
  if (cp.disabled) out.push({ key: "disabled", text: t("fleet.monitoring.topology.cp.disabled", { n: cp.disabled }), tone: "text-muted-foreground" });
  return out;
});

const quietAge = (node: TopoNode) =>
  node.freshness === "quiet" && node.lastSeenAt ? formatAge(props.now - node.lastSeenAt, locale.value) : "";

function rowLabel(node: TopoNode): string {
  const parts = [node.name, node.country ?? "", freshnessText(t, locale.value, node, props.now)];
  const value = rowValue(node);
  if (value) parts.push(value.text + (value.loss ? `, ${t("fleet.monitoring.latency.cell.loss", { loss: value.loss })}` : ""));
  if (node.relay) parts.push(t("fleet.monitoring.topology.role.relay"));
  if (node.exit) parts.push(t("fleet.monitoring.topology.role.exit"));
  if (node.incidents) parts.push(t("fleet.monitoring.topology.incidents", { n: node.incidents }, node.incidents));
  return parts.filter(Boolean).join(", ");
}

/* ---- The card ---- */

interface CardRow {
  label: string;
  value: string;
  tone?: string;
}
interface Card {
  title: string;
  subtitle?: string;
  rows: CardRow[];
  lines: { text: string; tone?: string }[];
  paths?: { key: string; text: string; value: string; tone: string }[];
  /** The heading over `paths`; "Paths" unless said otherwise. */
  pathsTitle?: string;
  more?: number;
  hint?: string;
}

function probeRows(edge: TopoEdge): CardRow[] {
  const rows: CardRow[] = [];
  rows.push({ label: t("fleet.monitoring.topology.card.p50"), value: formatMs(edge.p50Ms) || t("common.misc.none"), tone: edgeValue(t, edge).tone });
  rows.push({ label: t("fleet.monitoring.topology.card.p95"), value: formatMs(edge.p95Ms) || t("common.misc.none") });
  rows.push({
    label: t("fleet.monitoring.topology.card.loss"),
    value: edge.loss !== undefined ? formatLoss(edge.loss) : t("common.misc.none"),
    tone: (edge.loss ?? 0) > 0 ? "text-destructive" : undefined,
  });
  if (edge.expected) rows.push({ label: t("fleet.monitoring.topology.card.heard"), value: t("fleet.monitoring.topology.card.heardValue", { heard: edge.samples ?? 0, expected: edge.expected, window: props.windowLabel }) });
  rows.push({ label: t("fleet.monitoring.topology.card.last"), value: lastSampleText(t, locale.value, edge.last, props.now), tone: edge.last && !edge.last.ok ? "text-destructive" : undefined });
  return rows;
}

function edgeCard(le: LayoutEdge): Card {
  const edge = le.edge;
  if (le.bundle.length > 1) {
    const row = rowByKey.value.get(layout.value.anchorOf.get(edge.to) ?? "");
    const country = row?.type === "country" ? row.country : nodeName(edge.to);
    const measured = le.bundle.filter((e) => e.state === "measured").length;
    return {
      title: t("fleet.monitoring.topology.card.bundle", { n: le.bundle.length, country }),
      subtitle: `${stateLabel(t, edge)} · ${nodeName(edge.to)}`,
      rows: edge.kind === "probe" ? probeRows(edge) : [],
      lines: [{ text: t("fleet.monitoring.topology.card.bundleCounts", { measured, other: le.bundle.length - measured }) }],
      hint: t("fleet.monitoring.topology.card.hint.country"),
    };
  }
  const title = t("fleet.monitoring.topology.card.pair", { from: nodeName(edge.from), to: nodeName(edge.to) });
  if (edge.kind === "probe") {
    const lines: Card["lines"] = [];
    if (edge.state === "paused" && edge.pausedReason) lines.push({ text: t("fleet.monitoring.topology.card.paused", { reason: t(`fleet.monitoring.latency.paused.${edge.pausedReason}`) }) });
    if (edge.state === "quiet") lines.push({ text: t("fleet.monitoring.topology.card.quiet", { reason: quietText(t, locale.value, edge, props.now) }), tone: "text-warning-text" });
    const partial = partialText(t, edge);
    if (partial) lines.push({ text: partial });
    return { title, subtitle: `${stateLabel(t, edge)} · ${props.windowLabel}`, rows: probeRows(edge), lines, hint: t("fleet.monitoring.topology.card.hint.probe") };
  }
  if (edge.kind === "chain") {
    const lines: Card["lines"] = [];
    if (edge.chain?.targetLine) lines.push({ text: t("fleet.monitoring.topology.card.chainLines", { source: edge.chain.sourceLine.slice(0, 8), target: edge.chain.targetLine.slice(0, 8) }) });
    if (edge.chain?.error) lines.push({ text: t("fleet.monitoring.topology.card.chainError", { error: edge.chain.error }), tone: "text-destructive" });
    return { title, subtitle: stateLabel(t, edge), rows: [], lines, hint: t("fleet.monitoring.topology.card.hint.chain") };
  }
  const rows: CardRow[] = [{ label: t("fleet.monitoring.topology.card.last"), value: lastSampleText(t, locale.value, edge.last, props.now), tone: edge.last && !edge.last.ok ? "text-destructive" : undefined }];
  const lines = edge.last?.error ? [{ text: edge.last.error, tone: "text-destructive" }] : [];
  return { title, subtitle: stateLabel(t, edge), rows, lines, hint: t("fleet.monitoring.topology.card.hint.check") };
}

function pathList(id: string): Pick<Card, "paths" | "more"> {
  const list = edgesOf(props.model, id).sort((a, b) => a.severity - b.severity);
  const shown = list.slice(0, 8).map((e) => {
    const other = e.from === id ? e.to : e.from;
    const v = edgeValue(t, e);
    return { key: e.id, text: `${e.from === id ? "→" : "←"} ${nodeName(other)}`, value: v.loss ? `${v.text} · ${v.loss}` : v.text, tone: v.tone };
  });
  return { paths: shown, more: Math.max(0, list.length - shown.length) };
}

const card = computed<Card | null>(() => {
  const h = hover.value;
  if (!h) return null;
  if (h.type === "edge") {
    const le = edgeByKey.value.get(h.key);
    return le ? edgeCard(le) : null;
  }
  if (h.type === "cp") {
    const order = { quiet: 0, never: 1, degraded: 2, disabled: 3, fresh: 9 } as const;
    const quiet = [...props.model.nodes.values()]
      .filter((n) => n.freshness && n.freshness !== "fresh")
      .sort((a, b) => order[a.freshness!] - order[b.freshness!] || a.name.localeCompare(b.name));
    return {
      title: t("fleet.monitoring.topology.cp.title"),
      pathsTitle: quiet.length ? t("fleet.monitoring.topology.card.notBeating") : undefined,
      rows: [],
      lines: cpLine.value.map((l) => ({ text: l.text, tone: l.tone })),
      paths: quiet.slice(0, 8).map((n) => ({ key: n.id, text: n.name, value: freshnessText(t, locale.value, n, props.now), tone: n.freshness === "quiet" ? "text-destructive" : "text-muted-foreground" })),
      more: Math.max(0, quiet.length - 8),
    };
  }
  if (h.type === "check") {
    const check = checkById.value.get(h.key);
    if (!check) return null;
    const line = checkLine(check);
    const lines = [{ text: line.text, tone: line.tone }];
    if (check.fannedOut && check.summary.up) lines.push({ text: t("fleet.monitoring.topology.check.fanned", { n: check.summary.up }), tone: "text-muted-foreground" });
    return { title: check.name, subtitle: `${check.type.toUpperCase()} · ${check.target}`, rows: [], lines, ...pathList(check.id), hint: t("fleet.monitoring.topology.card.hint.check") };
  }
  if (h.type === "country") {
    const row = rowByKey.value.get(h.key);
    if (row?.type !== "country") return null;
    return {
      title: `${row.country} · ${t("fleet.monitoring.topology.country.nodes", { n: row.members.length }, row.members.length)}`,
      subtitle: t(`fleet.monitoring.topology.region.${row.region}`),
      rows: [],
      lines: [],
      hint: row.expanded ? undefined : t("fleet.monitoring.topology.card.hint.country"),
    };
  }
  const node = props.model.nodes.get(h.key);
  if (!node) return null;
  const lines: Card["lines"] = [];
  const fresh = freshnessText(t, locale.value, node, props.now);
  if (fresh) lines.push({ text: fresh, tone: node.freshness === "quiet" ? "text-destructive" : node.freshness === "degraded" ? "text-warning-text" : undefined });
  if (node.probeTarget === "not_probeable" && node.endpointNote) lines.push({ text: t(`fleet.monitoring.latency.endpointNote.${node.endpointNote}`) });
  if (node.probeTarget === "paused" && node.targetReason) lines.push({ text: t(`fleet.monitoring.latency.reason.${node.targetReason}`) });
  if (node.incidents) lines.push({ text: t("fleet.monitoring.topology.incidents", { n: node.incidents }, node.incidents), tone: "text-destructive" });
  return {
    title: node.name,
    subtitle: [node.country, node.endpoint].filter(Boolean).join(" · ") || undefined,
    rows: [],
    lines,
    ...pathList(node.id),
    hint: t("fleet.monitoring.topology.card.hint.node"),
  };
});

const CARD_W = 288;
const cardStyle = computed(() => {
  const h = hover.value;
  if (!h) return {};
  const width = layout.value.width + PAD * 2;
  let x = h.x + 14;
  let y = h.y + 14;
  if ("anchored" in h) {
    x = h.x + 8;
    y = h.y;
    // Boxes near the right edge put their card on their left.
    if (x + CARD_W > width) x = Math.max(4, h.x - CARD_W - 8 - (h.type === "node" ? layout.value.rowsW : 0));
  } else if (x + CARD_W > width) {
    x = Math.max(4, h.x - CARD_W - 14);
  }
  return { left: `${x}px`, top: `${Math.max(4, y)}px`, width: `${CARD_W}px` };
});
</script>

<template>
  <div
    ref="frame"
    class="relative overflow-x-auto rounded-lg border border-border bg-card"
    data-testid="topology-graph"
    role="group"
    :aria-label="$t('fleet.monitoring.topology.graphLabel')"
  >
    <div
      ref="inner"
      class="relative"
      :style="{ width: `${layout.width + PAD * 2}px`, height: `${layout.height + PAD * 2}px` }"
      @pointerleave="hover = null"
    >
      <svg
        class="pointer-events-none absolute inset-0"
        :width="layout.width + PAD * 2"
        :height="layout.height + PAD * 2"
        aria-hidden="true"
      >
        <g :transform="`translate(${PAD} ${PAD})`">
          <g
            v-for="le in layout.edges"
            :key="le.key"
            :data-edge="le.edge.id"
            :data-state="le.edge.state"
            :class="cn('transition-opacity duration-150', !edgeLit(le) && 'opacity-[0.12]')"
          >
            <path
              :d="le.d"
              fill="none"
              stroke-linecap="round"
              :stroke-width="edgeWidth(le)"
              :stroke-dasharray="dash(le)"
              :style="{ stroke: `var(${edgeStyle(le.edge).color})` }"
            />
            <path v-if="arrow(le)" :d="arrow(le)" :style="{ fill: `var(${edgeStyle(le.edge).color})` }" />
            <path
              :d="le.d"
              fill="none"
              stroke="transparent"
              stroke-width="14"
              pointer-events="stroke"
              class="cursor-pointer"
              @pointermove="(e) => onEdgeMove(le, e)"
              @pointerleave="onEdgeLeave(le)"
              @click="onEdgeClick(le)"
            />
          </g>
        </g>
      </svg>

      <div class="absolute" :style="{ left: `${PAD}px`, top: `${PAD}px` }">
        <!-- Control plane: the heartbeat every node sends, counted. -->
        <div
          class="absolute flex flex-col justify-center rounded-lg border border-border bg-muted/40 px-3 outline-none transition-opacity duration-150 focus-visible:ring-2 focus-visible:ring-ring"
          :class="dimmed(CONTROL_PLANE) && 'opacity-35'"
          :style="{ left: `${layout.cp.x}px`, top: `${layout.cp.y}px`, width: `${layout.cp.w}px`, height: `${layout.cp.h}px` }"
          tabindex="0"
          data-testid="topology-cp"
          :aria-label="$t('fleet.monitoring.topology.cp.label', { state: cpLine.map((l) => l.text).join(', ') })"
          @pointerenter="(e) => onBoxEnter('cp', CONTROL_PLANE, e)"
          @pointerleave="onBoxLeave(CONTROL_PLANE)"
          @focus="(e) => onBoxEnter('cp', CONTROL_PLANE, e)"
          @blur="onBoxLeave(CONTROL_PLANE)"
        >
          <span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.monitoring.topology.cp.title') }}</span>
          <span class="truncate text-xs leading-snug" :class="cpLine[0]!.tone">{{ cpLine[0]!.text }}</span>
          <span v-if="cpLine.length > 1" class="flex flex-wrap gap-x-2 text-[11px] leading-snug">
            <span v-for="part in cpLine.slice(1)" :key="part.key" :class="part.tone">{{ part.text }}</span>
          </span>
        </div>

        <!-- Probe sources. -->
        <button
          v-for="s in layout.sources"
          :key="s.node.id"
          type="button"
          class="absolute flex flex-col justify-center rounded-lg border bg-card px-3 text-start outline-none transition-[opacity,border-color] duration-150 hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          :class="[dimmed(s.node.id) && 'opacity-35', s.node.freshness === 'quiet' || s.node.freshness === 'never' ? 'border-destructive/50' : 'border-border']"
          :style="{ left: `${s.box.x}px`, top: `${s.box.y}px`, width: `${s.box.w}px`, height: `${s.box.h}px` }"
          :data-node="s.node.id"
          data-testid="topology-source"
          :aria-label="rowLabel(s.node)"
          @pointerenter="(e) => onBoxEnter('source', s.node.id, e)"
          @pointerleave="onBoxLeave(s.node.id)"
          @focus="(e) => onBoxEnter('source', s.node.id, e)"
          @blur="onBoxLeave(s.node.id)"
          @click="(e) => emit('openNode', s.node.id, e.currentTarget as HTMLElement)"
        >
          <span class="flex min-w-0 items-center gap-2">
            <span :class="cn('size-2 shrink-0 rounded-full', freshnessDot(s.node))" aria-hidden="true" />
            <span class="truncate text-sm font-medium" :title="s.node.name">{{ s.node.name }}</span>
          </span>
          <span v-if="s.node.freshness === 'quiet'" class="truncate ps-4 text-[11px] text-destructive">
            {{ $t('fleet.monitoring.topology.source.quiet', { age: quietAge(s.node) }) }}
          </span>
          <span v-else-if="s.node.freshness === 'never'" class="truncate ps-4 text-[11px] text-muted-foreground">{{ $t('fleet.monitoring.topology.source.never') }}</span>
          <span v-else class="truncate ps-4 text-[11px] text-muted-foreground">
            {{ $t('fleet.monitoring.topology.source.role') }}<template v-if="s.node.country"> · <span class="font-mono">{{ s.node.country }}</span></template>
            · <span class="font-mono tabular">{{ $t('fleet.monitoring.topology.source.paths', { n: sourcePaths(s.node) }, sourcePaths(s.node)) }}</span>
          </span>
        </button>

        <!-- Every other node, by region. -->
        <template v-for="row in layout.rows" :key="row.key">
          <div
            v-if="row.type === 'header'"
            class="absolute flex items-end pb-1 ps-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            :style="{ left: `${layout.rowsX}px`, top: `${row.y}px`, width: `${layout.rowsW}px`, height: `${row.h}px` }"
          >
            {{ $t(`fleet.monitoring.topology.region.${row.region}`) }} · <span class="ms-1 font-mono tabular">{{ row.count }}</span>
          </div>
          <button
            v-else-if="row.type === 'country'"
            type="button"
            class="absolute flex items-center gap-2 rounded-md border border-transparent bg-card px-2 text-start text-sm outline-none transition-[opacity,background-color] duration-150 hover:border-border hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            :class="rowDimmed(row) && 'opacity-35'"
            :style="{ left: `${layout.rowsX}px`, top: `${row.y}px`, width: `${layout.rowsW}px`, height: `${row.h}px` }"
            :aria-expanded="row.expanded"
            :aria-label="row.expanded ? $t('fleet.monitoring.topology.country.collapse', { country: row.country }) : $t('fleet.monitoring.topology.country.expand', { country: row.country, n: row.members.length })"
            data-testid="topology-country"
            @pointerenter="(e) => onBoxEnter('country', row.key, e)"
            @pointerleave="onBoxLeave(row.key)"
            @focus="(e) => onBoxEnter('country', row.key, e)"
            @blur="onBoxLeave(row.key)"
            @click="toggleCountry(row.country)"
          >
            <component :is="row.expanded ? ChevronDown : ChevronRight" class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span class="w-5 shrink-0 font-mono text-[11px] text-muted-foreground">{{ row.country === '??' ? '' : row.country }}</span>
            <span class="min-w-0 flex-1 truncate">{{ $t('fleet.monitoring.topology.country.nodes', { n: row.members.length }, row.members.length) }}</span>
            <template v-if="countrySummary(row)">
              <span
                v-if="countrySummary(row)!.problems"
                class="shrink-0 rounded-sm bg-destructive/12 px-1 font-mono text-[10px] font-semibold text-destructive tabular"
                :title="$t('fleet.monitoring.topology.country.problems', { n: countrySummary(row)!.problems }, countrySummary(row)!.problems)"
              >{{ $t('fleet.monitoring.topology.country.problems', { n: countrySummary(row)!.problems }, countrySummary(row)!.problems) }}</span>
              <span :class="cn('shrink-0 font-mono text-xs tabular', countrySummary(row)!.tone)">{{ countrySummary(row)!.text }}</span>
            </template>
          </button>
          <button
            v-else
            type="button"
            class="absolute flex items-center gap-2 rounded-md border border-transparent bg-card pe-2 text-start text-sm outline-none transition-[opacity,background-color] duration-150 hover:border-border hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            :class="[rowDimmed(row) && 'opacity-35', row.indent ? 'ps-6' : 'ps-2']"
            :style="{ left: `${layout.rowsX}px`, top: `${row.y}px`, width: `${layout.rowsW}px`, height: `${row.h}px` }"
            :data-node="row.node.id"
            :data-row-key="row.node.id"
            data-testid="topology-row"
            :aria-label="rowLabel(row.node)"
            @pointerenter="(e) => onBoxEnter('node', row.node.id, e)"
            @pointerleave="onBoxLeave(row.node.id)"
            @focus="(e) => onBoxEnter('node', row.node.id, e)"
            @blur="onBoxLeave(row.node.id)"
            @click="(e) => emit('openNode', row.node.id, e.currentTarget as HTMLElement)"
          >
            <span :class="cn('size-2 shrink-0 rounded-full', freshnessDot(row.node))" aria-hidden="true" />
            <span class="w-5 shrink-0 font-mono text-[11px] text-muted-foreground">{{ row.node.country ?? '' }}</span>
            <span class="min-w-0 flex-1 truncate" :title="row.node.name">{{ row.node.name }}</span>
            <span v-if="quietAge(row.node)" class="shrink-0 font-mono text-[11px] text-destructive tabular">{{ quietAge(row.node) }}</span>
            <span v-if="row.node.incidents" class="shrink-0 rounded-sm bg-destructive/12 px-1 font-mono text-[10px] font-semibold text-destructive tabular" aria-hidden="true">{{ row.node.incidents }}</span>
            <span v-if="row.node.relay" class="shrink-0 rounded-sm border border-primary/40 px-1 text-[10px] text-muted-foreground">{{ $t('fleet.monitoring.topology.role.relay') }}</span>
            <span v-if="row.node.exit" class="shrink-0 rounded-sm border border-primary/40 px-1 text-[10px] text-muted-foreground">{{ $t('fleet.monitoring.topology.role.exit') }}</span>
            <span v-if="rowValue(row.node)" class="flex shrink-0 items-baseline gap-1 font-mono text-xs tabular">
              <span v-if="rowValue(row.node)!.loss" class="text-[11px] text-destructive">{{ rowValue(row.node)!.loss }}</span>
              <span :class="rowValue(row.node)!.tone">{{ rowValue(row.node)!.text }}</span>
              <span v-if="rowValue(row.node)!.more" class="text-[10px] text-muted-foreground">{{ $t('fleet.monitoring.topology.value.more', { n: rowValue(row.node)!.more }) }}</span>
            </span>
          </button>
        </template>

        <!-- Checks an operator made. -->
        <button
          v-for="c in layout.checks"
          :key="c.check.id"
          type="button"
          class="absolute flex flex-col justify-center rounded-lg border bg-card px-3 text-start outline-none transition-[opacity,border-color] duration-150 hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          :class="[dimmed(c.check.id) && 'opacity-35', c.check.summary.failing && c.check.enabled ? 'border-destructive/50' : 'border-border']"
          :style="{ left: `${c.box.x}px`, top: `${c.box.y}px`, width: `${c.box.w}px`, height: `${c.box.h}px` }"
          data-testid="topology-check"
          :aria-label="`${c.check.name}, ${c.check.type}, ${c.check.target}, ${checkLine(c.check).text}`"
          @pointerenter="(e) => onBoxEnter('check', c.check.id, e)"
          @pointerleave="onBoxLeave(c.check.id)"
          @focus="(e) => onBoxEnter('check', c.check.id, e)"
          @blur="onBoxLeave(c.check.id)"
          @click="(e) => emit('openMonitor', c.check.monitorId, e.currentTarget as HTMLElement)"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{{ c.check.type }}</span>
            <span class="truncate text-sm font-medium" :title="c.check.name">{{ c.check.name }}</span>
          </span>
          <span class="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span class="min-w-0 truncate text-muted-foreground">{{ checkFrom(c.check) }}</span>
            <span :class="cn('ms-auto shrink-0 tabular', checkLine(c.check).tone)">{{ checkLine(c.check).text }}</span>
          </span>
        </button>
      </div>

      <!-- What the pointer or focus is on, with when it was heard. -->
      <div
        v-if="card"
        class="pointer-events-none absolute z-30 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-(--shadow-overlay)"
        :style="cardStyle"
        role="status"
        data-testid="topology-card"
      >
        <p class="font-medium text-sm leading-snug break-words">{{ card.title }}</p>
        <p v-if="card.subtitle" class="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">{{ card.subtitle }}</p>
        <dl v-if="card.rows.length" class="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <template v-for="r in card.rows" :key="r.label">
            <dt class="text-muted-foreground">{{ r.label }}</dt>
            <dd :class="cn('font-mono tabular', r.tone)">{{ r.value }}</dd>
          </template>
        </dl>
        <p v-for="(l, i) in card.lines" :key="i" :class="cn('mt-1.5 break-words', l.tone ?? 'text-muted-foreground')">{{ l.text }}</p>
        <template v-if="card.paths">
          <p class="mt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{{ card.pathsTitle ?? $t('fleet.monitoring.topology.card.paths') }}</p>
          <p v-if="card.paths.length === 0" class="text-muted-foreground">{{ $t('fleet.monitoring.topology.card.noPaths') }}</p>
          <ul v-else class="mt-0.5 space-y-0.5">
            <li v-for="p in card.paths" :key="p.key" class="flex gap-2">
              <span class="min-w-0 flex-1 truncate">{{ p.text }}</span>
              <span :class="cn('shrink-0 font-mono tabular', p.tone)">{{ p.value }}</span>
            </li>
          </ul>
          <p v-if="card.more" class="mt-0.5 text-muted-foreground">{{ $t('fleet.monitoring.topology.card.more', { n: card.more }) }}</p>
        </template>
        <p v-if="card.hint" class="mt-2 border-t border-border pt-1.5 text-[11px] text-muted-foreground">{{ card.hint }}</p>
      </div>
    </div>
  </div>
</template>
