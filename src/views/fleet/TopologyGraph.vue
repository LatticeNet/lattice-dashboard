<script setup lang="ts">
/**
 * The Topology view's drawing (topologyModel holds every rule; this file only
 * places and words what it says).
 *
 * Edges are one SVG under the boxes; every node, source, address and the
 * control plane is an HTML button over it, so text stays crisp and every box
 * takes focus. Hovering or focusing anything lights it and everything one
 * edge away and dims the rest; a card says the numbers and when they were
 * heard. Edges answer the pointer through a 14 px transparent stroke.
 *
 * Every edge is also a button for the keyboard (design 32 D2), labelled with
 * what its card says. The edges are one tab stop between the sources and the
 * rows (a roving tabindex): Tab lands on the edge the keyboard was last on,
 * and the arrow keys, Home and End walk them source by source, each source's
 * by where they end. Enter or a click opens the path sheet in place
 * (`openPath`); the sheet gives focus back to the edge on close. The edge
 * whose path is open is drawn with a ring.
 *
 * The page's query fades what it does not keep: matching edges and their
 * ends keep full strength, the rest take the muted tone and leave the
 * arrow keys' walk.
 *
 * The card lives outside the scrolling frame, in a host that does not
 * scroll, so a card near the bottom or the right edge is moved, never cut.
 */
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import { ChevronDown, ChevronRight } from "lucide-vue-next";

import { formatAge } from "@/lib/format";
import { cn } from "@/lib/utils";

import { formatLoss, formatMs } from "./latencyModel";
import { usePathsCopy } from "./pathsCopy";
import { LOSS_TEXT, displayState, lossTone } from "./pathsModel";
import {
  CONTROL_PLANE,
  edgeStyle,
  edgesOf,
  endMatched,
  keyboardOrder,
  layoutTopology,
  neighbourhood,
  placeCard,
  rovingMove,
  rovingStop,
  rowMarks,
  rowPath,
  rowSummary,
  worstLive,
  type EdgePathState,
  type LayoutEdge,
  type LayoutRow,
  type TopoAddress,
  type TopoEdge,
  type TopoNode,
  type TopoReadState,
  type TopologyModel,
} from "./topologyModel";
import { PATH_INK, PATH_MARK, addressLineValue, edgeValue, freshnessDot, freshnessText, lastSampleText, reasonWords, rowSummaryValue, stateLabel } from "./topologyCopy";

const props = withDefaults(
  defineProps<{
    model: TopologyModel;
    now: number;
    windowLabel: string;
    /** Where the node list read stands; the control plane box says it. */
    nodesState?: TopoReadState;
    /** Why the node list read failed, when it never landed. */
    nodesReason?: string | null;
    /** The path the sheet has open (`?path=`): its edge carries a ring. */
    openPath?: string | null;
  }>(),
  { nodesState: "read", nodesReason: null, openPath: null },
);

const emit = defineEmits<{
  openNode: [id: string, el: HTMLElement | null];
  openPath: [key: string, el: HTMLElement | null];
  retryNodes: [];
}>();

const { t, locale } = useI18n();
const { reasonText, methodName } = usePathsCopy();

const PAD = 16;
/** The card's frame of reference: wraps the scrolling frame and does not scroll itself. */
const host = ref<HTMLElement | null>(null);
const frame = ref<HTMLElement | null>(null);
const frameWidth = ref(1100);
const hostSize = ref({ w: 1100, h: 600 });
useResizeObserver(frame, (entries) => {
  const width = entries[0]?.contentRect.width;
  if (width) frameWidth.value = Math.floor(width);
});
useResizeObserver(host, () => {
  const el = host.value;
  if (el) hostSize.value = { w: el.clientWidth, h: el.clientHeight };
});

const expanded = shallowRef<Set<string>>(new Set());
function toggleCountry(code: string): void {
  const next = new Set(expanded.value);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  expanded.value = next;
}

const layout = computed(() => layoutTopology(props.model, { width: frameWidth.value - PAD * 2, expanded: expanded.value }));
/** Every line's keyboard button, in the arrow keys' order: a faded line keeps its button so a sheet it opened can hand focus back. */
const keyed = computed(() => keyboardOrder(layout.value));

/* ---- Hover and focus ---- */

/**
 * What the pointer or focus is on, in the host's coordinates: the pointer for
 * an edge, the box's top right corner and size for a box.
 */
type Target =
  | { type: "edge"; key: string; x: number; y: number }
  | { type: "node" | "source" | "address" | "cp" | "country"; key: string; x: number; y: number; w: number; h: number; anchored: true };

