<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { CheckCircle2, ChevronLeft, ChevronRight, Download, RefreshCw, ScrollText, Search, ShieldCheck, X } from "lucide-vue-next";
import { api, type AuditEvent, type AuditVerifyResponse } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { type BadgeVariant } from "@/lib/status";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
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

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const action = ref("");
/** "any" is a sentinel for the themed Select (reka-ui forbids empty-string item values). */
const decision = ref<"any" | "allow" | "deny" | "observe">("any");
const nodeId = ref("");
const correlationId = ref("");
const q = ref("");
const timeRange = ref<"all" | "15m" | "1h" | "24h" | "7d">("all");
const limit = ref(50);
// Server-side paging cursor. Filters reset it to 0; prev/next step by the page
// size. The whole filter+page state is mirrored in the URL so a query is
// shareable/bookmarkable.
const offset = ref(0);
{
  const Q = route.query;
  const s = (k: string) => (typeof Q[k] === "string" ? (Q[k] as string).trim() : "");
  if (s("q")) q.value = s("q");
  if (s("action")) action.value = s("action");
  const d = s("decision");
  if (d === "allow" || d === "deny" || d === "observe") decision.value = d;
  if (s("node_id")) nodeId.value = s("node_id");
  if (s("correlation_id")) correlationId.value = s("correlation_id");
  const r = s("range");
  if (r === "15m" || r === "1h" || r === "24h" || r === "7d") timeRange.value = r;
  const lim = Number(s("limit"));
  if (lim >= 1 && lim <= 500) limit.value = lim;
  const off = Number(s("offset"));
  if (off > 0) offset.value = off;
}
const pageSize = computed(() => Math.min(500, Math.max(1, Number(limit.value) || 50)));

const RANGE_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};
// Computed at query time so the relative window slides on each refresh.
function rangeFrom(): string | undefined {
  const ms = RANGE_MS[timeRange.value];
  return ms ? new Date(Date.now() - ms).toISOString() : undefined;
}
const verifyPending = ref(false);
const verifyResult = ref<AuditVerifyResponse | undefined>();
const verifyCheckedAt = ref("");

const auditQuery = useAsyncData(
  () =>
    api.audit.query({
      action: action.value.trim() || undefined,
      decision: decision.value === "any" ? undefined : decision.value,
      node_id: nodeId.value.trim() || undefined,
      correlation_id: correlationId.value.trim() || undefined,
      q: q.value.trim() || undefined,
      at_from: rangeFrom(),
      limit: pageSize.value,
      offset: offset.value,
    }),
  { pollInterval: 12000 },
);

const events = computed<AuditEvent[]>(() => auditQuery.data.value?.events ?? []);
const total = computed(() => auditQuery.data.value?.total ?? events.value.length);

const columns = computed<DataTableColumn<AuditEvent>[]>(() => [
  { key: "decision", label: t("operations.audit.decision"), sortable: true },
  { key: "action", label: t("operations.audit.action"), sortable: true },
  { key: "at", label: t("operations.audit.colTime"), sortable: true, align: "right" },
  { key: "id", label: t("operations.audit.colId"), align: "right" },
]);

// Audit-specific colour semantics (not node-health): observe is informational,
// not "unknown". allow=green, deny=red, observe=blue.
function decisionVariant(value: string): BadgeVariant {
  if (value === "allow") return "success";
  if (value === "deny") return "destructive";
  if (value === "observe") return "info";
  return "secondary";
}

function metadataText(event: AuditEvent): string {
  if (!event.metadata || Object.keys(event.metadata).length === 0) return "";
  return JSON.stringify(event.metadata, null, 2);
}

