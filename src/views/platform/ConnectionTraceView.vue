<script setup lang="ts">
/**
 * Connection Trace: the screen an operator opens to answer "why did this
 * user's connection fail, stall, or leave by the wrong exit".
 *
 * The row is one sing-box connection. Three rules drive the whole layout:
 * a byte count nobody sampled is never printed as zero, a close reason nobody
 * recorded never reads as a clean close, and a hop path this console inferred
 * says so in words before it shows anything.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useRoute, useRouter } from "vue-router";
import {
  Activity,
  CircleSlash,
  Play,
  RefreshCw,
  Radio,
  Search,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-vue-next";

import {
  api,
  unwrap,
  type ConnRecord,
  type HopPath,
  type Node,
  type TraceLevel,
  type TraceLine,
  type TracePolicy,
  type TraceSession,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useRouteTab } from "@/composables/useRouteTab";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import NodePicker from "@/components/common/NodePicker.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import {
  CLOSE_REASONS,
  TRACE_RANGES,
  TRACE_TTL_DEFAULT_SECONDS,
  TRACE_TTL_MAX_SECONDS,
  USER_KINDS,
  activeFilterCount,
  appendConnPage,
  clampTraceTtlSeconds,
  connCloseCell,
  connRecordKey,
  connTraceFiltersEqual,
  connectionsRequestParams,
  destinationText,
  emptyConnTracePaging,
  hopConfidenceDisplay,
  isStalled,
  readConnTraceFilters,
  traceBytesCell,
  traceBytesCoverage,
  traceDurationCell,
  userCellDisplay,
  writeConnTraceFilters,
  type ConnTraceFilters,
  type ConnTracePaging,
  type TraceRange,
} from "./connTraceModel";

const PAGE_LIMIT = 200;
const TAIL_POLL_MS = 2000;
const TAIL_LINE_CAP = 2000;
const TRACE_LEVELS: readonly TraceLevel[] = ["info", "debug", "trace"];
/** Sentinel for "no constraint" in a Select, which cannot hold an empty value. */
const ANY = "any";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const canRead = computed(() => auth.can("log:read"));
const canAdmin = computed(() => auth.can("log:admin"));
const canReadUsers = computed(() => auth.can("user:admin"));
const canReadNodes = computed(() => auth.can("node:read"));

/** Why a write control is locked, or undefined when it is not. */
const adminReason = computed(() =>
  canAdmin.value ? undefined : t("platform.trace.needsAdmin", { scope: "log:admin" }),
);

const tab = useRouteTab<"connections" | "sessions" | "policy">(
  () => ["connections", "sessions", "policy"],
  () => "connections",
);

/* ------------------------------------------------------------------ */
/* Reference data                                                      */
/* ------------------------------------------------------------------ */

const nodesQuery = useAsyncData(
  () =>
    canReadNodes.value
      ? api.nodes.list().then((r) => unwrap(r, "nodes"))
      : Promise.resolve([] as Node[]),
  { immediate: canReadNodes.value },
);
const nodes = computed(() => nodesQuery.data.value ?? []);

function nodeLabel(id: string): string {
  if (!id) return "";
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 12);
}

/**
 * Lattice user id to display name, when the operator can read the directory.
 * Without `user:admin` a managed row shows the `u_<hex>` name sing-box logged
 * instead, which is real evidence; the uuid is never shown as a user.
 */
const usersQuery = useAsyncData(
  () =>
    canReadUsers.value
      ? api.users.list().then((r) => unwrap(r, "users"))
      : Promise.resolve([]),
  { immediate: canReadUsers.value },
);
const userNames = computed(() => {
  const map = new Map<string, string>();
  for (const user of usersQuery.data.value ?? []) map.set(user.id, user.username);
  return map;
});

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

function cloneFilters(filters: ConnTraceFilters): ConnTraceFilters {
  return {
    ...filters,
    closeReasons: [...filters.closeReasons],
    userKinds: [...filters.userKinds],
  };
}

/** What the list is actually showing. The URL is the single source of truth. */
const applied = computed(() => readConnTraceFilters(route.query));
/** What the filter bar is editing. Text fields commit on Apply, controls commit at once. */
const draft = ref<ConnTraceFilters>(cloneFilters(applied.value));

watch(applied, (next) => {
  if (!connTraceFiltersEqual(next, draft.value)) draft.value = cloneFilters(next);
});

function applyFilters(): void {
  const query = writeConnTraceFilters(route.query, draft.value);
  router.replace({ query }).catch(() => {});
}

function resetFilters(): void {
  draft.value = cloneFilters(readConnTraceFilters({}));
  applyFilters();
}

function toggleCloseReason(reason: string): void {
  const set = new Set(draft.value.closeReasons);
  if (set.has(reason)) set.delete(reason);
  else set.add(reason);
  draft.value.closeReasons = CLOSE_REASONS.filter((value) => set.has(value));
  applyFilters();
}

function toggleUserKind(kind: string): void {
  const set = new Set(draft.value.userKinds);
  if (set.has(kind)) set.delete(kind);
  else set.add(kind);
  draft.value.userKinds = USER_KINDS.filter((value) => set.has(value));
  applyFilters();
}

function setRange(value: string): void {
  draft.value.range = value as TraceRange;
  applyFilters();
}

function setSessionFilter(value: string): void {
  draft.value.sessionId = value === ANY ? "" : value;
  applyFilters();
}

function setNodeFilter(value: string): void {
  draft.value.nodeId = value;
  applyFilters();
}