const hover = ref<Target | null>(null);
/** The edge the keyboard is on: drawn with a ring until it leaves. */
const focusedEdge = ref<string | null>(null);
/** The edge the keyboard was last on: Tab comes back to it (the roving stop). */
const lastEdge = ref<string | null>(null);
// A layer or window switch rebuilds everything under the pointer. Two sources, not one getter
// returning a new array, so a refresh of the same layer and window (the poll, a query, the
// picker) keeps the ring, the card and the tab stop where the keyboard left them.
watch([() => props.model.layer, () => props.model.window], () => {
  hover.value = null;
  focusedEdge.value = null;
  lastEdge.value = null;
});

const edgeByKey = computed(() => new Map(layout.value.edges.map((e) => [e.key, e])));
const rowByKey = computed(() => new Map(layout.value.rows.map((r) => [r.key, r])));
const addressById = computed(() => new Map(props.model.addresses.map((a) => [a.id, a])));

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
  if (h.type === "country") return le.bundle.some((e) => set.has(e.from) && set.has(e.to));
  return le.bundle.some((e) => e.from === h.key || e.to === h.key);
}

/** The query keeps the line: one of its edges matches (always, without a query). */
const edgeMatched = (le: LayoutEdge) => le.bundle.some((e) => e.matched);
/** Faded by the query, or by a hover elsewhere. */
const dimmed = (id: string) => (!!lit.value && !lit.value.has(id)) || !endMatched(props.model, id);
const rowDimmed = (row: LayoutRow) => {
  if (row.type === "node") return dimmed(row.node.id);
  if (row.type === "country") return (!!lit.value && !row.members.some((m) => lit.value!.has(m.id))) || !row.members.some((m) => endMatched(props.model, m.id));
  return false;
};

function local(event: PointerEvent): { x: number; y: number } {
  const box = host.value?.getBoundingClientRect();
  return box ? { x: event.clientX - box.left, y: event.clientY - box.top } : { x: 0, y: 0 };
}

function onEdgeMove(le: LayoutEdge, event: PointerEvent): void {
  const { x, y } = local(event);
  hover.value = { type: "edge", key: le.key, x, y };
}

function onEdgeLeave(le: LayoutEdge): void {
  if (hover.value?.type === "edge" && hover.value.key === le.key) hover.value = null;
}

/** The keyboard on an edge: its card at the line's end, as the pointer would show it. */
function onEdgeFocus(le: LayoutEdge): void {
  focusedEdge.value = le.key;
  lastEdge.value = le.key;
  hover.value = { type: "edge", key: le.key, x: le.end.x + PAD - (frame.value?.scrollLeft ?? 0), y: le.end.y + PAD };
}

function onEdgeBlur(le: LayoutEdge): void {
  if (focusedEdge.value === le.key) focusedEdge.value = null;
  onEdgeLeave(le);
}

function onBoxEnter(type: "node" | "source" | "address" | "cp" | "country", key: string, event: Event): void {
  const el = event.currentTarget as HTMLElement;
  const box = el.getBoundingClientRect();
  const origin = host.value?.getBoundingClientRect();
  const x = origin ? box.right - origin.left : 0;
  const y = origin ? box.top - origin.top : 0;
  hover.value = { type, key, x, y, w: box.width, h: box.height, anchored: true };
}

function onBoxLeave(key: string): void {
  if (hover.value && hover.value.type !== "edge" && hover.value.key === key) hover.value = null;
}

/**
 * The folded country a bundle touches, and from which side: paths go into
 * one; chains between countries come out of one.
 */
function bundleCountry(le: LayoutEdge): { row: Extract<LayoutRow, { type: "country" }>; side: "into" | "out" } | undefined {
  for (const [id, side] of [[le.edge.to, "into"], [le.edge.from, "out"]] as const) {
    const row = rowByKey.value.get(layout.value.anchorOf.get(id) ?? "");
    if (row?.type === "country") return { row, side };
  }
  return undefined;
}

/** The state a bundle's members count as healthy, by kind. */
const HEALTHY = { path: "up", chain: "converged" } as const;

/** A line's keyboard button: what a sheet hands focus back to, however the line was opened. */
function edgeButton(le: LayoutEdge): HTMLElement | null {
  return host.value?.querySelector<HTMLElement>(`[data-edge-key="${CSS.escape(le.edge.id)}"]`) ?? null;
}