async function verifyAudit() {
  verifyPending.value = true;
  try {
    verifyResult.value = await api.audit.verify();
    verifyCheckedAt.value = new Date().toISOString();
    if (verifyResult.value.ok) {
      toast.success(t("operations.audit.toastVerified"));
    } else {
      toast.error(t("operations.audit.toastVerifyFailed"));
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.audit.toastVerifyFailed"));
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
      verified_at: verifyCheckedAt.value,
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

function exportAuditHead() {
  if (!offBoxAnchorRecord.value) {
    toast.info(t("operations.audit.noAnchorToExport"));
    return;
  }
  downloadFile("lattice-audit-head.json", offBoxAnchorRecord.value + "\n", "application/json");
  toast.success(t("operations.audit.anchorExported"));
}

// Export the currently-filtered events (what the operator is looking at). Honest
// scope: this exports the loaded page, not the whole store — the count is shown.
function downloadFile(filename: string, content: string, mime: string) {
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

function exportNdjson() {
  if (events.value.length === 0) {
    toast.info(t("operations.audit.exportEmpty"));
    return;
  }
  downloadFile(
    "lattice-audit.ndjson",
    events.value.map((e) => JSON.stringify(e)).join("\n"),
    "application/x-ndjson",
  );
  toast.success(t("operations.audit.exported", { count: events.value.length }));
}

function csvCell(value: unknown): string {
  const s = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  if (events.value.length === 0) {
    toast.info(t("operations.audit.exportEmpty"));
    return;
  }
  const headers = ["at", "decision", "action", "scope", "actor_id", "token_id", "node_id", "correlation_id", "reason", "metadata"];
  const rows = events.value.map((e) =>
    [e.at, e.decision, e.action, e.scope, e.actor_id, e.token_id, e.node_id, e.correlation_id, e.reason, e.metadata]
      .map(csvCell)
      .join(","),
  );
  downloadFile("lattice-audit.csv", [headers.join(","), ...rows].join("\n"), "text/csv");
  toast.success(t("operations.audit.exported", { count: events.value.length }));
}

// Mirror the full filter + page state into the URL so a query is shareable.
function syncUrl() {
  const query: Record<string, string> = {};
  if (q.value.trim()) query.q = q.value.trim();
  if (action.value.trim()) query.action = action.value.trim();
  if (decision.value !== "any") query.decision = decision.value;
  if (nodeId.value.trim()) query.node_id = nodeId.value.trim();
  if (correlationId.value.trim()) query.correlation_id = correlationId.value.trim();
  if (timeRange.value !== "all") query.range = timeRange.value;
  if (pageSize.value !== 50) query.limit = String(pageSize.value);
  if (offset.value > 0) query.offset = String(offset.value);
  router.replace({ query }).catch(() => {});
}

// Apply the current filters from page one (form submit / search / chip clear).
function applyFilters() {
  offset.value = 0;
  syncUrl();
  auditQuery.refresh();
}

const rangeStart = computed(() => (events.value.length ? offset.value + 1 : 0));
const rangeEnd = computed(() => offset.value + events.value.length);
const hasPrev = computed(() => offset.value > 0);
const hasNext = computed(() => rangeEnd.value < total.value);

function nextPage() {
  if (!hasNext.value) return;
  offset.value += pageSize.value;
  syncUrl();
  auditQuery.refresh();
}
function prevPage() {
  if (!hasPrev.value) return;
  offset.value = Math.max(0, offset.value - pageSize.value);
  syncUrl();
  auditQuery.refresh();
}

// Removable active-filter chips: at-a-glance clarity + one-click clearing.
const activeFilters = computed(() => {
  const f: { key: string; label: string }[] = [];
  if (q.value.trim()) f.push({ key: "q", label: `${t("operations.audit.search")}: ${q.value.trim()}` });
  if (action.value.trim()) f.push({ key: "action", label: `${t("operations.audit.action")}: ${action.value.trim()}` });
  if (decision.value !== "any") f.push({ key: "decision", label: `${t("operations.audit.decision")}: ${decision.value}` });
  if (nodeId.value.trim()) f.push({ key: "node_id", label: `${t("operations.audit.node")}: ${nodeId.value.trim()}` });
  if (correlationId.value.trim())
    f.push({ key: "correlation_id", label: `${t("operations.audit.correlation")}: ${correlationId.value.trim()}` });
  if (timeRange.value !== "all") f.push({ key: "range", label: `${t("operations.audit.timeRange")}: ${timeRange.value}` });
  return f;
});

function clearFilter(key: string) {
  switch (key) {
    case "q":
      q.value = "";
      break;
    case "action":
      action.value = "";
      break;
    case "decision":
      decision.value = "any";
      break;
    case "node_id":
      nodeId.value = "";
      break;
    case "correlation_id":
      correlationId.value = "";
      break;
    case "range":
      timeRange.value = "all";
      break;
  }
  applyFilters();
}

function clearAllFilters() {
  q.value = "";
  action.value = "";
  decision.value = "any";
  nodeId.value = "";
  correlationId.value = "";
  timeRange.value = "all";
  applyFilters();
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('operations.audit.title')" :description="$t('operations.audit.description')">
      <template #status>
        <FreshnessLabel :last-updated="auditQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="events.length === 0" @click="exportCsv">
          <Download class="size-4" aria-hidden="true" />
          {{ $t('operations.audit.exportCsv') }}
        </Button>
        <Button variant="outline" size="sm" :disabled="events.length === 0" @click="exportNdjson">
          <Download class="size-4" aria-hidden="true" />
          {{ $t('operations.audit.exportNdjson') }}
        </Button>
        <Button variant="outline" size="sm" :disabled="auditQuery.refreshing.value" @click="auditQuery.refresh">
          <RefreshCw :class="cn('size-4', auditQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.audit.returned') }}</p>
            <p class="text-2xl font-semibold">{{ events.length }}</p>
          </div>
          <ScrollText class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.audit.totalMatch') }}</p>
            <p class="text-2xl font-semibold">{{ total }}</p>
          </div>
          <ShieldCheck class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.audit.chain') }}</p>
            <p class="text-2xl font-semibold" :class="verifyResult?.ok === false ? 'text-destructive' : 'text-success'">
              {{ verifyResult ? (verifyResult.ok ? $t('operations.audit.chainOk') : $t('operations.audit.chainBad')) : "—" }}
            </p>
          </div>
          <CheckCircle2 class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>{{ $t('operations.audit.filters') }}</CardTitle>
        <CardDescription>{{ $t('operations.audit.filtersHint') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <div class="relative mb-3">
          <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            v-model="q"
            class="pl-8"
            :placeholder="$t('operations.audit.searchPlaceholder')"
            @keyup.enter="applyFilters"
          />
        </div>
        <form class="grid gap-3 lg:grid-cols-[1fr_140px_150px_1fr_1fr_100px_auto_auto]" @submit.prevent="applyFilters">
          <div class="grid gap-2">
            <Label for="audit-action">{{ $t('operations.audit.action') }}</Label>
            <Input id="audit-action" v-model="action" placeholder="task.*" />
          </div>
          <div class="grid gap-2">
            <Label for="audit-range">{{ $t('operations.audit.timeRange') }}</Label>
            <Select v-model="timeRange">
              <SelectTrigger id="audit-range" class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ $t('operations.audit.rangeAll') }}</SelectItem>
                <SelectItem value="15m">{{ $t('operations.audit.range15m') }}</SelectItem>
                <SelectItem value="1h">{{ $t('operations.audit.range1h') }}</SelectItem>
                <SelectItem value="24h">{{ $t('operations.audit.range24h') }}</SelectItem>
                <SelectItem value="7d">{{ $t('operations.audit.range7d') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-2">
            <Label for="audit-decision">{{ $t('operations.audit.decision') }}</Label>
            <Select v-model="decision">
              <SelectTrigger id="audit-decision" class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">{{ $t('operations.audit.any') }}</SelectItem>
                <SelectItem value="allow">allow</SelectItem>
                <SelectItem value="deny">deny</SelectItem>
                <SelectItem value="observe">observe</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-2">
            <Label for="audit-node">{{ $t('operations.audit.node') }}</Label>
            <Input id="audit-node" v-model="nodeId" :placeholder="$t('operations.audit.nodePlaceholder')" />
          </div>
          <div class="grid gap-2">
            <Label for="audit-correlation">{{ $t('operations.audit.correlation') }}</Label>
            <Input id="audit-correlation" v-model="correlationId" placeholder="req_..." />
          </div>
          <div class="grid gap-2">
            <Label for="audit-limit">{{ $t('operations.audit.limit') }}</Label>
            <Input id="audit-limit" v-model="limit" type="number" min="1" max="500" />
          </div>
          <div class="flex items-end">
            <Button type="submit">
              <RefreshCw class="size-4" aria-hidden="true" />
              {{ $t('operations.audit.query') }}
            </Button>
          </div>
          <div class="flex items-end">
            <Button type="button" variant="outline" :disabled="verifyPending" @click="verifyAudit">
              <RefreshCw v-if="verifyPending" class="size-4 animate-spin" aria-hidden="true" />
              <ShieldCheck v-else class="size-4" aria-hidden="true" />
              {{ $t('common.actions.verify') }}
            </Button>
          </div>
        </form>

        <div v-if="activeFilters.length" class="mt-3 flex flex-wrap items-center gap-2">
          <span class="text-xs text-muted-foreground">{{ $t('operations.audit.activeFilters') }}</span>
          <button
            v-for="f in activeFilters"
            :key="f.key"
            type="button"
            class="surface-interactive inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs"
            @click="clearFilter(f.key)"
          >
            {{ f.label }}
            <X class="size-3" aria-hidden="true" />
          </button>
          <Button variant="ghost" size="sm" @click="clearAllFilters">{{ $t('operations.audit.clearAll') }}</Button>
        </div>

        <div v-if="verifyResult" class="mt-4 space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <Badge v-if="!verifyResult.enabled" variant="secondary">{{ $t('operations.audit.chainDisabled') }}</Badge>
            <Badge v-else :variant="verifyResult.ok ? 'success' : 'destructive'">
              {{ verifyResult.ok ? $t('operations.audit.chainOkBadge') : $t('operations.audit.chainFailedBadge') }}
            </Badge>
            <Badge v-if="verifyResult.enabled" :variant="verifyResult.anchored ? 'success' : 'warning'">
              {{ verifyResult.anchored ? $t('operations.audit.anchoredBadge') : $t('operations.audit.unanchoredBadge') }}
            </Badge>
            <span v-if="verifyResult.enabled">{{ $t('operations.audit.eventsCount', { count: verifyResult.count ?? 0 }) }}</span>
            <span v-if="verifyCheckedAt" class="text-xs text-muted-foreground">
              {{ $t('operations.audit.verifiedAt', { time: formatDateTime(verifyCheckedAt) }) }}
            </span>
          </div>
          <p v-if="verifyResult.error" class="text-sm text-destructive">{{ verifyResult.error }}</p>
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
            <p v-if="verifyResult.anchor_pending" class="text-warning">
              {{ $t('operations.audit.anchorPending', { count: verifyResult.anchor_pending.count }) }}
            </p>
          </div>
          <div v-if="offBoxAnchorRecord" class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="text-sm font-medium">{{ $t('operations.audit.offboxAnchor') }}</p>
                <p class="text-xs text-muted-foreground">{{ $t('operations.audit.offboxAnchorHint') }}</p>
              </div>
              <div class="flex items-center gap-2">
                <CopyButton :value="offBoxAnchorRecord" :label="$t('operations.audit.copyOffboxAnchor')" />
                <Button type="button" variant="outline" size="sm" @click="exportAuditHead">
                  <Download class="size-4" aria-hidden="true" />
                  {{ $t('operations.audit.downloadOffboxAnchor') }}
                </Button>
              </div>
            </div>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/80 p-3 font-mono text-xs">{{ offBoxAnchorRecord }}</pre>
          </div>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>{{ $t('operations.audit.events') }}</CardTitle>
        <CardDescription>{{ $t('operations.audit.eventsHint') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="events"
          :row-key="(event) => event.id"
          :loading="auditQuery.loading.value"
          :error="auditQuery.error.value"
          :page-size="pageSize"
          :empty-title="$t('operations.audit.emptyTitle')"
          :empty-description="$t('operations.audit.emptyDescription')"
          :no-match-title="$t('operations.audit.noMatchTitle')"
          :no-match-description="$t('operations.audit.noMatchDescription')"
          :actions-label="$t('operations.audit.colId')"
          @retry="auditQuery.refresh"
        >
          <template #cell-decision="{ row }">
            <Badge :variant="decisionVariant(row.decision)">{{ row.decision }}</Badge>
          </template>

          <template #cell-action="{ row }">
            <div class="flex flex-wrap items-center justify-end gap-2 md:justify-start">
              <span class="font-medium">{{ row.action }}</span>
              <Badge v-if="row.scope" variant="outline">{{ row.scope }}</Badge>
            </div>
            <p class="mt-1 text-xs text-muted-foreground">
              {{ $t('operations.audit.actorPrefix') }} {{ row.actor_id || "system" }} · {{ $t('operations.audit.nodePrefix') }} {{ row.node_id || $t('common.misc.global') }}
            </p>
            <div v-if="row.reason || row.correlation_id" class="mt-2 flex flex-wrap justify-end gap-2 text-xs text-muted-foreground md:justify-start">
              <span v-if="row.reason">{{ row.reason }}</span>
              <span v-if="row.correlation_id" class="font-mono">{{ $t('operations.audit.corrPrefix') }} {{ row.correlation_id }}</span>
            </div>
            <pre v-if="metadataText(row)" class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-left font-mono text-xs">{{ metadataText(row) }}</pre>
          </template>

          <template #cell-at="{ row }">
            <span class="text-xs text-muted-foreground">{{ formatDateTime(row.at) }}</span>
          </template>

          <template #cell-id="{ row }">
            <div class="flex items-center justify-end gap-2">
              <code class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 12) }}</code>
              <CopyButton :value="row.id" />
            </div>
          </template>
        </DataTable>

        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span class="text-muted-foreground">
            {{ $t('operations.audit.showingRange', { from: rangeStart, to: rangeEnd, total }) }}
          </span>
          <div class="flex items-center gap-2">
            <Button variant="outline" size="sm" :disabled="!hasPrev || auditQuery.loading.value" @click="prevPage">
              <ChevronLeft class="size-4" aria-hidden="true" />
              {{ $t('operations.audit.prev') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="!hasNext || auditQuery.loading.value" @click="nextPage">
              {{ $t('operations.audit.next') }}
              <ChevronRight class="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