/** datetime-local speaks local wall time; the filter state speaks ISO. */
function toLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string {
  if (!value) return "";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

const activeFilters = computed(() => activeFilterCount(applied.value));

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

const paging = ref<ConnTracePaging>(emptyConnTracePaging());
const loadedOnce = ref(false);
const loadingConnections = ref(false);
const loadingOlder = ref(false);
const connectionsError = ref<Error | null>(null);
let connectionsController: AbortController | undefined;

const records = computed(() => paging.value.records);
const coverage = computed(() => traceBytesCoverage(records.value));

interface ConnRowView {
  user: ReturnType<typeof userCellDisplay>;
  close: ReturnType<typeof connCloseCell>;
  upload: ReturnType<typeof traceBytesCell>;
  download: ReturnType<typeof traceBytesCell>;
  duration: ReturnType<typeof traceDurationCell>;
  destination: string;
  node: string;
  stalled: boolean;
}

function buildRowView(row: ConnRecord): ConnRowView {
  return {
    user: userCellDisplay(row, userNames.value),
    close: connCloseCell(row),
    upload: traceBytesCell(row.upload, row.bytes_known),
    download: traceBytesCell(row.download, row.bytes_known),
    duration: traceDurationCell(row.duration_ms),
    destination: destinationText(row),
    node: nodeLabel(row.node_id),
    stalled: isStalled(row),
  };
}

/**
 * One derived view per row, rebuilt when the data changes rather than once per
 * cell per render. Ten columns each calling the same mappers turns a 200 row
 * page into thousands of throwaway objects on every keystroke in the search
 * box, and the search box is debounced precisely because it re-renders.
 */
const rowViews = computed(() => {
  const map = new Map<string, ConnRowView>();
  for (const row of records.value) map.set(connRecordKey(row), buildRowView(row));
  return map;
});

function rowView(row: ConnRecord): ConnRowView {
  return rowViews.value.get(connRecordKey(row)) ?? buildRowView(row);
}

/**
 * There is no background poll here on purpose. The list accumulates older
 * keyset pages as the operator walks back through them, and a poll that reset
 * to the newest page would throw that walk away mid-investigation. Refresh is
 * a button; the live capture that does need to move on its own is the session
 * tail below.
 */
async function loadNewest(): Promise<void> {
  if (!canRead.value) return;
  connectionsController?.abort();
  const controller = new AbortController();
  connectionsController = controller;
  loadingConnections.value = true;
  connectionsError.value = null;
  try {
    const res = await api.trace.connections(
      connectionsRequestParams(applied.value, { limit: PAGE_LIMIT, nowMs: Date.now() }),
      { signal: controller.signal },
    );
    paging.value = appendConnPage(emptyConnTracePaging(), res);
    loadedOnce.value = true;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") return;
    connectionsError.value = error as Error;
  } finally {
    if (connectionsController === controller) loadingConnections.value = false;
  }
}

async function loadOlder(): Promise<void> {
  if (!canRead.value || !paging.value.cursor || loadingOlder.value) return;
  const cursor = paging.value.cursor;
  loadingOlder.value = true;
  try {
    const res = await api.trace.connections(
      connectionsRequestParams(applied.value, {
        limit: PAGE_LIMIT,
        cursor,
        nowMs: Date.now(),
      }),
    );
    // A reload may have landed while this page was in flight; appending to the
    // list it replaced would splice an old window into a new one.
    if (paging.value.cursor !== cursor) return;
    paging.value = appendConnPage(paging.value, res);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.loadOlderFailed"));
  } finally {
    loadingOlder.value = false;
  }
}

let lastLoaded: ConnTraceFilters | null = null;
watch(
  applied,
  (next) => {
    if (lastLoaded && connTraceFiltersEqual(lastLoaded, next)) return;
    lastLoaded = cloneFilters(next);
    void loadNewest();
  },
  { immediate: canRead.value },
);

const connectionColumns = computed<DataTableColumn<ConnRecord>[]>(() => [
  {
    key: "started_at",
    label: t("platform.trace.colStarted"),
    sortable: true,
    class: "whitespace-nowrap",
  },
  {
    key: "user",
    label: t("platform.trace.colUser"),
    sortable: true,
    searchable: true,
    value: (row) => userCellDisplay(row, userNames.value).primary,
  },
  {
    key: "node_id",
    label: t("platform.trace.colNode"),
    sortable: true,
    searchable: true,
    value: (row) => nodeLabel(row.node_id),
  },
  { key: "line_uuid", label: t("platform.trace.colLine"), sortable: true },
  {
    key: "destination",
    label: t("platform.trace.colDestination"),
    sortable: true,
    searchable: true,
    value: (row) => destinationText(row),
  },
  {
    key: "outbound_tag",
    label: t("platform.trace.colOutbound"),
    sortable: true,
    searchable: true,
  },
  {
    key: "duration_ms",
    label: t("platform.trace.colDuration"),
    align: "right",
    sortable: true,
    value: (row) => row.duration_ms ?? -1,
  },
  {
    key: "upload",
    label: t("platform.trace.colUpload"),
    align: "right",
    sortable: true,
    // An unsampled counter sorts below a measured zero rather than with it.
    value: (row) => (row.bytes_known ? (row.upload ?? 0) : -1),
  },
  {
    key: "download",
    label: t("platform.trace.colDownload"),
    align: "right",
    sortable: true,
    value: (row) => (row.bytes_known ? (row.download ?? 0) : -1),
  },
  {
    key: "close_reason",
    label: t("platform.trace.colClose"),
    sortable: true,
    value: (row) => connCloseCell(row).id,
  },
]);

/* ------------------------------------------------------------------ */
/* Detail panel                                                        */
/* ------------------------------------------------------------------ */

const selected = ref<ConnRecord | null>(null);
const hopPath = ref<HopPath | null>(null);
const hopRecords = ref<ConnRecord[]>([]);
const hopError = ref<Error | null>(null);
const hopLoading = ref(false);

const recordLines = ref<TraceLine[]>([]);
const recordLinesLoading = ref(false);
const recordLinesError = ref<Error | null>(null);

const selectedClose = computed(() => (selected.value ? connCloseCell(selected.value) : null));
const selectedUser = computed(() =>
  selected.value ? userCellDisplay(selected.value, userNames.value) : null,
);
const hopConfidence = computed(() => hopConfidenceDisplay(hopPath.value?.confidence));

function openRecord(row: ConnRecord): void {
  selected.value = row;
  hopPath.value = null;
  hopRecords.value = [];
  hopError.value = null;
  recordLines.value = [];
  recordLinesError.value = null;
  void loadHops(row);
  void loadRecordLines(row);
}

function closeRecord(): void {
  selected.value = null;
}

async function loadHops(row: ConnRecord): Promise<void> {
  hopLoading.value = true;
  try {
    const res = await api.trace.hops({
      node_id: row.node_id,
      core_generation: row.core_generation ?? 0,
      log_id: row.log_id,
    });
    hopPath.value = res.path ?? null;
    hopRecords.value = res.records ?? [];
  } catch (error) {
    hopError.value = error as Error;
  } finally {
    hopLoading.value = false;
  }
}

/**
 * The lines endpoint is session-scoped, not connection-scoped, so the lines
 * for one connection are found by asking each session that captured it and
 * keeping the lines carrying this node and this log id. When a capture kept
 * nothing for the connection the panel says so rather than showing an empty
 * box that reads like a quiet node.
 */
async function loadRecordLines(row: ConnRecord): Promise<void> {
  const sessionIds = row.session_ids ?? [];
  if (sessionIds.length === 0) return;
  recordLinesLoading.value = true;
  try {
    const pages = await Promise.all(
      sessionIds.map((id) => api.trace.lines({ session_id: id, limit: 1000 })),
    );
    const lines = pages
      .flatMap((page) => page.lines ?? [])
      .filter((line) => line.node_id === row.node_id && line.log_id === row.log_id)
      .sort((a, b) => a.seq - b.seq);
    recordLines.value = lines;
  } catch (error) {
    recordLinesError.value = error as Error;
  } finally {
    recordLinesLoading.value = false;
  }
}

function hopRecordFor(key: { node_id: string; core_generation: number; log_id: number }): ConnRecord | undefined {
  return hopRecords.value.find(
    (record) =>
      record.node_id === key.node_id &&
      (record.core_generation ?? 0) === key.core_generation &&
      record.log_id === key.log_id,
  );
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

const sessionsQuery = useAsyncData(
  (signal) =>
    canRead.value
      ? api.trace.sessions({ signal }).then((r) => r.sessions ?? [])
      : Promise.resolve([] as TraceSession[]),
  { pollInterval: 10000, immediate: canRead.value },
);
const sessions = computed(() => sessionsQuery.data.value ?? []);
const runningSessions = computed(() => sessions.value.filter((s) => s.state === "running"));

const sessionForm = ref({
  name: "",
  level: "info" as TraceLevel,
  ttlSeconds: TRACE_TTL_DEFAULT_SECONDS,
  nodeId: "",
  userId: "",
  lineUuid: "",
  dst: "",
});
const startingSession = ref(false);
const stoppingId = ref("");

function prefillSessionFromFilters(): void {
  sessionForm.value.nodeId = applied.value.nodeId;
  sessionForm.value.userId = applied.value.userId;
  sessionForm.value.lineUuid = applied.value.lineUuid;
  sessionForm.value.dst = applied.value.dst;
}

async function startSession(): Promise<void> {
  if (!canAdmin.value || startingSession.value) return;
  const name = sessionForm.value.name.trim();
  if (!name) return;
  startingSession.value = true;
  try {
    const created = await api.trace.startSession({
      name,
      level: sessionForm.value.level,
      ttl_seconds: clampTraceTtlSeconds(sessionForm.value.ttlSeconds),
      filter: {
        node_ids: sessionForm.value.nodeId ? [sessionForm.value.nodeId] : undefined,
        user_ids: sessionForm.value.userId ? [sessionForm.value.userId.trim()] : undefined,
        line_uuids: sessionForm.value.lineUuid ? [sessionForm.value.lineUuid.trim()] : undefined,
        dst_patterns: sessionForm.value.dst ? [sessionForm.value.dst.trim()] : undefined,
      },
    });
    toast.success(t("platform.trace.sessionStarted", { name: created.name || created.id }));
    sessionForm.value.name = "";
    sessionsQuery.refresh();
    startTail(created.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.sessionStartFailed"));
  } finally {
    startingSession.value = false;
  }
}

async function stopSession(session: TraceSession): Promise<void> {
  if (!canAdmin.value || stoppingId.value) return;
  stoppingId.value = session.id;
  try {
    await api.trace.stopSession(session.id);
    toast.success(t("platform.trace.sessionStopped", { name: session.name || session.id }));
    if (tailSessionId.value === session.id) stopTail();
    sessionsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.sessionStopFailed"));
  } finally {
    stoppingId.value = "";
  }
}

/* Live tail -------------------------------------------------------- */

const tailSessionId = ref("");
const tailLines = ref<TraceLine[]>([]);
const tailSeq = ref(0);
const tailError = ref<Error | null>(null);
let tailTimer: ReturnType<typeof setInterval> | undefined;
let tailController: AbortController | undefined;
let tailInFlight = false;

const tailSession = computed(() => sessions.value.find((s) => s.id === tailSessionId.value));

/**
 * One tail poll.
 *
 * The AbortSignal is not optional here. The API client keeps a 750ms cache
 * keyed on the request path and serves it to any GET that arrives without a
 * signal, so a two second poll would be handed the same page it already had
 * and a running capture would look like a network with nothing on it. Passing
 * a signal takes the request past that cache.
 */
async function tailOnce(): Promise<void> {
  if (!tailSessionId.value || tailInFlight) return;
  tailInFlight = true;
  tailController?.abort();
  const controller = new AbortController();
  tailController = controller;
  try {
    const res = await api.trace.lines(
      { session_id: tailSessionId.value, after_seq: tailSeq.value, limit: 500 },
      { signal: controller.signal },
    );
    const lines = res.lines ?? [];
    if (lines.length > 0) {
      const merged = [...tailLines.value, ...lines];
      tailLines.value = merged.length > TAIL_LINE_CAP ? merged.slice(-TAIL_LINE_CAP) : merged;
    }
    const highest = lines.reduce((max, line) => Math.max(max, line.seq), tailSeq.value);
    tailSeq.value = res.next_seq ?? highest;
    tailError.value = null;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") return;
    tailError.value = error as Error;
  } finally {
    tailInFlight = false;
  }
}

function startTail(sessionId: string): void {
  stopTail();
  tailSessionId.value = sessionId;
  tailLines.value = [];
  tailSeq.value = 0;
  tailError.value = null;
  void tailOnce();
  tailTimer = setInterval(() => void tailOnce(), TAIL_POLL_MS);
}

function stopTail(): void {
  if (tailTimer) clearInterval(tailTimer);
  tailTimer = undefined;
  tailController?.abort();
  tailController = undefined;
  tailInFlight = false;
  tailSessionId.value = "";
}

/* ------------------------------------------------------------------ */
/* Collection policy                                                   */
/* ------------------------------------------------------------------ */

interface PolicyDraft {
  enabled: boolean;
  level: TraceLevel;
  budget: number;
}

const policyQuery = useAsyncData(
  (signal) =>
    canRead.value
      ? api.trace.policy(undefined, { signal }).then((r) => r.policies ?? [])
      : Promise.resolve([] as TracePolicy[]),
  { pollInterval: 30000, immediate: canRead.value },
);
const policies = computed(() => policyQuery.data.value ?? []);
const policyDrafts = ref<Record<string, PolicyDraft>>({});
const savingPolicyNode = ref("");

watch(
  policies,
  (rows) => {
    const next = { ...policyDrafts.value };
    for (const row of rows) {
      if (next[row.node_id]) continue;
      next[row.node_id] = {
        enabled: row.enabled,
        level: row.level,
        budget: row.budget_lines_per_sec,
      };
    }
    policyDrafts.value = next;
  },
  { immediate: true },
);

function policyDraft(row: TracePolicy): PolicyDraft {
  return (
    policyDrafts.value[row.node_id] ?? {
      enabled: row.enabled,
      level: row.level,
      budget: row.budget_lines_per_sec,
    }
  );
}

function policyDirty(row: TracePolicy): boolean {
  const draftRow = policyDraft(row);
  return (
    draftRow.enabled !== row.enabled ||
    draftRow.level !== row.level ||
    Number(draftRow.budget) !== row.budget_lines_per_sec
  );
}

function setPolicyField<K extends keyof PolicyDraft>(
  row: TracePolicy,
  key: K,
  value: PolicyDraft[K],
): void {
  const current = policyDraft(row);
  policyDrafts.value = {
    ...policyDrafts.value,
    [row.node_id]: { ...current, [key]: value },
  };
}

async function savePolicy(row: TracePolicy): Promise<void> {
  if (!canAdmin.value || savingPolicyNode.value) return;
  const draftRow = policyDraft(row);
  savingPolicyNode.value = row.node_id;
  try {
    await api.trace.setPolicy({
      node_id: row.node_id,
      enabled: draftRow.enabled,
      level: draftRow.level,
      budget_lines_per_sec: Math.max(0, Math.floor(Number(draftRow.budget) || 0)),
    });
    toast.success(t("platform.trace.policySaved", { node: nodeLabel(row.node_id) }));
    policyQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.policySaveFailed"));
  } finally {
    savingPolicyNode.value = "";
  }
}

/* ------------------------------------------------------------------ */

function refreshAll(): void {
  if (!canRead.value) return;
  void loadNewest();
  sessionsQuery.refresh();
  policyQuery.refresh();
}

onBeforeUnmount(() => {
  stopTail();
  connectionsController?.abort();
  nodesQuery.stop();
  usersQuery.stop();
  sessionsQuery.stop();
  policyQuery.stop();
});
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('platform.trace.title')" :description="$t('platform.trace.description')">
      <template #actions>
        <Button
          v-if="canRead"
          variant="outline"
          size="sm"
          :disabled="loadingConnections"
          @click="refreshAll"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', loadingConnections && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Permission denied: one quiet panel, no half-working controls. -->
    <Card v-if="!canRead">
      <CardContent class="p-6">
        <EmptyState
          :icon="CircleSlash"
          :title="$t('platform.trace.scopeRequiredTitle')"
          :description="$t('platform.trace.scopeRequiredDescription', { scope: 'log:read' })"
        />
      </CardContent>
    </Card>

    <Tabs v-else v-model="tab">
      <TabsList class="w-full sm:w-auto">
        <TabsTrigger value="connections">{{ $t('platform.trace.tabConnections') }}</TabsTrigger>
        <TabsTrigger value="sessions">{{ $t('platform.trace.tabSessions') }}</TabsTrigger>
        <TabsTrigger value="policy">{{ $t('platform.trace.tabPolicy') }}</TabsTrigger>
      </TabsList>

      <!-- ── Connections ─────────────────────────────────────────────── -->
      <TabsContent value="connections" class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <SlidersHorizontal aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.trace.filtersTitle') }}
              <Badge v-if="activeFilters > 0" variant="secondary">
                {{ $t('platform.trace.filtersActive', { count: activeFilters }) }}
              </Badge>
            </CardTitle>
            <CardDescription>{{ $t('platform.trace.filtersHint') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <form class="space-y-4" @submit.prevent="applyFilters">
              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div class="grid gap-2">
                  <Label for="trace-range">{{ $t('platform.trace.rangeLabel') }}</Label>
                  <Select :model-value="draft.range" @update:model-value="(v) => setRange(String(v))">
                    <SelectTrigger id="trace-range" class="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="value in TRACE_RANGES" :key="value" :value="value">
                        {{ $t(`platform.trace.range.${value}`) }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <template v-if="draft.range === 'custom'">
                  <div class="grid gap-2">
                    <Label for="trace-since">{{ $t('platform.trace.sinceLabel') }}</Label>
                    <Input
                      id="trace-since"
                      type="datetime-local"
                      :model-value="toLocalInput(draft.since)"
                      @update:model-value="(v) => { draft.since = fromLocalInput(String(v)); }"
                    />
                  </div>
                  <div class="grid gap-2">
                    <Label for="trace-until">{{ $t('platform.trace.untilLabel') }}</Label>
                    <Input
                      id="trace-until"
                      type="datetime-local"
                      :model-value="toLocalInput(draft.until)"
                      @update:model-value="(v) => { draft.until = fromLocalInput(String(v)); }"
                    />
                  </div>
                </template>

                <div class="grid gap-2">
                  <div class="flex items-end gap-2">
                    <NodePicker
                      id="trace-node"
                      class="min-w-0 flex-1"
                      :model-value="draft.nodeId"
                      :label="$t('platform.trace.nodeLabel')"
                      :placeholder="$t('platform.trace.anyNode')"
                      @update:model-value="setNodeFilter"
                    />
                    <Button
                      v-if="draft.nodeId"
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      :aria-label="$t('platform.trace.clearNode')"
                      @click="setNodeFilter('')"
                    >
                      <X aria-hidden="true" class="size-4" />
                    </Button>
                  </div>
                </div>

                <div class="grid gap-2">
                  <Label for="trace-user">{{ $t('platform.trace.userLabel') }}</Label>
                  <Input
                    id="trace-user"
                    v-model.trim="draft.userId"
                    class="font-mono text-xs"
                    autocomplete="off"
                    :placeholder="$t('platform.trace.userPlaceholder')"
                  />
                </div>

                <div class="grid gap-2">
                  <Label for="trace-line">{{ $t('platform.trace.lineLabel') }}</Label>
                  <Input
                    id="trace-line"
                    v-model.trim="draft.lineUuid"
                    class="font-mono text-xs"
                    autocomplete="off"
                    :placeholder="$t('platform.trace.linePlaceholder')"
                  />
                </div>

                <div class="grid gap-2">
                  <Label for="trace-dst">{{ $t('platform.trace.dstLabel') }}</Label>
                  <Input
                    id="trace-dst"
                    v-model.trim="draft.dst"
                    autocomplete="off"
                    :placeholder="$t('platform.trace.dstPlaceholder')"
                  />
                </div>

                <div class="grid gap-2">
                  <Label for="trace-session">{{ $t('platform.trace.sessionLabel') }}</Label>
                  <Select
                    :model-value="draft.sessionId || ANY"
                    @update:model-value="(v) => setSessionFilter(String(v))"
                  >
                    <SelectTrigger id="trace-session" class="w-full">
                      <SelectValue :placeholder="$t('platform.trace.anySession')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="ANY">{{ $t('platform.trace.anySession') }}</SelectItem>
                      <SelectItem v-for="session in sessions" :key="session.id" :value="session.id">
                        {{ session.name || session.id }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div class="grid gap-3 lg:grid-cols-2">
                <div class="space-y-2">
                  <p class="text-xs font-medium text-muted-foreground">{{ $t('platform.trace.closeReasonLabel') }}</p>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="reason in CLOSE_REASONS"
                      :key="reason"
                      type="button"
                      :aria-pressed="draft.closeReasons.includes(reason)"
                      :class="cn(
                        'rounded-full border px-2 py-0.5 text-xs transition-colors',
                        draft.closeReasons.includes(reason)
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )"
                      @click="toggleCloseReason(reason)"
                    >
                      {{ $t(`platform.trace.closeReason.${reason}`) }}
                    </button>
                  </div>
                </div>
                <div class="space-y-2">
                  <p class="text-xs font-medium text-muted-foreground">{{ $t('platform.trace.userKindLabel') }}</p>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="kind in USER_KINDS"
                      :key="kind"
                      type="button"
                      :aria-pressed="draft.userKinds.includes(kind)"
                      :class="cn(
                        'rounded-full border px-2 py-0.5 text-xs transition-colors',
                        draft.userKinds.includes(kind)
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )"
                      @click="toggleUserKind(kind)"
                    >
                      {{ $t(`platform.trace.userKind.${kind}`) }}
                    </button>
                  </div>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-4">
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    :model-value="draft.stalledOnly"
                    @update:model-value="(v) => { draft.stalledOnly = v === true; applyFilters(); }"
                  />
                  <span>{{ $t('platform.trace.stalledOnly') }}</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    :model-value="draft.includeOpen"
                    @update:model-value="(v) => { draft.includeOpen = v === true; applyFilters(); }"
                  />
                  <span>{{ $t('platform.trace.includeOpen') }}</span>
                </label>
                <div class="ms-auto flex items-center gap-2">
                  <Button type="button" variant="ghost" size="sm" @click="resetFilters">
                    {{ $t('platform.trace.resetFilters') }}
                  </Button>
                  <Button type="submit" variant="outline" size="sm" :disabled="loadingConnections">
                    <RefreshCw v-if="loadingConnections" aria-hidden="true" class="size-4 animate-spin" />
                    <Search v-else aria-hidden="true" class="size-4" />
                    {{ $t('platform.trace.applyFilters') }}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Activity aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.trace.resultsTitle') }}
            </CardTitle>
            <CardDescription>
              {{ $t('platform.trace.resultsHint') }}
              <span v-if="loadedOnce && records.length > 0">
                {{ $t('platform.trace.bytesCoverage', { measured: coverage.measured, total: coverage.total }) }}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <DataTable
              state-key="conn"
              :columns="connectionColumns"
              :rows="records"
              :row-key="(row) => connRecordKey(row)"
              :loading="loadingConnections && !loadedOnce"
              :error="connectionsError"
              :has-data="loadedOnce"
              :page-size="0"
              searchable
              :search-placeholder="$t('platform.trace.searchPlaceholder')"
              :empty-title="$t('platform.trace.resultsEmptyTitle')"
              :empty-description="$t('platform.trace.resultsEmptyDescription')"
              :no-match-title="$t('platform.shared.noMatchesTitle')"
              :no-match-description="$t('platform.shared.noMatchesDescription')"
              :skeleton-rows="8"
              @retry="loadNewest"
              @row-select="openRecord"
            >
              <template #cell-started_at="{ row }">
                <span class="whitespace-nowrap text-xs tabular">{{ formatDateTime(row.started_at) }}</span>
              </template>

              <template #cell-user="{ row }">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span
                    v-if="rowView(row).user.primary"
                    :class="cn('truncate', rowView(row).user.monospace && 'font-mono text-xs')"
                  >
                    {{ rowView(row).user.primary }}
                  </span>
                  <span v-else class="text-xs text-muted-foreground">{{ $t('platform.trace.userNoneLogged') }}</span>
                  <!-- Anything this console could not place gets the marker, so a
                       row never reads as a resolved user it is not. -->
                  <Badge
                    v-if="rowView(row).user.marker"
                    variant="outline"
                    class="w-fit"
                    :title="$t('platform.trace.userUnresolvedHint')"
                  >
                    {{ $t(`platform.trace.userKind.${rowView(row).user.kind}`) }}
                  </Badge>
                </div>
              </template>

              <template #cell-node_id="{ row }">
                <span class="truncate text-xs">{{ rowView(row).node }}</span>
              </template>

              <template #cell-line_uuid="{ row }">
                <span v-if="row.line_uuid" class="font-mono text-xs text-muted-foreground">
                  {{ shortId(row.line_uuid, 10) }}
                </span>
                <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
              </template>

              <template #cell-destination="{ row }">
                <div class="flex min-w-0 flex-col">
                  <span class="truncate font-mono text-xs">{{ rowView(row).destination || $t('common.misc.none') }}</span>
                  <span v-if="row.sniffed_domain && row.sniffed_domain !== row.dst_host" class="truncate text-xs text-muted-foreground">
                    {{ $t('platform.trace.sniffedAs', { domain: row.sniffed_domain }) }}
                  </span>
                </div>
              </template>

              <template #cell-outbound_tag="{ row }">
                <span v-if="row.outbound_tag" class="font-mono text-xs">{{ row.outbound_tag }}</span>
                <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
              </template>

              <template #cell-duration_ms="{ row }">
                <span v-if="rowView(row).duration.known" class="text-xs tabular">
                  {{ rowView(row).duration.text }}
                </span>
                <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
              </template>

              <!--
                The one rule this screen cannot break: bytes_known false means
                nobody measured, so the cell says so in words. A zero here would
                be read as "carried nothing", which is a different fact.
              -->
              <template #cell-upload="{ row }">
                <span v-if="rowView(row).upload.known" class="text-xs tabular">
                  {{ rowView(row).upload.text }}
                </span>
                <span
                  v-else
                  class="text-xs italic text-muted-foreground"
                  :title="$t('platform.trace.bytesNotSampledHint')"
                >
                  {{ $t('platform.trace.bytesNotSampled') }}
                </span>
              </template>

              <template #cell-download="{ row }">
                <span v-if="rowView(row).download.known" class="text-xs tabular">
                  {{ rowView(row).download.text }}
                </span>
                <span
                  v-else
                  class="text-xs italic text-muted-foreground"
                  :title="$t('platform.trace.bytesNotSampledHint')"
                >
                  {{ $t('platform.trace.bytesNotSampled') }}
                </span>
              </template>

              <template #cell-close_reason="{ row }">
                <div class="flex flex-wrap items-center gap-1">
                  <Badge
                    :variant="rowView(row).close.tone"
                    :title="rowView(row).close.certain ? undefined : $t('platform.trace.closeUnknownHint')"
                  >
                    {{ $t(`platform.trace.closeReason.${rowView(row).close.id}`) }}
                  </Badge>
                  <Badge
                    v-if="rowView(row).stalled"
                    variant="warning"
                    :title="$t('platform.trace.stalledAt', { at: formatDateTime(row.stalled_at) })"
                  >
                    {{ $t('platform.trace.stalled') }}
                  </Badge>
                </div>
              </template>
            </DataTable>

            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs text-muted-foreground">
                {{ $t('platform.trace.sortHint') }}
              </p>
              <Button
                v-if="loadedOnce && !paging.exhausted"
                variant="outline"
                size="sm"
                :disabled="loadingOlder"
                @click="loadOlder"
              >
                <RefreshCw v-if="loadingOlder" aria-hidden="true" class="size-4 animate-spin" />
                {{ $t('platform.trace.loadOlder') }}
              </Button>
              <p v-else-if="loadedOnce && records.length > 0" class="text-xs text-muted-foreground">
                {{ $t('platform.trace.allLoaded') }}
              </p>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- ── Sessions ────────────────────────────────────────────────── -->
      <TabsContent value="sessions" class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Radio aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.trace.sessionsTitle') }}
            </CardTitle>
            <CardDescription>{{ $t('platform.trace.sessionsHint') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <DataState
              :loading="sessionsQuery.loading.value"
              :error="sessionsQuery.error.value"
              :has-data="sessionsQuery.data.value !== undefined"
              :is-empty="sessions.length === 0"
              :empty-title="$t('platform.trace.sessionsEmptyTitle')"
              :empty-description="$t('platform.trace.sessionsEmptyDescription')"
              @retry="sessionsQuery.refresh"
            >
              <!-- Desktop: the dense table. -->
              <div class="hidden overflow-x-auto rounded-md border border-border md:block">
                <table class="w-full min-w-[880px] text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colSessionName') }}</th>
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colSessionState') }}</th>
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colSessionLevel') }}</th>
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colSessionExpires') }}</th>
                      <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colSessionLines') }}</th>
                      <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colSessionRecords') }}</th>
                      <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colSessionDropped') }}</th>
                      <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colSessionActions') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="session in sessions"
                      :key="session.id"
                      class="border-b border-border last:border-b-0"
                    >
                      <td class="px-3 py-2">
                        <span class="font-medium">{{ session.name || session.id }}</span>
                        <span class="ms-2 font-mono text-xs text-muted-foreground">{{ shortId(session.id, 10) }}</span>
                      </td>
                      <td class="px-3 py-2">
                        <Badge :variant="session.state === 'running' ? 'success' : 'secondary'">
                          {{ $t(`platform.trace.sessionState.${session.state}`) }}
                        </Badge>
                      </td>
                      <td class="px-3 py-2 font-mono text-xs">{{ session.level }}</td>
                      <td class="px-3 py-2 text-xs">{{ formatDateTime(session.expires_at) }}</td>
                      <td class="px-3 py-2 text-right text-xs tabular">{{ session.lines }}</td>
                      <td class="px-3 py-2 text-right text-xs tabular">{{ session.records }}</td>
                      <!--
                        Dropped is never hidden. A capture that lost lines under
                        budget otherwise reads as a quiet network, which is the
                        wrong conclusion to hand an operator.
                      -->
                      <td class="px-3 py-2 text-right">
                        <span
                          v-if="session.dropped > 0"
                          class="text-xs font-medium tabular text-warning"
                          :title="$t('platform.trace.droppedHint')"
                        >
                          {{ session.dropped }}
                        </span>
                        <span v-else class="text-xs tabular text-muted-foreground">0</span>
                      </td>
                      <td class="px-3 py-2">
                        <div class="flex justify-end gap-1">
                          <Button
                            v-if="session.state === 'running'"
                            variant="outline"
                            size="sm"
                            @click="tailSessionId === session.id ? stopTail() : startTail(session.id)"
                          >
                            {{ tailSessionId === session.id ? $t('platform.trace.tailStop') : $t('platform.trace.tailStart') }}
                          </Button>
                          <Button
                            v-if="session.state === 'running'"
                            variant="ghost"
                            size="sm"
                            :disabled="!canAdmin || stoppingId === session.id"
                            :title="adminReason"
                            @click="stopSession(session)"
                          >
                            <Square aria-hidden="true" class="size-4" />
                            {{ $t('platform.trace.sessionStop') }}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!--
                Narrow: stacked cards, same idiom DataTable uses for its own
                small-screen view. The table above needs 880px, so inside a
                375px viewport its last columns sit off screen behind a
                horizontal scroll, and Dropped is one of them. Dropped is the
                number that stops a capture which lost lines from reading as a
                quiet network, so it cannot be the thing an operator has to go
                looking for.
              -->
              <ul class="space-y-3 md:hidden">
                <li
                  v-for="session in sessions"
                  :key="session.id"
                  class="rounded-lg border border-border p-3"
                >
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <p class="truncate font-medium">{{ session.name || session.id }}</p>
                      <p class="font-mono text-xs text-muted-foreground">{{ shortId(session.id, 10) }}</p>
                    </div>
                    <Badge :variant="session.state === 'running' ? 'success' : 'secondary'">
                      {{ $t(`platform.trace.sessionState.${session.state}`) }}
                    </Badge>
                  </div>

                  <dl class="mt-3 space-y-2 text-xs">
                    <div class="flex items-start justify-between gap-3">
                      <dt class="text-muted-foreground">{{ $t('platform.trace.colSessionLevel') }}</dt>
                      <dd class="font-mono">{{ session.level }}</dd>
                    </div>
                    <div class="flex items-start justify-between gap-3">
                      <dt class="text-muted-foreground">{{ $t('platform.trace.colSessionExpires') }}</dt>
                      <dd class="text-right">{{ formatDateTime(session.expires_at) }}</dd>
                    </div>
                    <div class="flex items-start justify-between gap-3">
                      <dt class="text-muted-foreground">{{ $t('platform.trace.colSessionLines') }}</dt>
                      <dd class="tabular">{{ session.lines }}</dd>
                    </div>
                    <div class="flex items-start justify-between gap-3">
                      <dt class="text-muted-foreground">{{ $t('platform.trace.colSessionRecords') }}</dt>
                      <dd class="tabular">{{ session.records }}</dd>
                    </div>
                    <div class="flex items-start justify-between gap-3">
                      <dt class="text-muted-foreground">{{ $t('platform.trace.colSessionDropped') }}</dt>
                      <dd :class="session.dropped > 0 ? 'font-medium tabular text-warning' : 'tabular text-muted-foreground'">
                        {{ session.dropped }}
                      </dd>
                    </div>
                  </dl>
                  <p v-if="session.dropped > 0" class="mt-2 text-xs text-warning">
                    {{ $t('platform.trace.droppedHint') }}
                  </p>

                  <div v-if="session.state === 'running'" class="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      @click="tailSessionId === session.id ? stopTail() : startTail(session.id)"
                    >
                      {{ tailSessionId === session.id ? $t('platform.trace.tailStop') : $t('platform.trace.tailStart') }}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      :disabled="!canAdmin || stoppingId === session.id"
                      :title="adminReason"
                      @click="stopSession(session)"
                    >
                      <Square aria-hidden="true" class="size-4" />
                      {{ $t('platform.trace.sessionStop') }}
                    </Button>
                  </div>
                </li>
              </ul>
            </DataState>
          </CardContent>
        </Card>

        <!-- Live tail -->
        <Card v-if="tailSessionId">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Activity aria-hidden="true" class="size-4 text-muted-foreground" />
              {{ $t('platform.trace.tailTitle', { name: tailSession?.name || tailSessionId }) }}
            </CardTitle>
            <CardDescription>
              {{ $t('platform.trace.tailHint') }}
              <span v-if="tailSession && tailSession.dropped > 0" class="text-warning">
                {{ $t('platform.trace.tailDropped', { dropped: tailSession.dropped }) }}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <p v-if="tailError" class="text-xs text-destructive">{{ tailError.message }}</p>
            <div class="max-h-96 overflow-auto rounded-md border border-border bg-muted/10">
              <table class="w-full text-xs">
                <tbody class="font-mono">
                  <tr v-for="line in tailLines" :key="`${line.session_id}:${line.seq}`" class="border-b border-border last:border-b-0">
                    <td class="whitespace-nowrap px-3 py-1 text-muted-foreground tabular">{{ line.seq }}</td>
                    <td class="whitespace-nowrap px-3 py-1 text-muted-foreground">{{ formatDateTime(line.at) }}</td>
                    <td class="whitespace-nowrap px-3 py-1 text-muted-foreground">{{ line.level }}</td>
                    <td class="px-3 py-1"><span class="whitespace-pre-wrap break-all">{{ line.raw || line.message }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="tailLines.length === 0" class="text-xs text-muted-foreground">
              {{ $t('platform.trace.tailWaiting') }}
            </p>
          </CardContent>
        </Card>

        <!-- Start a session -->
        <Card>
          <CardHeader>
            <CardTitle>{{ $t('platform.trace.startTitle') }}</CardTitle>
            <CardDescription>{{ $t('platform.trace.startHint', { max: TRACE_TTL_MAX_SECONDS / 60 }) }}</CardDescription>
          </CardHeader>
          <CardContent>
            <form class="space-y-4" @submit.prevent="startSession">
              <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div class="grid gap-2">
                  <Label for="session-name">{{ $t('platform.trace.sessionNameLabel') }}</Label>
                  <Input
                    id="session-name"
                    v-model="sessionForm.name"
                    :disabled="!canAdmin"
                    :title="adminReason"
                    :placeholder="$t('platform.trace.sessionNamePlaceholder')"
                  />
                </div>
                <div class="grid gap-2">
                  <Label for="session-level">{{ $t('platform.trace.sessionLevelLabel') }}</Label>
                  <Select v-model="sessionForm.level" :disabled="!canAdmin">
                    <SelectTrigger id="session-level" class="w-full" :title="adminReason">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="level in TRACE_LEVELS" :key="level" :value="level">
                        {{ $t(`platform.trace.level.${level}`) }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-2">
                  <Label for="session-ttl">{{ $t('platform.trace.sessionTtlLabel') }}</Label>
                  <Input
                    id="session-ttl"
                    v-model.number="sessionForm.ttlSeconds"
                    type="number"
                    min="60"
                    :max="TRACE_TTL_MAX_SECONDS"
                    :disabled="!canAdmin"
                    :title="adminReason"
                  />
                  <p class="text-xs text-muted-foreground">
                    {{ $t('platform.trace.sessionTtlHint', { seconds: clampTraceTtlSeconds(sessionForm.ttlSeconds) }) }}
                  </p>
                </div>
                <div class="grid gap-2">
                  <Label for="session-dst">{{ $t('platform.trace.sessionDstLabel') }}</Label>
                  <Input
                    id="session-dst"
                    v-model.trim="sessionForm.dst"
                    :disabled="!canAdmin"
                    :title="adminReason"
                    :placeholder="$t('platform.trace.dstPlaceholder')"
                  />
                </div>
                <div class="grid gap-2">
                  <Label for="session-node">{{ $t('platform.trace.nodeLabel') }}</Label>
                  <Input
                    id="session-node"
                    v-model.trim="sessionForm.nodeId"
                    class="font-mono text-xs"
                    :disabled="!canAdmin"
                    :title="adminReason"
                    :placeholder="$t('platform.trace.anyNode')"
                  />
                </div>
                <div class="grid gap-2">
                  <Label for="session-user">{{ $t('platform.trace.userLabel') }}</Label>
                  <Input
                    id="session-user"
                    v-model.trim="sessionForm.userId"
                    class="font-mono text-xs"
                    :disabled="!canAdmin"
                    :title="adminReason"
                    :placeholder="$t('platform.trace.userPlaceholder')"
                  />
                </div>
                <div class="grid gap-2">
                  <Label for="session-line">{{ $t('platform.trace.lineLabel') }}</Label>
                  <Input
                    id="session-line"
                    v-model.trim="sessionForm.lineUuid"
                    class="font-mono text-xs"
                    :disabled="!canAdmin"
                    :title="adminReason"
                    :placeholder="$t('platform.trace.linePlaceholder')"
                  />
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <Button type="button" variant="ghost" size="sm" :disabled="!canAdmin" @click="prefillSessionFromFilters">
                  {{ $t('platform.trace.copyFilters') }}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  class="ms-auto"
                  :disabled="!canAdmin || startingSession || !sessionForm.name.trim()"
                  :title="adminReason"
                >
                  <RefreshCw v-if="startingSession" aria-hidden="true" class="size-4 animate-spin" />
                  <Play v-else aria-hidden="true" class="size-4" />
                  {{ $t('platform.trace.sessionStart') }}
                </Button>
              </div>
              <p v-if="!canAdmin" class="text-xs text-muted-foreground">
                <i18n-t keypath="platform.trace.needsAdmin" tag="span" scope="global">
                  <template #scope><code class="font-mono">log:admin</code></template>
                </i18n-t>
              </p>
            </form>
          </CardContent>
        </Card>
      </TabsContent>

      <!-- ── Collection policy ───────────────────────────────────────── -->
      <TabsContent value="policy" class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{{ $t('platform.trace.policyTitle') }}</CardTitle>
            <CardDescription>{{ $t('platform.trace.policyHint') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <DataState
              :loading="policyQuery.loading.value"
              :error="policyQuery.error.value"
              :has-data="policyQuery.data.value !== undefined"
              :is-empty="policies.length === 0"
              :empty-title="$t('platform.trace.policyEmptyTitle')"
              :empty-description="$t('platform.trace.policyEmptyDescription')"
              @retry="policyQuery.refresh"
            >
              <!-- Desktop: the dense table. -->
              <div class="hidden overflow-x-auto rounded-md border border-border md:block">
                <table class="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr class="border-b border-border text-left text-xs text-muted-foreground">
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colPolicyNode') }}</th>
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colPolicyEnabled') }}</th>
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colPolicyLevel') }}</th>
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colPolicyBudget') }}</th>
                      <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colPolicyUpdated') }}</th>
                      <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colPolicyActions') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in policies" :key="row.node_id" class="border-b border-border last:border-b-0">
                      <td class="px-3 py-2">
                        <span class="font-medium">{{ nodeLabel(row.node_id) }}</span>
                        <span class="ms-2 font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 10) }}</span>
                      </td>
                      <td class="px-3 py-2">
                        <Checkbox
                          :model-value="policyDraft(row).enabled"
                          :disabled="!canAdmin"
                          :aria-label="$t('platform.trace.colPolicyEnabled')"
                          @update:model-value="(v) => setPolicyField(row, 'enabled', v === true)"
                        />
                      </td>
                      <td class="px-3 py-2">
                        <Select
                          :model-value="policyDraft(row).level"
                          :disabled="!canAdmin"
                          @update:model-value="(v) => setPolicyField(row, 'level', String(v) as TraceLevel)"
                        >
                          <SelectTrigger class="w-32" :title="adminReason">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="level in TRACE_LEVELS" :key="level" :value="level">
                              {{ $t(`platform.trace.level.${level}`) }}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td class="px-3 py-2">
                        <Input
                          class="w-28"
                          type="number"
                          min="0"
                          :model-value="policyDraft(row).budget"
                          :disabled="!canAdmin"
                          :title="adminReason"
                          :aria-label="$t('platform.trace.colPolicyBudget')"
                          @update:model-value="(v) => setPolicyField(row, 'budget', Number(v) || 0)"
                        />
                      </td>
                      <td class="px-3 py-2 text-xs text-muted-foreground">
                        {{ row.updated_at ? formatDateTime(row.updated_at) : $t('common.misc.none') }}
                      </td>
                      <td class="px-3 py-2">
                        <div class="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            :disabled="!canAdmin || !policyDirty(row) || savingPolicyNode === row.node_id"
                            :title="adminReason"
                            @click="savePolicy(row)"
                          >
                            <RefreshCw v-if="savingPolicyNode === row.node_id" aria-hidden="true" class="size-4 animate-spin" />
                            {{ $t('common.actions.save') }}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!--
                Narrow: the same rows as cards. The table needs 760px, which put
                the level, the budget and the Save button off screen at 375, so
                the policy was readable there but not editable.
              -->
              <ul class="space-y-3 md:hidden">
                <li v-for="row in policies" :key="row.node_id" class="rounded-lg border border-border p-3">
                  <div class="min-w-0">
                    <p class="truncate font-medium">{{ nodeLabel(row.node_id) }}</p>
                    <p class="font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 10) }}</p>
                  </div>

                  <div class="mt-3 space-y-3 text-xs">
                    <label class="flex items-center justify-between gap-3">
                      <span class="text-muted-foreground">{{ $t('platform.trace.colPolicyEnabled') }}</span>
                      <Checkbox
                        :model-value="policyDraft(row).enabled"
                        :disabled="!canAdmin"
                        :aria-label="$t('platform.trace.colPolicyEnabled')"
                        @update:model-value="(v) => setPolicyField(row, 'enabled', v === true)"
                      />
                    </label>
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-muted-foreground">{{ $t('platform.trace.colPolicyLevel') }}</span>
                      <Select
                        :model-value="policyDraft(row).level"
                        :disabled="!canAdmin"
                        @update:model-value="(v) => setPolicyField(row, 'level', String(v) as TraceLevel)"
                      >
                        <SelectTrigger class="w-32" :title="adminReason">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="level in TRACE_LEVELS" :key="level" :value="level">
                            {{ $t(`platform.trace.level.${level}`) }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-muted-foreground">{{ $t('platform.trace.colPolicyBudget') }}</span>
                      <Input
                        class="w-28"
                        type="number"
                        min="0"
                        :model-value="policyDraft(row).budget"
                        :disabled="!canAdmin"
                        :title="adminReason"
                        :aria-label="$t('platform.trace.colPolicyBudget')"
                        @update:model-value="(v) => setPolicyField(row, 'budget', Number(v) || 0)"
                      />
                    </div>
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-muted-foreground">{{ $t('platform.trace.colPolicyUpdated') }}</span>
                      <span class="text-muted-foreground">
                        {{ row.updated_at ? formatDateTime(row.updated_at) : $t('common.misc.none') }}
                      </span>
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    class="mt-3 w-full"
                    :disabled="!canAdmin || !policyDirty(row) || savingPolicyNode === row.node_id"
                    :title="adminReason"
                    @click="savePolicy(row)"
                  >
                    <RefreshCw v-if="savingPolicyNode === row.node_id" aria-hidden="true" class="size-4 animate-spin" />
                    {{ $t('common.actions.save') }}
                  </Button>
                </li>
              </ul>
              <p v-if="!canAdmin" class="text-xs text-muted-foreground">
                <i18n-t keypath="platform.trace.needsAdmin" tag="span" scope="global">
                  <template #scope><code class="font-mono">log:admin</code></template>
                </i18n-t>
              </p>
              <p class="text-xs text-muted-foreground">{{ $t('platform.trace.budgetHint') }}</p>
            </DataState>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>

    <!-- ── Record detail ─────────────────────────────────────────────── -->
    <Dialog :open="!!selected" @update:open="(v) => { if (!v) closeRecord(); }">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.trace.detailTitle') }}</DialogTitle>
          <DialogDescription>
            <span v-if="selected" class="font-mono text-xs">
              {{ connRecordKey(selected) }}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div v-if="selected" class="space-y-6">
          <!-- Identity -->
          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ $t('platform.trace.detailIdentity') }}</h3>
            <dl class="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colUser') }}</dt>
                <dd :class="cn('mt-0.5', selectedUser?.monospace && 'font-mono')">
                  {{ selectedUser?.primary || $t('platform.trace.userNoneLogged') }}
                </dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.userKindLabel') }}</dt>
                <dd class="mt-0.5">
                  {{ $t(`platform.trace.userKind.${selectedUser?.kind ?? 'unknown'}`) }}
                  <span v-if="selectedUser?.marker" class="text-muted-foreground">
                    {{ $t('platform.trace.userUnresolvedHint') }}
                  </span>
                </dd>
              </div>
              <div v-if="selectedUser?.userId">
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailUserId') }}</dt>
                <dd class="mt-0.5 font-mono break-all">{{ selectedUser.userId }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colNode') }}</dt>
                <dd class="mt-0.5">{{ nodeLabel(selected.node_id) }}</dd>
              </div>
              <div v-if="selected.line_uuid">
                <dt class="text-muted-foreground">{{ $t('platform.trace.colLine') }}</dt>
                <dd class="mt-0.5 font-mono break-all">{{ selected.line_uuid }}</dd>
              </div>
              <div v-if="selected.inbound_tag">
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailInbound') }}</dt>
                <dd class="mt-0.5 font-mono">{{ selected.inbound_tag }} ({{ selected.inbound_type || $t('common.misc.none') }})</dd>
              </div>
            </dl>
          </section>

          <!-- Connection -->
          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ $t('platform.trace.detailConnection') }}</h3>
            <dl class="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colDestination') }}</dt>
                <dd class="mt-0.5 font-mono break-all">{{ destinationText(selected) || $t('common.misc.none') }}</dd>
              </div>
              <div v-if="selected.dst_ip">
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailResolvedIp') }}</dt>
                <dd class="mt-0.5 font-mono">{{ selected.dst_ip }}</dd>
              </div>
              <div v-if="selected.src_ip">
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailSource') }}</dt>
                <dd class="mt-0.5 font-mono">{{ selected.src_ip }}:{{ selected.src_port }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailNetwork') }}</dt>
                <dd class="mt-0.5 font-mono">{{ selected.network || $t('common.misc.none') }}</dd>
              </div>
              <div v-if="selected.sniffed_protocol || selected.sniffed_domain">
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailSniffed') }}</dt>
                <dd class="mt-0.5 font-mono break-all">
                  {{ selected.sniffed_protocol || $t('common.misc.none') }}
                  <span v-if="selected.sniffed_domain">/ {{ selected.sniffed_domain }}</span>
                </dd>
              </div>
              <div v-if="selected.rule_text">
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailRule') }}</dt>
                <dd class="mt-0.5 font-mono break-all">{{ selected.rule_text }}</dd>
              </div>
              <div v-if="selected.outbound_tag">
                <dt class="text-muted-foreground">{{ $t('platform.trace.colOutbound') }}</dt>
                <dd class="mt-0.5 font-mono">{{ selected.outbound_tag }} ({{ selected.outbound_type || $t('common.misc.none') }})</dd>
              </div>
            </dl>
          </section>

          <!-- Lifecycle -->
          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ $t('platform.trace.detailLifecycle') }}</h3>
            <dl class="grid gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colStarted') }}</dt>
                <dd class="mt-0.5">{{ formatDateTime(selected.started_at) }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailEnded') }}</dt>
                <dd class="mt-0.5">{{ selected.ended_at ? formatDateTime(selected.ended_at) : $t('platform.trace.stillOpen') }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colDuration') }}</dt>
                <dd class="mt-0.5">
                  {{ traceDurationCell(selected.duration_ms).known ? traceDurationCell(selected.duration_ms).text : $t('platform.trace.durationUnknown') }}
                </dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colClose') }}</dt>
                <dd class="mt-0.5 flex flex-wrap items-center gap-1">
                  <Badge :variant="selectedClose?.tone ?? 'outline'">
                    {{ $t(`platform.trace.closeReason.${selectedClose?.id ?? 'unknown'}`) }}
                  </Badge>
                  <span v-if="selectedClose && !selectedClose.certain" class="text-muted-foreground">
                    {{ $t('platform.trace.closeUnknownHint') }}
                  </span>
                  <span v-if="selectedClose?.raw && selectedClose.id === 'unknown'" class="font-mono text-muted-foreground">
                    {{ $t('platform.trace.closeRawValue', { value: selectedClose.raw }) }}
                  </span>
                </dd>
              </div>
              <div v-if="selected.close_error">
                <dt class="text-muted-foreground">{{ $t('platform.trace.detailCloseError') }}</dt>
                <dd class="mt-0.5 font-mono break-all text-destructive">{{ selected.close_error }}</dd>
              </div>
              <div v-if="selected.stalled_at">
                <dt class="text-muted-foreground">{{ $t('platform.trace.stalled') }}</dt>
                <dd class="mt-0.5">{{ formatDateTime(selected.stalled_at) }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colUpload') }}</dt>
                <dd class="mt-0.5">
                  <span v-if="traceBytesCell(selected.upload, selected.bytes_known).known">
                    {{ traceBytesCell(selected.upload, selected.bytes_known).text }}
                  </span>
                  <span v-else class="italic text-muted-foreground">{{ $t('platform.trace.bytesNotSampled') }}</span>
                </dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('platform.trace.colDownload') }}</dt>
                <dd class="mt-0.5">
                  <span v-if="traceBytesCell(selected.download, selected.bytes_known).known">
                    {{ traceBytesCell(selected.download, selected.bytes_known).text }}
                  </span>
                  <span v-else class="italic text-muted-foreground">{{ $t('platform.trace.bytesNotSampled') }}</span>
                </dd>
              </div>
            </dl>
            <p v-if="!selected.bytes_known" class="text-xs text-muted-foreground">
              {{ $t('platform.trace.bytesNotSampledHint') }}
            </p>
          </section>

          <!-- Hop path -->
          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ $t('platform.trace.detailHops') }}</h3>
            <DataState
              :loading="hopLoading"
              :error="hopError"
              :has-data="!!hopPath"
              :is-empty="!hopPath"
              :skeleton-rows="2"
              :empty-title="$t('platform.trace.hopsEmptyTitle')"
              :empty-description="$t('platform.trace.hopsEmptyDescription')"
              @retry="selected && loadHops(selected)"
            >
              <div v-if="hopPath" class="space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <Badge :variant="hopConfidence.tone">
                    {{ $t(`platform.trace.hopConfidence.${hopConfidence.id}`) }}
                  </Badge>
                  <span class="text-xs text-muted-foreground">
                    {{ $t(`platform.trace.hopConfidence.${hopConfidence.id}Wording`) }}
                  </span>
                </div>
                <ol class="space-y-1">
                  <li
                    v-for="(key, index) in hopPath.record_keys"
                    :key="`${key.node_id}:${key.core_generation}:${key.log_id}`"
                    class="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
                  >
                    <span class="text-muted-foreground tabular">{{ index + 1 }}</span>
                    <span class="font-medium">{{ nodeLabel(key.node_id) }}</span>
                    <span class="font-mono text-muted-foreground">{{ key.node_id }}:{{ key.core_generation }}:{{ key.log_id }}</span>
                    <span v-if="hopRecordFor(key)" class="font-mono">
                      {{ destinationText(hopRecordFor(key)!) }}
                    </span>
                  </li>
                </ol>
                <div v-if="hopConfidence.ambiguous && hopPath.candidates?.length" class="space-y-1">
                  <p class="text-xs text-muted-foreground">{{ $t('platform.trace.hopCandidates') }}</p>
                  <ul class="space-y-1">
                    <li
                      v-for="candidate in hopPath.candidates"
                      :key="`c:${candidate.node_id}:${candidate.core_generation}:${candidate.log_id}`"
                      class="rounded-md border border-dashed border-border px-3 py-1.5 font-mono text-xs"
                    >
                      {{ candidate.node_id }}:{{ candidate.core_generation }}:{{ candidate.log_id }}
                    </li>
                  </ul>
                </div>
              </div>
            </DataState>
          </section>

          <!-- Captured lines -->
          <section class="space-y-2">
            <h3 class="text-sm font-medium">{{ $t('platform.trace.detailLines') }}</h3>
            <p v-if="!selected.session_ids?.length" class="text-xs text-muted-foreground">
              {{ $t('platform.trace.linesNoSession') }}
            </p>
            <DataState
              v-else
              :loading="recordLinesLoading"
              :error="recordLinesError"
              :has-data="recordLines.length > 0"
              :is-empty="recordLines.length === 0"
              :skeleton-rows="2"
              :empty-title="$t('platform.trace.linesEmptyTitle')"
              :empty-description="$t('platform.trace.linesEmptyDescription')"
              @retry="selected && loadRecordLines(selected)"
            >
              <div class="max-h-72 overflow-auto rounded-md border border-border bg-muted/10">
                <table class="w-full text-xs">
                  <tbody class="font-mono">
                    <tr v-for="line in recordLines" :key="`${line.session_id}:${line.seq}`" class="border-b border-border last:border-b-0">
                      <td class="whitespace-nowrap px-3 py-1 text-muted-foreground">{{ formatDateTime(line.at) }}</td>
                      <td class="whitespace-nowrap px-3 py-1 text-muted-foreground">{{ line.level }}</td>
                      <td class="px-3 py-1"><span class="whitespace-pre-wrap break-all">{{ line.raw || line.message }}</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </DataState>
          </section>
        </div>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