async function onEdgeClick(le: LayoutEdge, fromKeyboard = false): Promise<void> {
  const edge = le.edge;
  if (le.bundle.length > 1) {
    const hit = bundleCountry(le);
    if (!hit) return;
    toggleCountry(hit.row.country);
    // The bundle's line goes away as its country opens: the keyboard lands on the country's row, not on the page,
    // and the lines' tab stop moves to the source's first line into that country, not back to the top.
    if (fromKeyboard) {
      await nextTick();
      const into = keyed.value.find((x) => x.fromKey === le.fromKey && props.model.nodes.get(x.edge.to)?.country === hit.row.country);
      if (into) lastEdge.value = into.key;
      host.value?.querySelector<HTMLElement>(`[data-country="${CSS.escape(hit.row.country)}"]`)?.focus();
    }
    return;
  }
  if (edge.kind === "path" && edge.pathKey) emit("openPath", edge.pathKey, edgeButton(le));
  else if (edge.kind === "chain") emit("openNode", edge.from, edgeButton(le));
}

/** An address box opens the worst path into it: its card lists the others. */
function openAddress(address: TopoAddress, el: HTMLElement): void {
  const into = props.model.edges.filter((e) => e.to === address.id && e.pathKey);
  if (into.length) emit("openPath", worstLive(into).pathKey!, el);
}

/* ---- Drawing helpers ---- */

function dash(le: LayoutEdge): string | undefined {
  const style = edgeStyle(le.edge);
  // A double rail has butt caps, so its dashes need their own rhythm to stay apart.
  if (style.stroke === "dashed") return style.double ? "8 5" : "5 4";
  if (style.stroke === "dotted") return "1.5 3.5";
  return undefined;
}

function edgeWidth(le: LayoutEdge): number {
  const base = edgeStyle(le.edge).width;
  return le.bundle.length > 1 ? base + 1 : base;
}

/** A line the query does not keep takes the muted tone; the state's tone otherwise. */
function edgeColor(le: LayoutEdge): string {
  return edgeMatched(le) ? edgeStyle(le.edge).color : "--muted-foreground";
}

/** Chains and addresses end in an arrow; a path's direction to a node is the layout's (source left). */
function arrow(le: LayoutEdge): string | undefined {
  if (le.edge.kind === "path" && le.toColumn !== "address") return undefined;
  const { x, y, dir } = le.end;
  const back = x - dir * 7;
  return `M${x} ${y} L${back} ${y - 4} L${back} ${y + 4} Z`;
}

/** The ring around the line whose path is open, or that the keyboard is on. */
const ringed = (le: LayoutEdge) => focusedEdge.value === le.key || (!!props.openPath && le.bundle.length === 1 && le.edge.paths?.some((p) => p.key === props.openPath));

const nodeName = (id: string) => {
  if (id === CONTROL_PLANE) return t("fleet.monitoring.topology.cp.title");
  return props.model.nodes.get(id)?.name ?? addressById.value.get(id)?.address ?? id;
};

interface RowValue {
  text: string;
  tone: string;
  loss?: string;
  /** One state mark per drawn source, in the picker's order; empty with a single source, whose value says it all. */
  marks: { source: string; name: string; state?: EdgePathState }[];
}

/** Each drawn node's value, worked out once per model rather than once per binding. */
const rowValues = computed(() => {
  const out = new Map<string, RowValue>();
  const several = props.model.drawnSourceIds.length > 1;
  for (const row of layout.value.rows) {
    if (row.type !== "node") continue;
    const node = row.node;
    const path = rowPath(props.model, node.id);
    if (!path) continue;
    const marks = several ? rowMarks(props.model, node.id).map((m) => ({ ...m, name: nodeName(m.source) })) : [];
    // Several sources: the row summarises across them; one source: its edge's own value (p50 or state).
    const summary = rowSummary(props.model, node.id);
    out.set(node.id, { ...(summary ? rowSummaryValue(t, summary) : edgeValue(t, path.edge)), marks });
  }
  return out;
});
/** A row's marks in words, for its label and the mark's tooltip. */
const markText = (m: { name: string; state?: EdgePathState }) =>
  m.state ? `${m.name}: ${t(`fleet.monitoring.paths.state.${m.state}`)}` : t("fleet.monitoring.topology.value.notMeasured", { source: m.name });
const rowValue = (node: TopoNode): RowValue | undefined => rowValues.value.get(node.id);

/**
 * A folded country: the median p50 of its up and degraded paths (the
 * bundle's line already shows the worst), and how many of its paths are down
 * or degraded, so one bad node in 78 reads as one, not as the whole country.
 */
const countrySummaries = computed(() => {
  const out = new Map<string, ReturnType<typeof summarizeCountry>>();
  for (const row of layout.value.rows) if (row.type === "country") out.set(row.key, summarizeCountry(row));
  return out;
});
const countrySummary = (row: Extract<LayoutRow, { type: "country" }>) => countrySummaries.value.get(row.key);

