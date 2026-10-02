<script setup lang="ts">
/**
 * Audit (design 23, section 4.3): layers Changes · All events · Integrity on
 * `?view=`.
 *
 * Changes opens on the last 24 hours and hides node online/offline flips and
 * observe events inside the server's scan (auditModel), so the count and the
 * pages stay true to the question. The proof line says what was scanned:
 * "412 of 5,760 scanned", or "at least 50,000, scan stopped at 200,000" when
 * the server hit its cap. One query field in the shared token grammar; every
 * key is the server's own parameter. A row opens the event in the side sheet
 * on `?open=` with its fields, metadata and correlation trace inline; the
 * metadata JSON no longer rides in the row. Paging past page 1 stops the
 * poll, so page 2 does not shift under the operator while they read it.
 * Verify chain lives in Integrity, and its last result (kept per browser)
 * rides the proof line on every layer.
 */
import { computed, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "@/lib/toast";
import { ChevronLeft, ChevronRight, Download, RefreshCw, ShieldCheck } from "lucide-vue-next";

import { api, unwrap, type AuditEvent, type AuditVerifyResponse, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { bindLayer } from "@/composables/useLayer";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { useNodeDirectory, provideNodeDirectory } from "@/composables/useNodeDirectory";
import { useProof, type ProofBinding } from "@/composables/useProof";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { formatAge, formatDateTime, shortId } from "@/lib/format";
import { type BadgeVariant } from "@/lib/status";
import type { TokenResolvers } from "@/lib/queryTokens";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import QueryBar, { type QueryFilterGroup } from "@/components/common/QueryBar.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import CorrelationTrace from "@/components/common/CorrelationTrace.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import {
  AUDIT_DECISION_CHOICES,
  AUDIT_GRAMMAR,
  AUDIT_LAYERS,
  AUDIT_PAGE_SIZE,
  VERIFY_STORAGE_KEY,
  auditRequest,
  auditScan,
  exclusionsIgnored,
  readStoredVerify,
  type AuditLayer,
  type AuditQueryParams,
  type StoredVerify,
} from "./auditModel";
import { OPS_RANGES, pageBounds, rangeWindow } from "./opsQueryModel";
import { useOpsQuery } from "./useOpsQuery";

const { t, locale } = useI18n();

/** One owned route: layer, query and sheet write the same address. */
const owned = useOwnedRoute();
const layer = bindLayer<AuditLayer>(owned, () => AUDIT_LAYERS, () => "changes");

/* ------------------------------------------------------------------ */
/* Nodes, for names in rows and for node: tokens                       */
/* ------------------------------------------------------------------ */

const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), { pollInterval: 60_000 });
const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);
provideNodeDirectory(nodes);
const directory = useNodeDirectory();

const resolvers = computed<TokenResolvers>(() => ({
  node: {
    toId: (value) => {
      const list = directory?.value ?? [];
      return list.find((node) => node.id === value)?.id ?? list.find((node) => (node.name ?? "").toLowerCase() === value.toLowerCase())?.id;
    },
    label: (id) => (directory?.value ?? []).find((node) => node.id === id)?.name || id,
  },
}));

/* ------------------------------------------------------------------ */
/* The question, the window and the page, all in the address           */
/* ------------------------------------------------------------------ */

const query = useOpsQuery({
  grammar: AUDIT_GRAMMAR,
  resolvers: () => resolvers.value,
  defaultRange: "24h",
  unchecked: () => nodesQuery.data.value === undefined,
  owned,
});
const bar = ref<InstanceType<typeof QueryBar> | null>(null);
const listing = computed(() => layer.value !== "integrity");

/** The request behind the rows on screen, so the proof line describes what was asked. */
const shownParams = ref<AuditQueryParams | null>(null);

const auditQuery = useAsyncData(
  async (signal) => {
    const params = auditRequest({
      layer: layer.value,
      tokens: query.applied.value,
      window: rangeWindow(query.range.value, Date.now()),
      offset: query.offset.value,
      limit: AUDIT_PAGE_SIZE,
    });
    const response = await api.audit.query(params, { signal });
    shownParams.value = params;
    return response;
  },
  { immediate: listing.value },
);

