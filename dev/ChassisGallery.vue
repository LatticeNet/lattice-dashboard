<script setup lang="ts">
/**
 * Every chassis component in every state (design 23, sections 3.1 to 3.9),
 * on production-shaped data (./chassisFixture.ts). Wave 2 lanes build pages
 * from these; the design review reads them here first.
 *
 * Interactive where the component is: the layer row writes ?view=, the table
 * opens the sheet on ?open= (reload lands on it, Escape returns focus to the
 * row), the query bar writes its tokens to the address under their HTTP names.
 */
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { toast } from "@/lib/toast";
import { Ban, KeyRound, Plus, SquareTerminal, Trash2 } from "lucide-vue-next";

import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import MetricStrip, { type Metric } from "@/components/common/MetricStrip.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import QueryBar, { type QueryFilterGroup } from "@/components/common/QueryBar.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLayer } from "@/composables/useLayer";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { useThemeStore } from "@/stores/theme";
import { formatTokens, parseTokens, readTokenQuery, tokenFilterCount, writeTokenQuery, type TokenGrammar, type TokenResolvers } from "@/lib/queryTokens";

import { GALLERY_NODES, GONE_NODE_ID, type GalleryNode } from "./chassisFixture";

const route = useRoute();
const router = useRouter();
const theme = useThemeStore();
const now = Date.now();

provideNodeDirectory(computed(() => GALLERY_NODES));

/* ------------------------------------------------------------------ */
/* ProofLine                                                           */
/* ------------------------------------------------------------------ */

const fleetSegments: ProofSegment[] = [
  { key: "nodes", text: "34 nodes" },
  { key: "offline", text: "2 offline", tone: "warning", to: { name: "chassis", query: { view: "nodes" } } },
  { key: "versions", text: "4 agent versions" },
  { key: "via", text: "via agent reports", tone: "muted" },
];

const proofCases: { key: string; caption: string; state: "loading" | "observed" | "refreshing" | "stale" | "failed" | "idle"; observedAt?: number; error?: string; segments: ProofSegment[] }[] = [
  { key: "loading", caption: "loading: nothing read yet", state: "loading", segments: fleetSegments },
  { key: "observed", caption: "observed: polled every 10 s, read 12 s ago", state: "observed", observedAt: now - 12_000, segments: fleetSegments },
  { key: "refreshing", caption: "refreshing: the observed line and a quiet spinner", state: "refreshing", observedAt: now - 9_000, segments: fleetSegments },
  { key: "stale", caption: "stale: the last good read, muted, and why the refresh failed", state: "stale", observedAt: now - 190_000, error: "502 Bad Gateway from lattice.roobli.org", segments: fleetSegments },
  { key: "failed", caption: "failed: the reason and a retry, never a count", state: "failed", error: "tasks store busy: scan exceeded 10 s", segments: fleetSegments },
  { key: "idle", caption: "idle: the page does not poll, so no age", state: "idle", segments: [{ key: "users", text: "1 user" }, { key: "tokens", text: "0 access tokens" }] },
];

const terminalSegments: ProofSegment[] = [
  { key: "transport", text: "websocket", tone: "strong" },
  { key: "shell", text: "/bin/bash", tone: "strong" },
  { key: "agent", text: "agent 0.3.9" },
  { key: "blocked", text: "node offline", tone: "warning" },
  { key: "audited", text: "sessions are audited", to: { name: "audit" } },
];

/* ------------------------------------------------------------------ */
/* AttentionList                                                       */
/* ------------------------------------------------------------------ */

const attentionFew: AttentionItem[] = [
  { key: "dmit4", tone: "danger", claim: "[Metix]-DMIT-4 is offline", proof: "last report 6 days ago, 2026-09-24 03:10", action: { label: "Open", to: { name: "chassis", query: { open: GALLERY_NODES[33]!.id } } } },
  { key: "stalled", tone: "warning", claim: "1 task stalled", proof: "probe.sh on [cd]-homeserver, lease expired 6 days ago", action: { label: "Tasks", run: () => toast("Tasks would open filtered to stalled") } },
  { key: "unmanaged", tone: "info", claim: "No line is managed by vpn-core", proof: "136 lines observed on 24 nodes" },
];