function summarizeCountry(row: Extract<LayoutRow, { type: "country" }>) {
  const ids = new Set(row.members.map((m) => m.id));
  const into = props.model.edges.filter((e) => e.kind === "path" && ids.has(e.to));
  if (into.length === 0) return undefined;
  const measured = into.filter((e) => (e.state === "up" || e.state === "degraded") && e.p50Ms !== undefined).map((e) => e.p50Ms!).sort((a, b) => a - b);
  const problems = into.filter((e) => e.state === "down" || e.state === "degraded").length;
  const median = measured.length ? measured[Math.floor(measured.length / 2)]! : undefined;
  return {
    text: median !== undefined ? formatMs(median) : edgeValue(t, worstLive(into)).text,
    tone: median !== undefined ? "text-foreground" : "text-muted-foreground",
    problems,
  };
}

function sourcePaths(node: TopoNode): number {
  return props.model.edges.filter((e) => e.kind === "path" && e.from === node.id).reduce((n, e) => n + (e.paths?.length ?? 1), 0);
}

function addressLine(address: TopoAddress): { text: string; tone: string } {
  return addressLineValue(t, address);
}

function addressFrom(address: TopoAddress): string {
  return address.checks.length === 1 ? address.checks[0]! : t("fleet.monitoring.topology.address.checks", { n: address.checks.length }, address.checks.length);
}

