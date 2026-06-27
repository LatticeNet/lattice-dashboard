<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { CheckCircle2, Download, RefreshCw, ScrollText, Search, ShieldCheck } from "lucide-vue-next";
import { api, type AuditEvent } from "@/lib/api";
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
const action = ref("");
/** "any" is a sentinel for the themed Select (reka-ui forbids empty-string item values). */
const decision = ref<"any" | "allow" | "deny" | "observe">("any");
const nodeId = ref("");
const correlationId = ref("");
const q = ref("");
const timeRange = ref<"all" | "15m" | "1h" | "24h" | "7d">("all");
const limit = ref(50);

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
const verifyResult = ref<{ enabled: boolean; ok: boolean; count: number; head?: string } | undefined>();

const auditQuery = useAsyncData(
  () =>
    api.audit.query({
      action: action.value.trim() || undefined,
      decision: decision.value === "any" ? undefined : decision.value,
      node_id: nodeId.value.trim() || undefined,
      correlation_id: correlationId.value.trim() || undefined,
      q: q.value.trim() || undefined,
      at_from: rangeFrom(),
      limit: Number(limit.value) || 50,
      offset: 0,
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
    toast.success(verifyResult.value.ok ? t("operations.audit.toastVerified") : t("operations.audit.toastVerifyFailed"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.audit.toastVerifyFailed"));
  } finally {
    verifyPending.value = false;
  }
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
            @keyup.enter="auditQuery.refresh"
          />
        </div>
        <form class="grid gap-3 lg:grid-cols-[1fr_140px_150px_1fr_1fr_100px_auto_auto]" @submit.prevent="auditQuery.refresh">
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

        <div v-if="verifyResult" class="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <Badge :variant="verifyResult.ok ? 'success' : 'destructive'">
              {{ verifyResult.ok ? $t('operations.audit.chainOkBadge') : $t('operations.audit.chainFailedBadge') }}
            </Badge>
            <span>{{ $t('operations.audit.eventsCount', { count: verifyResult.count }) }}</span>
            <code v-if="verifyResult.head" class="break-all font-mono text-xs text-muted-foreground">{{ verifyResult.head }}</code>
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
          :page-size="20"
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
      </CardContent>
    </Card>
  </div>
</template>