const attentionMany: AttentionItem[] = [
  ...Array.from({ length: 7 }, (_, index) => ({
    key: `ddns-${index}`,
    tone: "warning" as const,
    claim: `DDNS profile home-v${index + 4} is failing`,
    proof: "401 from Cloudflare: the API token lacks Zone.DNS edit on roobli.org",
    action: { label: "Open", run: () => toast(`Open home-v${index + 4}`) },
  })),
  { key: "offline", tone: "danger" as const, claim: "2 nodes offline", proof: "[Metix]-DMIT-4 6d, [cd]-homeserver 41m" },
  { key: "note", tone: "info" as const, claim: "3 nodes are not located on the map" },
];

/* ------------------------------------------------------------------ */
/* MetricStrip                                                         */
/* ------------------------------------------------------------------ */

const metricsFour: Metric[] = [
  { key: "online", label: "Online", value: "32", hint: "of 34", to: { name: "chassis", query: { view: "nodes" } } },
  { key: "approvals", label: "Approvals waiting", value: 0 },
  { key: "failed", label: "Tasks failed in 24h", value: 5, tone: "destructive" },
  { key: "due", label: "Due in 7 days", value: "none", tone: "muted" },
];

const metricsStates: Metric[] = [
  { key: "reading", label: "Tasks", value: "reading…", tone: "muted" },
  { key: "failed", label: "Tasks", value: "not read", tone: "muted", hint: "502 from the server" },
  { key: "old", label: "Tasks", value: "server too old", tone: "muted", hint: "no /api/tasks/counts" },
  { key: "parts", label: "Tasks", value: "3 queued · 1 stalled", parts: [{ text: "3 queued" }, { text: "1 stalled", tone: "warning" }] },
];

const metricsOver: Metric[] = [
  ...metricsFour,
  { key: "total", label: "Total approvals", value: "1,351", tone: "muted" },
];

/* ------------------------------------------------------------------ */
/* LayerTabs                                                           */
/* ------------------------------------------------------------------ */

const LAYERS = ["overview", "nodes", "machines", "upcoming", "groups", "settings"] as const;
type Layer = (typeof LAYERS)[number];
const layer = useLayer<Layer>(() => LAYERS, () => "overview");
const layerTabs: LayerTab<Layer>[] = [
  { value: "overview", label: "Overview" },
  { value: "nodes", label: "Nodes", count: 34 },
  { value: "machines", label: "Machines", count: 34 },
  { value: "upcoming", label: "Upcoming", count: 3, tone: "warning" },
  { value: "groups", label: "Groups", count: 3 },
  { value: "settings", label: "Settings" },
];
// A three-layer row shaped like Approvals, to show the segmented form with
// every count tone. Not bound to the address: a page has one layer row.
type ApprovalLayer = "needs" | "history" | "stuck";
const approvalLayer = ref<ApprovalLayer>("needs");
const approvalTabs: LayerTab<ApprovalLayer>[] = [
  { value: "needs", label: "Needs you", count: 3, tone: "warning" },
  { value: "history", label: "History", count: "1,351" },
  { value: "stuck", label: "Stuck", count: 1, tone: "destructive" },
];

/* ------------------------------------------------------------------ */
/* DataTable, RowMenu, ObjectSheet                                     */
/* ------------------------------------------------------------------ */

const sheet = useRouteOpen();
const openNode = computed(() => GALLERY_NODES.find((node) => node.id === sheet.openId.value));
const sheetMode = ref<"auto" | "loading" | "stale" | "failed" | "readonly">("auto");
const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (sheetMode.value === "loading") return "loading" as const;
  if (sheetMode.value === "failed") return "failed" as const;
  if (!openNode.value) return "gone" as const;
  if (sheetMode.value === "stale") return "stale" as const;
  return "ready" as const;
});

function ageText(sec: number): string {
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 172_800) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

const nodeColumns: DataTableColumn<GalleryNode>[] = [
  { key: "name", label: "Node", sortable: true, searchable: true },
  { key: "status", label: "Status", sortable: true, searchable: true },
  { key: "ip", label: "Address", searchable: true, class: "font-mono text-xs" },
  { key: "agent", label: "Agent", sortable: true, class: "font-mono text-xs" },
  { key: "lastSeen", label: "Last seen", sortable: true, value: (row) => row.lastSeenSec },
  { key: "cpu", label: "CPU", align: "right", sortable: true },
  { key: "tags", label: "Tags", searchable: true, value: (row) => row.tags.join(" ") },
  { key: "actions", label: "", class: "w-12", pin: "end" },
];