// A new question, window, page or layer is a new read.
watch(
  () => [layer.value, query.appliedKey.value, JSON.stringify(query.range.value), query.offset.value] as const,
  () => {
    if (listing.value) void auditQuery.refresh();
  },
);

/**
 * Poll page 1 only. Past it, a tick would re-page under the operator (offset
 * paging over a log that grows at the head), so the page holds still until
 * they come back or press Refresh.
 */
const POLL_MS = 12_000;
const polling = computed(() => listing.value && query.offset.value === 0);
const timer = setInterval(() => {
  if (polling.value && document.visibilityState !== "hidden") void auditQuery.refresh();
}, POLL_MS);
onScopeDispose(() => clearInterval(timer));

const events = computed<AuditEvent[]>(() => auditQuery.data.value?.events ?? []);
const total = computed(() => auditQuery.data.value?.total ?? 0);
const scan = computed(() => auditScan(auditQuery.data.value));
const bounds = computed(() => pageBounds(query.offset.value, events.value.length));
const hasPrev = computed(() => query.offset.value > 0);
const hasNext = computed(() => bounds.value.to < total.value);

function num(n: number): string {
  return n.toLocaleString(locale.value);
}

const totalText = computed(() => (scan.value?.kind === "capped" ? t("operations.audit.atLeast", { n: num(total.value) }) : num(total.value)));

/* ------------------------------------------------------------------ */
/* Verify chain: Integrity runs it; its last result rides every layer  */
/* ------------------------------------------------------------------ */

function readStored(): StoredVerify | null {
  try {
    return readStoredVerify(localStorage.getItem(VERIFY_STORAGE_KEY));
  } catch {
    return null;
  }
}

const lastVerify = ref<StoredVerify | null>(readStored());
const verifyPending = ref(false);
const verifyResult = ref<AuditVerifyResponse | undefined>();
const verifyError = ref("");