const cpLine = computed(() => {
  const cp = props.model.cp;
  if (!cp.known) {
    // Not read is three different facts: no scope, not yet, or failed (with why).
    if (props.nodesState === "failed") return [{ key: "failed", text: t("fleet.monitoring.topology.cp.failed"), tone: "text-destructive" }];
    if (props.nodesState === "loading") return [{ key: "loading", text: t("fleet.monitoring.topology.cp.loading"), tone: "text-muted-foreground" }];
    return [{ key: "unread", text: t("fleet.monitoring.topology.cp.unread"), tone: "text-muted-foreground" }];
  }
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
  if (value) parts.push(value.text + (value.loss ? `, ${t("fleet.monitoring.paths.cell.loss", { loss: value.loss })}` : ""));
  if (value?.marks.length) parts.push(value.marks.map(markText).join("; "));
  if (node.relay) parts.push(t("fleet.monitoring.topology.role.relay"));
  if (node.exit) parts.push(t("fleet.monitoring.topology.role.exit"));
  if (node.incidents) parts.push(t("fleet.monitoring.topology.incidents", { n: node.incidents }, node.incidents));
  parts.push(t("fleet.monitoring.network.graph.nodeHint"));
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

function pathRows(edge: TopoEdge): CardRow[] {
  const rows: CardRow[] = [];
  rows.push({ label: t("fleet.monitoring.topology.card.p50"), value: formatMs(edge.p50Ms) || t("common.misc.none"), tone: PATH_INK[edge.state as EdgePathState] });
  rows.push({ label: t("fleet.monitoring.topology.card.p95"), value: formatMs(edge.p95Ms) || t("common.misc.none") });
  rows.push({
    label: t("fleet.monitoring.topology.card.loss"),
    value: edge.loss !== undefined ? formatLoss(edge.loss) : t("common.misc.none"),
    // A loss takes the path's state tone (down red, degraded amber); an up path's is a plain figure (D13).
    tone: (edge.loss ?? 0) > 0 ? LOSS_TEXT[lossTone(edge.state as EdgePathState)] || undefined : undefined,
  });
  if (edge.expected) rows.push({ label: t("fleet.monitoring.topology.card.heard"), value: t("fleet.monitoring.topology.card.heardValue", { heard: edge.samples ?? 0, expected: edge.expected, window: props.windowLabel }) });
  rows.push({ label: t("fleet.monitoring.topology.card.last"), value: lastSampleText(t, locale.value, edge.last, props.now), tone: edge.last?.ok === false ? "text-destructive" : undefined });
  return rows;
}

function edgeCard(le: LayoutEdge): Card {
  const edge = le.edge;
  if (le.bundle.length > 1) {
    const hit = bundleCountry(le);
    const country = hit ? hit.row.country : nodeName(edge.to);
    const healthy = le.bundle.filter((e) => e.state === HEALTHY[e.kind]).length;
    const other = le.bundle.length - healthy;
    return {
      title: t(hit?.side === "out" ? "fleet.monitoring.topology.card.bundleOut" : "fleet.monitoring.topology.card.bundle", { n: le.bundle.length, country }),
      subtitle: `${stateLabel(t, edge)} · ${nodeName(hit?.side === "out" ? edge.from : edge.to)}`,
      rows: edge.kind === "path" ? pathRows(edge) : [],
      lines: [{ text: t(`fleet.monitoring.topology.card.bundleCounts.${edge.kind}`, { healthy, other }) }],
      hint: t("fleet.monitoring.topology.card.hint.country"),
    };
  }
  const title = t("fleet.monitoring.topology.card.pair", { from: nodeName(edge.from), to: nodeName(edge.to) });
  if (edge.kind === "path") {
    const lines: Card["lines"] = [];
    // Why it is not up, in the server's own reason: unknown, paused or degraded.
    if (edge.state !== "up" && edge.reason) lines.push({ text: reasonText(edge.reason), tone: edge.state === "degraded" ? "text-warning-text" : undefined });
    const several = (edge.paths?.length ?? 0) > 1;
    if (edge.method && !several) lines.push({ text: t("fleet.monitoring.topology.card.method", { method: methodName(edge.method) }) });
    const card: Card = { title, subtitle: `${stateLabel(t, edge)} · ${props.windowLabel}`, rows: pathRows(edge), lines, hint: t("fleet.monitoring.topology.card.hint.path") };
    // Several checks on one pair: the card names each, the sheet lists them.
    if (several) {
      card.pathsTitle = t("fleet.monitoring.network.pair.title", { n: edge.paths!.length }, edge.paths!.length);
      card.paths = edge.paths!.map((p) => {
        const state = displayState(p);
        const value = state === "up" || state === "degraded" ? formatMs(p.p50Ms) || t(`fleet.monitoring.paths.state.${state}`) : state === "unknown" ? t("fleet.monitoring.paths.state.unknownWhy", { reason: reasonWords(t, p.reason) }) : t(`fleet.monitoring.paths.state.${state}`);
        return { key: p.id, text: `${methodName(p.method)} · ${p.checkName || p.checkId}`, value, tone: PATH_INK[state] };
      });
    }
    return card;
  }
  const lines: Card["lines"] = [];
  if (edge.chain?.targetLine) lines.push({ text: t("fleet.monitoring.topology.card.chainLines", { source: edge.chain.sourceLine.slice(0, 8), target: edge.chain.targetLine.slice(0, 8) }) });
  if (edge.chain?.error) lines.push({ text: t("fleet.monitoring.topology.card.chainError", { error: edge.chain.error }), tone: "text-destructive" });
  return { title, subtitle: stateLabel(t, edge), rows: [], lines, hint: t("fleet.monitoring.topology.card.hint.chain") };
}

/** An edge's keyboard label: what its card says, in one line. */
function edgeLabel(le: LayoutEdge): string {
  const card = edgeCard(le);
  const parts = [card.title, card.subtitle ?? "", ...card.rows.map((r) => `${r.label} ${r.value}`), ...card.lines.map((l) => l.text)];
  if (card.paths?.length) parts.push(`${card.pathsTitle}: ${card.paths.map((p) => `${p.text} ${p.value}`).join("; ")}`);
  if (card.hint) parts.push(card.hint);
  return parts.filter(Boolean).join(", ");
}

/** Every line's label, worked out once per drawing rather than on each render a hover causes. */
const edgeLabels = computed(() => new Map(layout.value.edges.map((le) => [le.key, edgeLabel(le)])));

function pathList(id: string): Pick<Card, "paths" | "more"> {
  const list = edgesOf(props.model, id).sort((a, b) => a.severity - b.severity);
  const shown = list.slice(0, 8).map((e) => {
    const other = e.from === id ? e.to : e.from;
    const v = edgeValue(t, e);
    return { key: e.id, text: `${e.from === id ? "→" : "←"} ${nodeName(other)}`, value: v.loss ? `${v.text} · ${v.loss}` : v.text, tone: v.tone };
  });
  return { paths: shown, more: Math.max(0, list.length - shown.length) };
}

/** The card is for the line the keyboard is on (not the pointer's). */
const keyboardCard = computed(() => hover.value?.type === "edge" && hover.value.key === focusedEdge.value);
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
    const lines = cpLine.value.map((l) => ({ text: l.text, tone: l.tone }));
    if (props.nodesReason && !props.model.cp.known) lines.push({ text: props.nodesReason, tone: "text-muted-foreground" });
    return {
      title: t("fleet.monitoring.topology.cp.title"),
      pathsTitle: quiet.length ? t("fleet.monitoring.topology.card.notBeating") : undefined,
      rows: [],
      lines,
      paths: quiet.slice(0, 8).map((n) => ({ key: n.id, text: n.name, value: freshnessText(t, locale.value, n, props.now), tone: n.freshness === "quiet" ? "text-destructive" : "text-muted-foreground" })),
      more: Math.max(0, quiet.length - 8),
    };
  }
  if (h.type === "address") {
    const address = addressById.value.get(h.key);
    if (!address) return null;
    const line = addressLine(address);
    return { title: address.address, subtitle: [address.methods.map(methodName).join(", "), addressFrom(address)].filter(Boolean).join(" · "), rows: [], lines: [{ text: line.text, tone: line.tone }], ...pathList(address.id), hint: t("fleet.monitoring.topology.card.hint.path") };
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
const MARGIN = 4;
const cardEl = ref<HTMLElement | null>(null);
/** The card's rendered height, measured after each change of what it says and before the browser paints. */
const cardH = ref(0);
watch(
  () => card.value,
  () => {
    cardH.value = cardEl.value?.offsetHeight ?? 0;
  },
  { flush: "post" },
);

/**
 * Where the card goes (topologyModel.placeCard): inside the host and inside
 * the window, read when the card moves or the page scrolls under a card the
 * keyboard put there, so a drawing taller than the screen never puts a card
 * below its bottom edge.
 */
const scrolled = ref(0);
useEventListener(window, "scroll", () => {
  if (hover.value) scrolled.value += 1;
}, { capture: true, passive: true });
const cardStyle = computed(() => {
  const h = hover.value;
  if (!h) return {};
  const { w: hostW, h: hostH } = hostSize.value;
  void scrolled.value;
  const rect = host.value?.getBoundingClientRect();
  const visibleTop = rect ? -rect.top : 0;
  const visibleBottom = rect ? window.innerHeight - rect.top : hostH;
  const { x, y } = placeCard(h, { hostW, hostH, visibleTop, visibleBottom, cardW: CARD_W, cardH: cardH.value, margin: MARGIN });
  return { left: `${x}px`, top: `${y}px`, width: `${CARD_W}px` };
});

/*
 * The lines are one tab stop (design 32 D2): Tab reaches the line the
 * keyboard was last on (else the open path's, else the first), and the arrow
 * keys, Home and End walk the lines the query keeps, source then target.
 * Faded lines are out of the walk.
 */
const walk = computed(() => keyed.value.filter(edgeMatched).map((le) => le.key));
const openEdge = computed(() => (props.openPath ? layout.value.edges.find((le) => le.bundle.length === 1 && le.edge.paths?.some((p) => p.key === props.openPath))?.key : undefined));
const tabStop = computed(() => rovingStop(walk.value, [lastEdge.value, openEdge.value]));

function onEdgeKey(le: LayoutEdge, event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    void onEdgeClick(le, true);
    return;
  }
  // A modified arrow is the browser's or the system's (Alt+Left goes back), never a move between edges.
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const next = rovingMove(walk.value, le.key, event.key, keyed.value.map((x) => x.key));
  if (!next) return;
  event.preventDefault();
  host.value?.querySelector<SVGGElement>(`[data-edge-nav="${CSS.escape(next)}"]`)?.focus();
}
</script>

<template>
  <div ref="host" class="relative">
  <div
    ref="frame"
    class="relative overflow-x-auto rounded-lg border border-border bg-card"
    data-testid="topology-graph"
    role="group"
    :aria-label="$t('fleet.monitoring.topology.graphLabel')"
    @scroll.passive="hover = null"
  >
    <div
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
            :data-matched="edgeMatched(le) ? undefined : 'false'"
            :class="cn('transition-opacity duration-150', !edgeLit(le) ? 'opacity-[0.12]' : !edgeMatched(le) && 'opacity-40')"
          >
            <path v-if="ringed(le)" :d="le.d" fill="none" stroke-linecap="round" :stroke-width="edgeWidth(le) + 5" style="stroke: var(--ring); opacity: 0.55" />
            <path
              :d="le.d"
              fill="none"
              :stroke-linecap="edgeStyle(le.edge).double ? 'butt' : 'round'"
              :stroke-width="edgeWidth(le)"
              :stroke-dasharray="dash(le)"
              :style="{ stroke: `var(${edgeColor(le)})` }"
            />
            <!-- A chain's second rail: the card's colour down the middle of the stroke. -->
            <path
              v-if="edgeStyle(le.edge).double"
              :d="le.d"
              fill="none"
              stroke-width="1.5"
              :stroke-dasharray="dash(le)"
              style="stroke: var(--card)"
            />
            <path v-if="arrow(le)" :d="arrow(le)" :style="{ fill: `var(${edgeColor(le)})` }" />
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
        <!-- Control plane: the heartbeat every node sends, counted. A group, since a failed node list read puts a Retry inside it. -->
        <div
          class="absolute flex flex-col justify-center rounded-lg border bg-muted/40 px-3 outline-none transition-opacity duration-150 focus-visible:ring-2 focus-visible:ring-ring"
          :class="[dimmed(CONTROL_PLANE) && 'opacity-50', nodesState === 'failed' && !model.cp.known ? 'border-destructive/50' : 'border-border']"
          :style="{ left: `${layout.cp.x}px`, top: `${layout.cp.y}px`, width: `${layout.cp.w}px`, height: `${layout.cp.h}px` }"
          role="group"
          tabindex="0"
          data-testid="topology-cp"
          :data-nodes="model.cp.known ? 'read' : nodesState"
          :aria-label="$t('fleet.monitoring.topology.cp.label', { state: [...cpLine.map((l) => l.text), ...(nodesReason && !model.cp.known ? [nodesReason] : [])].join(', ') })"
          @pointerenter="(e) => onBoxEnter('cp', CONTROL_PLANE, e)"
          @pointerleave="onBoxLeave(CONTROL_PLANE)"
          @focus="(e) => onBoxEnter('cp', CONTROL_PLANE, e)"
          @blur="onBoxLeave(CONTROL_PLANE)"
        >
          <span class="flex items-center gap-2">
            <span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{{ $t('fleet.monitoring.topology.cp.title') }}</span>
            <button
              v-if="nodesState === 'failed' && !model.cp.known"
              type="button"
              class="ms-auto inline-flex h-5 items-center rounded-sm border border-border bg-card px-1.5 text-[11px] text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="topology-cp-retry"
              @click="emit('retryNodes')"
            >
              {{ $t('common.actions.retry') }}
            </button>
          </span>
          <span class="truncate text-xs leading-snug" :class="cpLine[0]!.tone">{{ cpLine[0]!.text }}</span>
          <span v-if="nodesReason && !model.cp.known" class="truncate text-[11px] leading-snug text-muted-foreground" :title="nodesReason">{{ nodesReason }}</span>
          <span v-else-if="cpLine.length > 1" class="flex flex-wrap gap-x-2 text-[11px] leading-snug">
            <span v-for="part in cpLine.slice(1)" :key="part.key" :class="part.tone">{{ part.text }}</span>
          </span>
        </div>
        <!-- Sources: the lines from them follow as one tab stop. -->
        <template v-for="s in layout.sources" :key="s.node.id">
          <button
            type="button"
            class="absolute flex flex-col justify-center rounded-lg border bg-card px-3 text-start outline-none transition-[opacity,border-color] duration-150 hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
            :class="[dimmed(s.node.id) && 'opacity-50', s.node.freshness === 'quiet' || s.node.freshness === 'never' ? 'border-destructive/50' : 'border-border']"
            :style="{ left: `${s.box.x}px`, top: `${s.box.y}px`, width: `${s.box.w}px`, height: `${s.box.h}px` }"
            :data-node="s.node.id"
            :data-row-key="s.node.id"
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
              <!-- Its place in the row marks, when more than one source draws. -->
              <span v-if="model.drawnSourceIds.length > 1" class="ms-auto shrink-0 font-mono text-[10px] text-muted-foreground tabular" :title="$t('fleet.monitoring.topology.source.markOrder', { n: model.drawnSourceIds.indexOf(s.node.id) + 1 })">{{ model.drawnSourceIds.indexOf(s.node.id) + 1 }}</span>
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
        </template>

        <!-- Every line, one tab stop between the sources and the rows; the arrow keys walk the lines the query keeps. -->
        <svg
          v-if="keyed.length"
          role="group"
          :aria-label="$t('fleet.monitoring.network.graph.lines')"
          class="pointer-events-none absolute start-0 top-0 overflow-visible"
          :width="layout.width"
          :height="layout.height"
          data-testid="topology-edge-keys"
        >
          <g
            v-for="le in keyed"
            :key="le.key"
            role="button"
            :tabindex="le.key === tabStop ? 0 : -1"
            class="outline-none"
            :aria-label="edgeLabels.get(le.key)"
            :data-edge-key="le.edge.id"
            :data-edge-nav="le.key"
            :data-row-key="le.bundle.length === 1 ? le.edge.pathKey : undefined"
            @focus="onEdgeFocus(le)"
            @blur="onEdgeBlur(le)"
            @keydown="(e) => onEdgeKey(le, e)"
            @click="onEdgeClick(le, true)"
          >
            <path :d="le.d" fill="none" stroke="transparent" stroke-width="2" />
          </g>
        </svg>

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
            :class="rowDimmed(row) && 'opacity-50'"
            :style="{ left: `${layout.rowsX}px`, top: `${row.y}px`, width: `${layout.rowsW}px`, height: `${row.h}px` }"
            :aria-expanded="row.expanded"
            :data-country="row.country"
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
            :class="[rowDimmed(row) && 'opacity-50', row.indent ? 'ps-6' : 'ps-2']"
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
            <span class="min-w-16 flex-1 truncate" :title="row.node.name">{{ row.node.name }}</span>
            <span v-if="quietAge(row.node)" class="shrink-0 font-mono text-[11px] text-destructive tabular">{{ quietAge(row.node) }}</span>
            <span v-if="row.node.incidents" class="shrink-0 rounded-sm bg-destructive/12 px-1 font-mono text-[10px] font-semibold text-destructive tabular" aria-hidden="true">{{ row.node.incidents }}</span>
            <span v-if="row.node.relay" class="shrink-0 rounded-sm border border-primary/40 px-1 text-[10px] text-muted-foreground">{{ $t('fleet.monitoring.topology.role.relay') }}</span>
            <span v-if="row.node.exit" class="shrink-0 rounded-sm border border-primary/40 px-1 text-[10px] text-muted-foreground">{{ $t('fleet.monitoring.topology.role.exit') }}</span>
            <!-- At most half the row, so a long unknown reason never pushes the node's name out. -->
            <span v-if="rowValue(row.node)" class="flex min-w-0 max-w-[50%] shrink items-center gap-1.5 font-mono text-xs tabular">
              <span v-if="rowValue(row.node)!.loss" class="text-[11px] text-muted-foreground">{{ rowValue(row.node)!.loss }}</span>
              <span :class="cn('truncate', rowValue(row.node)!.tone)" :title="rowValue(row.node)!.text">{{ rowValue(row.node)!.text }}</span>
              <!-- One mark per drawn source, in the picker's order, so overlapping fans stay readable. -->
              <span v-if="rowValue(row.node)!.marks.length" class="flex shrink-0 items-center gap-0.5" aria-hidden="true" data-testid="topology-row-marks">
                <span
                  v-for="m in rowValue(row.node)!.marks"
                  :key="m.source"
                  :title="markText(m)"
                  :data-mark="m.state ?? 'none'"
                  :class="cn('size-2 rounded-[2px]', m.state ? PATH_MARK[m.state] : 'border border-dashed border-muted-foreground/50')"
                />
              </span>
            </span>
          </button>
        </template>

        <!-- One terminal per address the checks dial. -->
        <button
          v-for="a in layout.addresses"
          :key="a.address.id"
          type="button"
          class="absolute flex flex-col justify-center rounded-lg border bg-card px-3 text-start outline-none transition-[opacity,border-color] duration-150 hover:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          :class="[dimmed(a.address.id) && 'opacity-50', a.address.counts.down ? 'border-destructive/50' : a.address.counts.degraded ? 'border-warning/50' : 'border-border']"
          :style="{ left: `${a.box.x}px`, top: `${a.box.y}px`, width: `${a.box.w}px`, height: `${a.box.h}px` }"
          data-testid="topology-address"
          :data-address="a.address.address"
          :aria-label="`${a.address.address}, ${a.address.methods.map(methodName).join(', ')}, ${addressFrom(a.address)}, ${addressLine(a.address).text}`"
          @pointerenter="(e) => onBoxEnter('address', a.address.id, e)"
          @pointerleave="onBoxLeave(a.address.id)"
          @focus="(e) => onBoxEnter('address', a.address.id, e)"
          @blur="onBoxLeave(a.address.id)"
          @click="(e) => openAddress(a.address, e.currentTarget as HTMLElement)"
        >
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{{ a.address.methods.join(' ') }}</span>
            <span class="truncate font-mono text-xs font-medium" :title="a.address.address">{{ a.address.address }}</span>
          </span>
          <span class="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span class="min-w-0 truncate text-muted-foreground">{{ addressFrom(a.address) }}</span>
            <span :class="cn('ms-auto shrink-0 tabular', addressLine(a.address).tone)">{{ addressLine(a.address).text }}</span>
          </span>
        </button>

      </div>
    </div>
  </div>

      <!--
        What the pointer or focus is on, with when it was heard. Outside the
        scrolling frame, so it is never clipped; no live region, since the
        focused box or edge already carries its label.
      -->
      <div
        v-if="card"
        ref="cardEl"
        class="pointer-events-none absolute z-30 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-(--shadow-overlay)"
        :style="cardStyle"
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
        <p v-if="card.hint || keyboardCard" class="mt-2 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
          {{ card.hint }}
          <!-- A line the keyboard is on says how to reach the others, which sit behind the arrow keys, not Tab. -->
          <span v-if="keyboardCard" class="block">{{ $t('fleet.monitoring.network.graph.arrows') }}</span>
        </p>
      </div>
  </div>
</template>