const confirm = ref<null | "disable" | "delete">(null);
const confirmTarget = ref<GalleryNode | null>(null);

function menuFor(node: GalleryNode): RowMenuItem[] {
  return [
    {
      key: "terminal",
      label: "Open terminal",
      icon: SquareTerminal,
      disabled: node.status === "offline",
      reason: node.status === "offline" ? "The node is offline; a session needs its agent." : undefined,
      run: () => toast(`Terminal on ${node.name}`),
    },
    { key: "rotate", label: "Rotate agent token", icon: KeyRound, run: () => toast(`Rotate ${node.name}`) },
    {
      key: "disable",
      label: "Disable",
      icon: Ban,
      run: () => {
        confirmTarget.value = node;
        confirm.value = "disable";
      },
    },
    {
      key: "delete",
      label: "Delete node",
      icon: Trash2,
      danger: true,
      run: () => {
        confirmTarget.value = node;
        confirm.value = "delete";
      },
    },
  ];
}

const tableMode = ref<"rows" | "loading" | "error" | "empty">("rows");
const tableRows = computed(() => (tableMode.value === "rows" ? GALLERY_NODES : []));

interface EventRow {
  id: string;
  what: string;
  who: string;
  when: string;
}
const eventRows: EventRow[] = [
  { id: "e1", what: "vpn-core apply-lines on [cd]-DMIT-2", who: "cdcd", when: "2h ago" },
  { id: "e2", what: "agentupdate 0.3.6 to 0.3.9 on 34 nodes", who: "cdcd", when: "1d ago" },
  { id: "e3", what: "ssh-guard arm on [Metix]-Vultr-SG", who: "cdcd", when: "3d ago" },
];
/* A selectable table whose rows go somewhere: both gutters pin at 375. */
const selectColumns: DataTableColumn<GalleryNode>[] = [
  { key: "name", label: "Node" },
  { key: "status", label: "Status" },
  { key: "ip", label: "Address", class: "font-mono text-xs" },
  { key: "agent", label: "Agent", class: "font-mono text-xs" },
  { key: "tags", label: "Tags", value: (row) => row.tags.join(", ") },
  { key: "actions", label: "", class: "w-12", pin: "end" },
];
const selectRows = GALLERY_NODES.slice(0, 4);
const selectedNodes = ref(new Set([selectRows[1]!.id]));

/* A page that filters before the table: zero rows must keep the page's control. */
const upstreamColumns: DataTableColumn<GalleryNode>[] = [
  { key: "name", label: "Node", searchable: true },
  { key: "status", label: "Status" },
  { key: "ip", label: "Address", class: "font-mono text-xs" },
];
const upstreamStatus = ref<"all" | "online" | "offline" | "draining">("draining");
const upstreamRows = computed(() =>
  upstreamStatus.value === "all" ? selectRows : selectRows.filter((row) => row.status === upstreamStatus.value),
);

/* Grouped by the bracketed owner, as Nodes groups by default: the group row carries what spans it. */
function galleryOwner(row: GalleryNode): string {
  return /^\[([^\]]+)\]/.exec(row.name)?.[1] ?? "";
}

const eventColumns: DataTableColumn<EventRow>[] = [
  { key: "what", label: "Change" },
  { key: "who", label: "Actor" },
  { key: "when", label: "When" },
];

/* ------------------------------------------------------------------ */
/* ConfirmDialog classes                                               */
/* ------------------------------------------------------------------ */

const classDialog = ref<null | "reversible" | "internal" | "outside" | "node-config">(null);

function confirmed(what: string): void {
  toast(`${what} confirmed`);
  classDialog.value = null;
  confirm.value = null;
}

/* ------------------------------------------------------------------ */
/* QueryBar                                                            */
/* ------------------------------------------------------------------ */