async function verifyChain(): Promise<void> {
  verifyPending.value = true;
  verifyError.value = "";
  try {
    const result = await api.audit.verify();
    verifyResult.value = result;
    const stored: StoredVerify = { at: new Date().toISOString(), enabled: result.enabled, ok: result.ok === true, count: result.count };
    lastVerify.value = stored;
    try {
      localStorage.setItem(VERIFY_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* ignore storage errors */
    }
    if (!result.enabled) toast.info(t("operations.audit.toastVerifyDisabled"));
    else if (result.ok) toast.success(t("operations.audit.toastVerified"));
    else toast.error(t("operations.audit.toastChainBroken"));
  } catch (error) {
    verifyError.value = error instanceof Error ? error.message : t("operations.audit.toastVerifyFailed");
    toast.error(verifyError.value);
  } finally {
    verifyPending.value = false;
  }
}

const offBoxAnchorRecord = computed(() => {
  const result = verifyResult.value;
  if (!result?.enabled || !result.ok || !result.anchored || !result.head) return "";
  return JSON.stringify(
    {
      type: "lattice.audit_head.v1",
      verified_at: lastVerify.value?.at ?? "",
      ok: !!result.ok,
      count: result.count ?? 0,
      head: result.head,
      anchored: !!result.anchored,
      anchor_count: result.anchor_count ?? null,
      anchor_head: result.anchor_head ?? null,
      anchor_pending: result.anchor_pending ?? null,
    },
    null,
    2,
  );
});

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportAuditHead(): void {
  if (!offBoxAnchorRecord.value) {
    toast.info(t("operations.audit.noAnchorToExport"));
    return;
  }
  downloadFile("lattice-audit-head.json", offBoxAnchorRecord.value + "\n", "application/json");
  toast.success(t("operations.audit.anchorExported"));
}

/* ------------------------------------------------------------------ */
/* Export: the page on screen, and it says so                          */
/* ------------------------------------------------------------------ */

function csvCell(value: unknown): string {
  const s = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(): void {
  const headers = ["at", "decision", "action", "scope", "actor_id", "token_id", "node_id", "correlation_id", "reason", "metadata"];
  const rows = events.value.map((e) =>
    [e.at, e.decision, e.action, e.scope, e.actor_id, e.token_id, e.node_id, e.correlation_id, e.reason, e.metadata].map(csvCell).join(","),
  );
  downloadFile("lattice-audit.csv", [headers.join(","), ...rows].join("\n"), "text/csv");
  toast.success(t("operations.audit.exported", { count: events.value.length }));
}

function exportNdjson(): void {
  downloadFile("lattice-audit.ndjson", events.value.map((e) => JSON.stringify(e)).join("\n"), "application/x-ndjson");
  toast.success(t("operations.audit.exported", { count: events.value.length }));
}

/* ------------------------------------------------------------------ */
/* The head: proof line and layers                                     */
/* ------------------------------------------------------------------ */

const listProof = useProof({
  data: auditQuery.data,
  error: auditQuery.error,
  loading: auditQuery.loading,
  refreshing: auditQuery.refreshing,
  lastUpdated: auditQuery.lastUpdated,
  get pollMs() {
    return polling.value ? POLL_MS : 0;
  },
});

/**
 * Integrity reads no events, so its line speaks for the chain alone: no
 * age (nothing polls), a spinner while a verify runs, and the chain segment.
 */
const proofBinding = computed<ProofBinding>(() =>
  listing.value
    ? listProof.value
    : { state: verifyPending.value ? "refreshing" : "idle", observedAt: null, pollMs: 0, error: null },
);

function rangeText(): string {
  const range = query.range.value;
  if (range.range !== "custom") return t(`operations.opsRange.proof.${range.range}`);
  return t("operations.opsRange.proof.custom", {
    from: range.since ? formatDateTime(range.since) : t("operations.opsRange.open"),
    to: range.until ? formatDateTime(range.until) : t("operations.opsRange.now"),
  });
}

const chainSegment = computed<ProofSegment>(() => {
  const last = lastVerify.value;
  const to = { query: { view: "integrity" } };
  if (!last) return { key: "chain", text: t("operations.audit.proof.chainUnchecked"), tone: "muted", to };
  const age = formatAge(Date.now() - Date.parse(last.at), locale.value);
  if (!last.enabled) return { key: "chain", text: t("operations.audit.proof.chainOff"), tone: "muted", to };
  return last.ok
    ? { key: "chain", text: t("operations.audit.proof.chainVerified", { age }), to }
    : { key: "chain", text: t("operations.audit.proof.chainBroken", { age }), tone: "destructive", to };
});

const proofSegments = computed<ProofSegment[]>(() => {
  const segments: ProofSegment[] = [];
  if (listing.value) {
    segments.push({ key: "range", text: rangeText() });
    const s = scan.value;
    // Two segments, scanned first: "3,007 of 5,750 scanned" read as a scan
    // that stopped partway, which is the capped form's job to say.
    if (s?.kind === "complete") {
      segments.push({ key: "scan", text: t("operations.audit.proof.scanned", { n: num(s.scanned) }) });
      segments.push({ key: "match", text: t("operations.audit.proof.matched", { n: num(s.total) }) });
    }
    else if (s?.kind === "capped") {
      segments.push({ key: "scan", text: t("operations.audit.proof.capped", { total: num(s.total), scanned: num(s.scanned) }), tone: "warning" });
    } else if (s) segments.push({ key: "scan", text: t("operations.audit.proof.events", { total: num(s.total) }) });
    if (layer.value === "changes") {
      // An older server ignores the exclusions; then say so instead of claiming them.
      const ignored = !!shownParams.value && exclusionsIgnored(shownParams.value, events.value);
      segments.push(
        ignored
          ? { key: "hidden", text: t("operations.audit.proof.notHidden"), tone: "warning" }
          : { key: "hidden", text: t("operations.audit.proof.hidden"), tone: "muted" },
      );
    }
  }
  segments.push(chainSegment.value);
  return segments;
});

const layerTabs = computed<LayerTab<AuditLayer>[]>(() => [
  { value: "changes", label: t("operations.audit.layers.changes") },
  { value: "all", label: t("operations.audit.layers.all") },
  { value: "integrity", label: t("operations.audit.layers.integrity") },
]);

/* ------------------------------------------------------------------ */
/* Filters popover                                                     */
/* ------------------------------------------------------------------ */

const ACTION_NAMESPACES = ["task.*", "approval.*", "network.*", "node.*", "auth.*"] as const;

const filterCount = computed(() => Object.keys(query.applied.value.values).length);

const filterGroups = computed<QueryFilterGroup[]>(() => {
  const values = query.applied.value.values;
  return [
    {
      key: "decision",
      legend: t("operations.audit.colDecision"),
      options: AUDIT_DECISION_CHOICES.map((decision) => ({
        key: decision,
        label: t(`operations.audit.decisionName.${decision}`),
        token: `decision:${decision}`,
        checked: values.decision === decision,
        toggle: () =>
          query.edit(bar, (next) => {
            if (next.values.decision === decision) delete next.values.decision;
            else next.values.decision = decision;
          }),
      })),
    },
    {
      key: "action",
      legend: t("operations.audit.actionNamespace"),
      options: ACTION_NAMESPACES.map((namespace) => ({
        key: namespace,
        label: namespace,
        token: `action:${namespace}`,
        checked: values.action === namespace,
        toggle: () =>
          query.edit(bar, (next) => {
            if (next.values.action === namespace) delete next.values.action;
            else next.values.action = namespace;
          }),
      })),
    },
  ];
});

/* ------------------------------------------------------------------ */
/* Rows and the sheet                                                  */
/* ------------------------------------------------------------------ */

/**
 * Colour marks the exception. Nearly every event is an allow, and a green
 * badge on every row said nothing while drowning the denies.
 */
function decisionVariant(value: string): BadgeVariant {
  if (value === "deny") return "destructive";
  if (value === "warn") return "warning";
  if (value === "observe" || value === "dismiss") return "secondary";
  return "outline";
}

const columns = computed<DataTableColumn<AuditEvent>[]>(() => [
  { key: "at", label: t("operations.audit.colTime"), wrap: true, class: "md:whitespace-nowrap" },
  { key: "decision", label: t("operations.audit.colDecision") },
  { key: "action", label: t("operations.audit.colAction") },
  { key: "node_id", label: t("operations.audit.colNode") },
  { key: "actor_id", label: t("operations.audit.colActor") },
  { key: "reason", label: t("operations.audit.colReason"), class: "max-w-[22rem]" },
]);

const sheet = bindRouteOpen(owned);
const openEvent = computed(() => events.value.find((event) => event.id === sheet.openId.value));
const sheetState = computed<"ready" | "loading" | "gone">(() => {
  if (openEvent.value) return "ready";
  if (auditQuery.data.value === undefined) return auditQuery.error.value ? "gone" : "loading";
  return "gone";
});
/** The page was never read, so the event is not known to be missing. */
const sheetReadFailure = computed<string | null>(() =>
  auditQuery.data.value === undefined && auditQuery.error.value ? auditQuery.error.value.message : null,
);

function metadataEntries(event: AuditEvent): Array<[string, string]> {
  return Object.entries(event.metadata ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
}

function searchAnyTime(): void {
  query.setRange("all");
}

function refreshNow(): void {
  void auditQuery.refresh();
  void nodesQuery.refresh();
}
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('operations.audit.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('operations.audit.description') }}</p>
        <ProofLine v-bind="proofBinding" :segments="proofSegments" data-testid="audit-proof-line" @retry="refreshNow" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="auditQuery.refreshing.value" @click="refreshNow">
          <RefreshCw :class="cn('size-4', auditQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('operations.audit.layers.label')" />

    <!-- Changes and All events: one question, one page of answers. -->
    <template v-if="listing">
      <QueryBar
        ref="bar"
        testid="audit-query-bar"
        :applied-text="query.appliedText.value"
        :applied-key="query.appliedKey.value"
        :label="$t('operations.audit.queryLabel')"
        :placeholder="$t('operations.audit.queryPlaceholder')"
        :ready="nodesQuery.data.value !== undefined || nodesQuery.error.value !== undefined"
        :problems="query.problems"
        :canonical="query.canonical"
        :ranges="OPS_RANGES"
        :range="query.range.value.range"
        :range-label="(value) => $t(`operations.opsRange.${value}`)"
        :since="query.range.value.since"
        :until="query.range.value.until"
        :filter-count="filterCount"
        :filter-groups="filterGroups"
        :filters-hint="$t('operations.audit.filtersHint')"
        @submit="query.submit"
        @clear="query.clear"
        @update:range="query.setRange"
        @update:since="(iso) => query.setBound('since', iso)"
        @update:until="(iso) => query.setBound('until', iso)"
      />

      <DataTable
        :columns="columns"
        :rows="events"
        :row-key="(event) => event.id"
        :loading="auditQuery.loading.value"
        :error="auditQuery.error.value"
        :has-data="auditQuery.data.value !== undefined"
        :show-summary="false"
        :row-click="(event, el) => sheet.open(event.id, el)"
        :active-row-id="sheet.openId.value"
        data-testid="audit-table"
        @retry="refreshNow"
      >
        <template #empty>
          <EmptyState
            :title="layer === 'changes' ? $t('operations.audit.emptyChangesTitle') : $t('operations.audit.emptyAllTitle')"
            :description="$t('operations.audit.emptyWindowDescription', { range: rangeText() })"
          >
            <Button v-if="query.range.value.range !== 'all'" variant="outline" size="sm" type="button" @click="searchAnyTime">
              {{ $t('operations.opsRange.searchAnyTime') }}
            </Button>
          </EmptyState>
        </template>
        <template #cell-at="{ row }">
          <span class="text-xs text-muted-foreground tabular" :title="row.at">{{ formatDateTime(row.at) }}</span>
        </template>
        <template #cell-decision="{ row }">
          <Badge :variant="decisionVariant(row.decision)">{{ row.decision }}</Badge>
        </template>
        <template #cell-action="{ row }">
          <span class="font-medium">{{ row.action }}</span>
          <span v-if="row.scope" class="ms-2 font-mono text-xs text-muted-foreground">{{ row.scope }}</span>
        </template>
        <template #cell-node_id="{ row }">
          <NodeLabel v-if="row.node_id" :id="row.node_id" />
          <span v-else class="text-muted-foreground">{{ $t('common.misc.global') }}</span>
        </template>
        <template #cell-actor_id="{ row }">
          <span :class="row.actor_id ? '' : 'text-muted-foreground'">{{ row.actor_id || $t('operations.audit.systemActor') }}</span>
        </template>
        <template #cell-reason="{ row }">
          <span class="line-clamp-2 text-xs text-muted-foreground">{{ row.reason }}</span>
        </template>
      </DataTable>

      <div
        v-if="auditQuery.data.value !== undefined && events.length"
        class="flex flex-wrap items-center justify-between gap-2 text-sm"
        data-testid="audit-pager"
      >
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground tabular">
            {{ $t('operations.audit.showingRange', { from: num(bounds.from), to: num(bounds.to), total: totalText }) }}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" type="button">
                <Download class="size-4" aria-hidden="true" />
                {{ $t('operations.audit.exportMenu') }}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-64">
              <DropdownMenuItem @select="exportCsv">{{ $t('operations.audit.exportCsv', { count: events.length }) }}</DropdownMenuItem>
              <DropdownMenuItem @select="exportNdjson">{{ $t('operations.audit.exportNdjson', { count: events.length }) }}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="!polling" class="text-xs text-muted-foreground">{{ $t('operations.audit.pausedPastFirst') }}</span>
          <Button variant="outline" size="sm" :disabled="!hasPrev || auditQuery.loading.value" @click="query.setOffset(query.offset.value - AUDIT_PAGE_SIZE)">
            <ChevronLeft class="size-4" aria-hidden="true" />
            {{ $t('operations.audit.prev') }}
          </Button>
          <Button variant="outline" size="sm" :disabled="!hasNext || auditQuery.loading.value" @click="query.setOffset(query.offset.value + AUDIT_PAGE_SIZE)">
            {{ $t('operations.audit.next') }}
            <ChevronRight class="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </template>

    <!-- Integrity: the chain, checked on request. -->
    <section v-else class="max-w-3xl space-y-4" data-testid="audit-integrity">
      <div class="space-y-1">
        <h2 class="text-base font-semibold">{{ $t('operations.audit.integrity.title') }}</h2>
        <p class="text-sm text-muted-foreground">{{ $t('operations.audit.integrity.description') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <Button type="button" :disabled="verifyPending" @click="verifyChain">
          <RefreshCw v-if="verifyPending" class="size-4 animate-spin" aria-hidden="true" />
          <ShieldCheck v-else class="size-4" aria-hidden="true" />
          {{ $t('operations.audit.integrity.verify') }}
        </Button>
        <span class="text-sm text-muted-foreground">
          <template v-if="lastVerify">
            {{ $t('operations.audit.integrity.lastRun', { time: formatDateTime(lastVerify.at) }) }}
          </template>
          <template v-else>{{ $t('operations.audit.integrity.never') }}</template>
        </span>
      </div>
      <p v-if="verifyError" class="text-sm text-destructive">{{ verifyError }}</p>

      <div v-if="verifyResult" class="space-y-3 rounded-md border border-border bg-muted/20 p-4 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <Badge v-if="!verifyResult.enabled" variant="secondary">{{ $t('operations.audit.chainDisabled') }}</Badge>
          <Badge v-else :variant="verifyResult.ok ? 'success' : 'destructive'">
            {{ verifyResult.ok ? $t('operations.audit.chainOkBadge') : $t('operations.audit.chainFailedBadge') }}
          </Badge>
          <Badge v-if="verifyResult.enabled" :variant="verifyResult.anchored ? 'success' : 'warning'">
            {{ verifyResult.anchored ? $t('operations.audit.anchoredBadge') : $t('operations.audit.unanchoredBadge') }}
          </Badge>
          <span v-if="verifyResult.enabled" class="tabular">{{ $t('operations.audit.eventsCount', { count: num(verifyResult.count ?? 0) }) }}</span>
        </div>
        <p v-if="verifyResult.error" class="text-destructive">{{ verifyResult.error }}</p>
        <div v-if="verifyResult.enabled" class="grid gap-2 text-xs">
          <div v-if="verifyResult.head" class="grid gap-1">
            <span class="font-medium text-muted-foreground">{{ $t('operations.audit.walHead') }}</span>
            <div class="flex min-w-0 items-center gap-2">
              <code class="min-w-0 flex-1 break-all font-mono text-muted-foreground">{{ verifyResult.head }}</code>
              <CopyButton :value="verifyResult.head" />
            </div>
          </div>
          <div v-if="verifyResult.anchor_head" class="grid gap-1">
            <span class="font-medium text-muted-foreground">{{ $t('operations.audit.anchorHead') }}</span>
            <div class="flex min-w-0 items-center gap-2">
              <code class="min-w-0 flex-1 break-all font-mono text-muted-foreground">{{ verifyResult.anchor_head }}</code>
              <CopyButton :value="verifyResult.anchor_head" />
            </div>
          </div>
          <p v-if="verifyResult.anchor_pending" class="text-warning-text">
            {{ $t('operations.audit.anchorPending', { count: verifyResult.anchor_pending.count }) }}
          </p>
        </div>
        <div v-if="offBoxAnchorRecord" class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p class="font-medium">{{ $t('operations.audit.offboxAnchor') }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('operations.audit.offboxAnchorHint') }}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <CopyButton :value="offBoxAnchorRecord" :label="$t('operations.audit.copyOffboxAnchor')" />
              <Button type="button" variant="outline" size="sm" @click="exportAuditHead">
                <Download class="size-4" aria-hidden="true" />
                {{ $t('operations.audit.downloadOffboxAnchor') }}
              </Button>
            </div>
          </div>
          <pre class="relative max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/80 p-3 font-mono text-xs">{{ offBoxAnchorRecord }}</pre>
        </div>
      </div>
    </section>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openEvent?.action ?? $t('operations.audit.sheet.title')"
      :subtitle="sheet.openId.value ?? undefined"
      :mono-title="!!openEvent"
      :state="sheetState"
      :gone-title="sheetReadFailure ? $t('operations.audit.sheet.notReadTitle') : $t('operations.audit.sheet.goneTitle')"
      :gone-description="sheetReadFailure
        ? $t('operations.audit.sheet.notReadDescription', { reason: sheetReadFailure })
        : $t('operations.audit.sheet.goneDescription')"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
    >
      <div v-if="openEvent" class="space-y-6">
        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.colTime') }}</dt>
            <dd class="tabular" :title="openEvent.at">{{ formatDateTime(openEvent.at) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.colDecision') }}</dt>
            <dd><Badge :variant="decisionVariant(openEvent.decision)">{{ openEvent.decision }}</Badge></dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.colNode') }}</dt>
            <dd>
              <NodeLabel v-if="openEvent.node_id" :id="openEvent.node_id" link />
              <span v-else class="text-muted-foreground">{{ $t('common.misc.global') }}</span>
            </dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.colActor') }}</dt>
            <dd>{{ openEvent.actor_id || $t('operations.audit.systemActor') }}</dd>
          </div>
          <div v-if="openEvent.scope">
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.sheet.scope') }}</dt>
            <dd class="font-mono text-xs">{{ openEvent.scope }}</dd>
          </div>
          <div v-if="openEvent.token_id">
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.sheet.token') }}</dt>
            <dd class="font-mono text-xs">{{ openEvent.token_id }}</dd>
          </div>
          <div v-if="openEvent.reason" class="sm:col-span-2">
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.colReason') }}</dt>
            <dd class="break-words">{{ openEvent.reason }}</dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="text-xs text-muted-foreground">{{ $t('operations.audit.sheet.eventId') }}</dt>
            <dd class="flex min-w-0 items-center gap-2">
              <code class="min-w-0 break-all font-mono text-xs">{{ openEvent.id }}</code>
              <CopyButton :value="openEvent.id" />
            </dd>
          </div>
        </dl>

        <section v-if="metadataEntries(openEvent).length" class="space-y-2">
          <h3 class="text-sm font-medium">{{ $t('operations.audit.sheet.metadata') }}</h3>
          <dl class="divide-y divide-border rounded-md border border-border text-xs">
            <div v-for="[key, value] in metadataEntries(openEvent)" :key="key" class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-3 px-3 py-2">
              <dt class="font-mono text-muted-foreground">{{ key }}</dt>
              <dd class="min-w-0 break-all font-mono">{{ value }}</dd>
            </div>
          </dl>
        </section>

        <section class="space-y-2">
          <h3 class="flex flex-wrap items-center gap-2 text-sm font-medium">
            {{ $t('operations.audit.sheet.trace') }}
            <code v-if="openEvent.correlation_id" class="font-mono text-xs font-normal text-muted-foreground" :title="openEvent.correlation_id">
              {{ shortId(openEvent.correlation_id, 18) }}
            </code>
          </h3>
          <CorrelationTrace v-if="openEvent.correlation_id" :correlation-id="openEvent.correlation_id" />
          <p v-else class="text-sm text-muted-foreground">{{ $t('operations.audit.sheet.noTrace') }}</p>
        </section>
      </div>
    </ObjectSheet>
  </div>
</template>