// An Audit-shaped grammar, the first page wave 2 moves onto the bar.
const GRAMMAR: TokenGrammar = {
  fields: [
    { key: "node", kind: "list", resolve: "node", param: "node_id" },
    { key: "actor", kind: "value", param: "actor_id" },
    { key: "action", kind: "value" },
    { key: "decision", kind: "enum", values: ["allow", "deny", "observe"] },
  ],
  flags: [{ name: "failed", param: "failed_only" }],
};
const resolvers: TokenResolvers = {
  node: {
    toId: (value) => GALLERY_NODES.find((node) => node.id === value || node.name.toLowerCase() === value.toLowerCase())?.id,
    label: (id) => GALLERY_NODES.find((node) => node.id === id)?.name ?? id,
  },
};
const namesReady = ref(true);
// With "names loaded" off the node list has not answered: a search that runs
// after the wait resolves nothing and sends names as typed, like a real page.
const liveResolvers = computed<TokenResolvers>(() =>
  namesReady.value ? resolvers : { node: { toId: () => undefined, label: (id) => id } },
);
const range = ref("24h");
const since = ref("");
const until = ref("");
const appliedTokens = computed(() => readTokenQuery(route.query, GRAMMAR));
const appliedText = computed(() => formatTokens(appliedTokens.value, GRAMMAR, resolvers));
function applyText(text: string): void {
  router.replace({ query: writeTokenQuery(route.query, GRAMMAR, parseTokens(text, GRAMMAR, liveResolvers.value)) }).catch(() => {});
}
function clearQuery(): void {
  router.replace({ query: writeTokenQuery(route.query, GRAMMAR, { values: {}, enums: {}, flags: [], text: "" }) }).catch(() => {});
}
// After the wait a name that did not resolve was never looked up: the copy
// says so, and that an empty result may come from it, not "no such node".
function problemsFor(text: string): string[] {
  return parseTokens(text, GRAMMAR, liveResolvers.value).problems.map((problem) => {
    if (problem.kind === "unresolved") {
      return namesReady.value
        ? `${problem.token}: no node has that name; searched as typed`
        : `${problem.token}: not looked up, because the node list has not answered; searched as typed, so an empty result may come from that`;
    }
    return problem.kind === "empty-value" ? `${problem.token}: says nothing after the colon` : `${problem.token}: not a value this field knows`;
  });
}
const bar = ref<InstanceType<typeof QueryBar> | null>(null);
function toggleDecision(value: string): void {
  const parsed = parseTokens(bar.value?.draft ?? appliedText.value, GRAMMAR, resolvers);
  const set = new Set(parsed.enums.decision ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  parsed.enums.decision = ["allow", "deny", "observe"].filter((v) => set.has(v));
  router.replace({ query: writeTokenQuery(route.query, GRAMMAR, parsed) }).catch(() => {});
  bar.value?.settle(formatTokens(parsed, GRAMMAR, resolvers));
}
const filterGroups = computed<QueryFilterGroup[]>(() => [
  {
    key: "decision",
    legend: "Decision",
    options: ["allow", "deny", "observe"].map((value) => ({
      key: value,
      label: value[0]!.toUpperCase() + value.slice(1),
      token: `decision:${value}`,
      checked: (appliedTokens.value.enums.decision ?? []).includes(value),
      toggle: () => toggleDecision(value),
    })),
  },
]);
const RANGES = ["1h", "24h", "7d", "all", "custom"] as const;
const RANGE_LABEL: Record<string, string> = { "1h": "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days", all: "Any time", custom: "Custom range" };
</script>

<template>
  <div class="space-y-10 p-4 sm:p-6">
    <PageHeader title="Chassis gallery" description="Design 23, section 3: every shared component in every state.">
      <template #actions>
        <Button variant="outline" size="sm" type="button" @click="theme.setMode(theme.mode === 'light' ? 'dark' : 'light')">
          {{ theme.mode === 'light' ? 'Dark theme' : 'Light theme' }}
        </Button>
      </template>
    </PageHeader>

    <!-- 3.1 ProofLine -->
    <section class="space-y-3" data-gallery="proof">
      <h2 class="text-lg font-semibold">3.1 ProofLine</h2>
      <div class="divide-y divide-border rounded-lg border border-border">
        <div v-for="item in proofCases" :key="item.key" class="space-y-1 px-3.5 py-3">
          <p class="text-xs text-muted-foreground">{{ item.caption }}</p>
          <ProofLine :state="item.state" :observed-at="item.observedAt" :error="item.error" :segments="item.segments" @retry="toast('Retry')" />
        </div>
        <div class="space-y-1 px-3.5 py-3">
          <p class="text-xs text-muted-foreground">tones: strong, default, warning, and a link segment (Terminal)</p>
          <ProofLine state="idle" :segments="terminalSegments" />
        </div>
      </div>
      <div class="space-y-1">
        <p class="text-xs text-muted-foreground">FreshnessLabel until a page adopts ProofLine: polled every 12 s and read 9 s ago (no flicker), read 40 s ago (late), and a page that does not poll (renders nothing):</p>
        <div class="flex flex-wrap items-center gap-4">
          <FreshnessLabel :last-updated="now - 9_000" :poll-ms="12_000" />
          <FreshnessLabel :last-updated="now - 40_000" :poll-ms="12_000" />
          <span class="text-xs text-muted-foreground">[<FreshnessLabel :last-updated="now - 27_000" :poll-ms="0" />]</span>
        </div>
      </div>
    </section>

    <!-- 3.2 AttentionList -->
    <section class="space-y-3" data-gallery="attention">
      <h2 class="text-lg font-semibold">3.2 AttentionList</h2>
      <p class="text-xs text-muted-foreground">Danger, warning and information, each with the row that proves it. Information is listed and never counted.</p>
      <AttentionList :items="attentionFew" />
      <p class="text-xs text-muted-foreground">Ten items: five show, the rest fold behind Show all.</p>
      <AttentionList :items="attentionMany" />
      <p class="text-xs text-muted-foreground">Empty: renders nothing. [<AttentionList :items="[]" />]</p>
    </section>

    <!-- 3.3 MetricStrip -->
    <section class="space-y-3" data-gallery="metrics">
      <h2 class="text-lg font-semibold">3.3 MetricStrip</h2>
      <p class="text-xs text-muted-foreground">Four numbers that move.</p>
      <MetricStrip :metrics="metricsFour" />
      <p class="text-xs text-muted-foreground">Reading, not read, older server, and parts with their own tone.</p>
      <MetricStrip :metrics="metricsStates" />
      <p class="text-xs text-muted-foreground">Over the cap: still renders, and the console warns once in development.</p>
      <MetricStrip :metrics="metricsOver" :columns="5" />
    </section>

    <!-- 3.4 LayerTabs -->
    <section class="space-y-3" data-gallery="layers">
      <h2 class="text-lg font-semibold">3.4 LayerTabs</h2>
      <p class="text-xs text-muted-foreground">
        Bound to ?view=; an old ?tab= link lands on its layer and is rewritten once. From 620 px an underline row; below it a
        segmented control. Six layers do not fit at 375, so the row scrolls sideways with the current layer in view.
      </p>
      <LayerTabs v-model="layer" :tabs="layerTabs" label="Fleet layers" />
      <p class="font-mono text-xs text-muted-foreground" data-testid="layer-now">layer: {{ layer }}</p>
      <p class="text-xs text-muted-foreground">Three layers share the width at 375. Counts tint only when they ask for action.</p>
      <LayerTabs v-model="approvalLayer" :tabs="approvalTabs" label="Approvals layers" data-testid="layer-tabs-three" />
    </section>

    <!-- 3.5 to 3.7 DataTable, RowMenu, ObjectSheet -->
    <section class="space-y-3" data-gallery="table">
      <h2 class="text-lg font-semibold">3.5 to 3.7 DataTable, RowMenu, ObjectSheet</h2>
      <p class="text-xs text-muted-foreground">
        A row opens the sheet on ?open= (reload lands on it; Escape returns focus to the row). One menu per row, always visible;
        a disabled item says why. At 375 the table scrolls with the first column and the menu pinned.
      </p>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="text-muted-foreground">Table:</span>
        <Button v-for="mode in ['rows', 'loading', 'error', 'empty'] as const" :key="mode" size="sm" :variant="tableMode === mode ? 'secondary' : 'ghost'" type="button" @click="tableMode = mode">{{ mode }}</Button>
        <span class="ms-2 text-muted-foreground">Sheet:</span>
        <Button v-for="mode in ['auto', 'loading', 'stale', 'failed', 'readonly'] as const" :key="mode" size="sm" :variant="sheetMode === mode ? 'secondary' : 'ghost'" type="button" @click="sheetMode = mode">{{ mode }}</Button>
        <Button size="sm" variant="ghost" type="button" @click="sheet.open(GONE_NODE_ID)">open a deleted node</Button>
        <Button size="sm" variant="ghost" as-child><RouterLink :to="{ query: { ...route.query, 'nodes.q': 'no-such-node' } }">filter to nothing</RouterLink></Button>
      </div>
      <DataTable
        state-key="nodes"
        :columns="nodeColumns"
        :rows="tableRows"
        :row-key="(row) => row.id"
        :loading="tableMode === 'loading'"
        :error="tableMode === 'error' ? new Error('502 Bad Gateway') : null"
        :has-data="false"
        searchable
        :expression-filter="false"
        search-placeholder="Search 34 nodes"
        :row-click="(row, el) => sheet.open(row.id, el)"
        :active-row-id="sheet.openId.value"
        empty-title="No nodes enrolled"
        empty-description="A node appears here once its agent reports."
        @retry="tableMode = 'rows'"
      >
        <template #empty>
          <EmptyState title="No nodes enrolled" description="A node appears here once its agent reports. Enroll one with the install command.">
            <Button size="sm" type="button"><Plus aria-hidden="true" />Enroll a node</Button>
          </EmptyState>
        </template>
        <template #cell-name="{ row }">
          <span class="font-medium">{{ row.name }}</span>
        </template>
        <template #cell-status="{ row }">
          <Badge :variant="row.status === 'online' ? 'outline' : 'destructive'">{{ row.status }}</Badge>
        </template>
        <template #cell-lastSeen="{ row }">
          <span :class="row.status === 'offline' ? 'text-warning-text' : 'text-muted-foreground'">{{ ageText(row.lastSeenSec) }}</span>
        </template>
        <template #cell-cpu="{ row }">
          <span class="tabular">{{ row.cpu === null ? 'not reported' : `${row.cpu}%` }}</span>
        </template>
        <template #cell-tags="{ row }">
          <span class="text-xs text-muted-foreground">{{ row.tags.join(', ') }}</span>
        </template>
        <template #cell-actions="{ row }">
          <RowMenu :name="row.name" :items="menuFor(row)" />
        </template>
      </DataTable>

      <p class="text-xs text-muted-foreground">
        Selectable, with a row link and a pinned menu. At 375 the checkbox pins ahead of the first column and the chevron after
        the menu; the selected row's tint runs under the pinned cells.
      </p>
      <DataTable
        data-gallery="select-table"
        :columns="selectColumns"
        :rows="selectRows"
        :row-key="(row) => row.id"
        selectable
        v-model:selected="selectedNodes"
        :row-to="(row) => ({ query: { ...route.query, open: row.id } })"
        :show-summary="false"
      >
        <template #cell-name="{ row }">
          <span class="font-medium">{{ row.name }}</span>
        </template>
        <template #cell-actions="{ row }">
          <RowMenu :name="row.name" :items="menuFor(row)" />
        </template>
      </DataTable>

      <p class="text-xs text-muted-foreground">
        Filtered before the table: the page's own control stays when its filter leaves zero rows, so the filter can be cleared.
      </p>
      <DataTable
        data-gallery="upstream-table"
        :columns="upstreamColumns"
        :rows="upstreamRows"
        :row-key="(row) => row.id"
        searchable
        :show-summary="false"
        empty-title="No draining nodes"
      >
        <template #toolbar>
          <div class="flex items-center gap-1 text-xs" role="group" aria-label="Status">
            <Button
              v-for="value in ['all', 'online', 'offline', 'draining'] as const"
              :key="value"
              size="sm"
              type="button"
              :variant="upstreamStatus === value ? 'secondary' : 'ghost'"
              :aria-pressed="upstreamStatus === value"
              @click="upstreamStatus = value"
            >
              {{ value }}
            </Button>
          </div>
        </template>
      </DataTable>

      <p class="text-xs text-muted-foreground">Cards, opt-in, for rows read one at a time (approval events). Desktop keeps the table.</p>
      <DataTable :columns="eventColumns" :rows="eventRows" :row-key="(row) => row.id" narrow-layout="cards" :show-summary="false" />

      <p class="text-xs text-muted-foreground">
        Grouped (design 23, 3.7): a group row spans the table, carries what spans the group and collapses it. A column sort orders
        rows inside each group. At 375 the group label stays at the left edge while the columns scroll.
      </p>
      <DataTable
        data-gallery="grouped-table"
        :columns="selectColumns"
        :rows="GALLERY_NODES"
        :row-key="(row) => row.id"
        :group-key="galleryOwner"
        :group-order="['cd', 'Metix']"
        :show-summary="false"
        :row-click="(row, el) => sheet.open(row.id, el)"
        :active-row-id="sheet.openId.value"
      >
        <template #group="{ group }">
          <span class="font-medium text-foreground">{{ group.key || 'No owner' }}</span>
          <span class="font-mono tabular text-muted-foreground">
            {{ group.rows.length }} · {{ group.rows.filter((row) => row.status === 'online').length }} online
          </span>
          <span v-if="group.rows.some((row) => row.status === 'offline')" class="text-destructive">
            offline: {{ group.rows.filter((row) => row.status === 'offline').map((row) => row.name).join(', ') }}
          </span>
        </template>
        <template #cell-name="{ row }">
          <span class="font-medium">{{ row.name }}</span>
        </template>
        <template #cell-actions="{ row }">
          <RowMenu :name="row.name" :items="menuFor(row)" />
        </template>
      </DataTable>
    </section>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openNode?.name ?? sheet.openId.value ?? ''"
      :subtitle="sheet.openId.value ?? undefined"
      :page-to="openNode ? { name: 'node-detail', params: { id: openNode.id } } : undefined"
      :state="sheetState"
      :read-only="sheetMode === 'readonly'"
      :error="sheetMode === 'stale' || sheetMode === 'failed' ? '502 Bad Gateway' : null"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
      @retry="sheetMode = 'auto'"
    >
      <dl v-if="openNode" class="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt class="text-xs text-muted-foreground">Status</dt><dd>{{ openNode.status }}</dd></div>
        <div><dt class="text-xs text-muted-foreground">Last seen</dt><dd>{{ ageText(openNode.lastSeenSec) }}</dd></div>
        <div><dt class="text-xs text-muted-foreground">Address</dt><dd class="font-mono text-xs">{{ openNode.ip }}</dd></div>
        <div><dt class="text-xs text-muted-foreground">Agent</dt><dd class="font-mono text-xs">{{ openNode.agent }}</dd></div>
        <div v-if="openNode.status === 'offline'" class="sm:col-span-2">
          <dt class="text-xs text-muted-foreground">Why it is offline</dt>
          <dd>No report since the agent lost its connection; the node did not say why.</dd>
        </div>
      </dl>
      <template #actions>
        <Button variant="outline" size="sm" type="button" @click="toast('Terminal')">Open terminal</Button>
        <RowMenu v-if="openNode" :name="openNode.name" :items="menuFor(openNode)" />
      </template>
    </ObjectSheet>

    <!-- 3.8 ConfirmDialog -->
    <section class="space-y-3" data-gallery="confirm">
      <h2 class="text-lg font-semibold">3.8 ConfirmDialog and the destructive classes</h2>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" type="button" @click="classDialog = 'reversible'">Reversible: disable a plugin</Button>
        <Button variant="outline" size="sm" type="button" @click="classDialog = 'internal'">Inside Lattice: delete a cost profile</Button>
        <Button variant="outline" size="sm" type="button" @click="classDialog = 'outside'">Outside Lattice: delete a host binding</Button>
        <Button variant="outline" size="sm" type="button" @click="classDialog = 'node-config'">Leaves config on a node: delete a tunnel</Button>
      </div>
    </section>

    <ConfirmDialog
      :open="classDialog === 'reversible'"
      title="Disable sub-store?"
      description="Its pages leave the sidebar and its backend stops. Enable it again at any time; nothing is deleted."
      confirm-label="Disable"
      cancel-label="Cancel"
      variant="default"
      @update:open="(v) => { if (!v) classDialog = null; }"
      @confirm="confirmed('Disable')"
    />
    <ConfirmDialog
      :open="classDialog === 'internal'"
      title="Delete the cost profile for [cd]-Aaitr-ATT-VDS?"
      confirm-label="Delete profile"
      cancel-label="Cancel"
      :impact="['Inventory stops counting CNY 134.10 a month for this machine.', 'Its renewal reminder on 2027-01-06 is removed.']"
      @update:open="(v) => { if (!v) classDialog = null; }"
      @confirm="confirmed('Delete profile')"
    />
    <ConfirmDialog
      :open="classDialog === 'outside'"
      title="Delete the host binding docs.roobli.org?"
      confirm-label="Delete binding"
      cancel-label="Cancel"
      :impact="['https://docs.roobli.org stops serving at once; visitors get a 404.', 'Links to it that people shared stop working. Creating the binding again restores the URL.']"
      typed-confirm="docs.roobli.org"
      @update:open="(v) => { if (!v) classDialog = null; }"
      @confirm="confirmed('Delete binding')"
    />
    <ConfirmDialog
      :open="classDialog === 'node-config'"
      title="Delete the tunnel edge-hkg?"
      confirm-label="Delete tunnel"
      cancel-label="Cancel"
      :impact="['cloudflared on [cd]-gomami-hkg keeps running with the config it last applied.', 'Once this record is gone the console can no longer plan its removal.']"
      typed-confirm="edge-hkg"
      @update:open="(v) => { if (!v) classDialog = null; }"
      @confirm="confirmed('Delete tunnel')"
    />
    <ConfirmDialog
      :open="confirm === 'disable'"
      :title="`Disable ${confirmTarget?.name}?`"
      description="The node stops taking tasks and plans until you enable it again."
      confirm-label="Disable"
      cancel-label="Cancel"
      variant="default"
      @update:open="(v) => { if (!v) confirm = null; }"
      @confirm="confirmed('Disable node')"
    />
    <ConfirmDialog
      :open="confirm === 'delete'"
      :title="`Delete ${confirmTarget?.name}?`"
      confirm-label="Delete node"
      cancel-label="Cancel"
      :impact="['The agent is refused on its next report and stops taking plans.', 'Its history stays in Audit.']"
      :typed-confirm="confirmTarget?.name"
      @update:open="(v) => { if (!v) confirm = null; }"
      @confirm="confirmed('Delete node')"
    />

    <!-- 3.9 QueryBar -->
    <section class="space-y-3" data-gallery="query">
      <h2 class="text-lg font-semibold">3.9 QueryBar</h2>
      <p class="text-xs text-muted-foreground">
        Tokens whose keys map to the URL and HTTP names (node:[cd]-DMIT-2 writes node_id=). Try
        <code class="font-mono">node:[metix]-dmit-2 decision:deny failed apply</code>, a name that does not exist, or uncheck
        "names loaded" and search. The empty field's example tokens sit at about 3:1 in dark mode, well below entered text, so
        they never read as an applied filter.
      </p>
      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        <input v-model="namesReady" type="checkbox" class="size-4" /> names loaded
      </label>
      <QueryBar
        ref="bar"
        :applied-text="appliedText"
        label="Audit query"
        placeholder="node:[cd]-DMIT-2 actor:cdcd action:network.apply decision:deny"
        :ready="namesReady"
        :problems="problemsFor"
        :canonical="(text) => formatTokens(parseTokens(text, GRAMMAR, resolvers), GRAMMAR, resolvers)"
        :ranges="RANGES"
        :range="range"
        :range-label="(value) => RANGE_LABEL[value] ?? value"
        :since="since"
        :until="until"
        :filter-count="tokenFilterCount(appliedTokens, GRAMMAR, ['decision', 'failed'])"
        :filter-groups="filterGroups"
        filters-hint="Each choice writes the token it shows into the field."
        @submit="applyText"
        @clear="clearQuery"
        @update:range="(value) => (range = value)"
        @update:since="(iso) => (since = iso)"
        @update:until="(iso) => (until = iso)"
      />
      <p class="font-mono text-xs break-all text-muted-foreground" data-testid="query-address">address: {{ JSON.stringify(route.query) }}</p>
    </section>

    <!-- 3.10 NodeLabel -->
    <section class="space-y-3" data-gallery="node-label">
      <h2 class="text-lg font-semibold">3.10 NodeLabel</h2>
      <ul class="space-y-1 text-sm">
        <li>Known: <NodeLabel :id="GALLERY_NODES[21]!.id" /></li>
        <li>Known, as a link: <NodeLabel :id="GALLERY_NODES[21]!.id" link /></li>
        <li>Not in the list (deleted): <NodeLabel :id="GONE_NODE_ID" /></li>
      </ul>
    </section>
  </div>
</template>
