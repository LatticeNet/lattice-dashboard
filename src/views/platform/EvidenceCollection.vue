<script setup lang="ts">
/**
 * Evidence Collection (L3): what governs collection, out of the daily path.
 *
 * The per-node trace policy is the always-on floor; the capture history is
 * every time-boxed session with what it kept and what it dropped; the raw log
 * sources are the files and virtual streams each node ships. The Overview's
 * capture button covers the common case (these nodes, this long); a capture
 * narrowed to a user, a line or a destination starts here.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { toast } from "vue-sonner";
import { CircleStop, Play, RefreshCw, ScrollText } from "lucide-vue-next";

import { api, type TraceLevel, type TraceLine, type TracePolicy, type TraceSession } from "@/lib/api";
import { formatDateTime, shortId } from "@/lib/format";
import DataState from "@/components/common/DataState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import EvidenceLogSources from "./EvidenceLogSources.vue";
import { TRACE_TTL_DEFAULT_SECONDS, TRACE_TTL_MAX_SECONDS, clampTraceTtlSeconds } from "./connTraceModel";
import { useEvidenceContext } from "./evidenceContext";
import {
  EMPTY_EVIDENCE_QUERY,
  readEvidenceQuery,
  uniformPolicyColumns,
  writeEvidenceLayer,
  writeEvidenceQuery,
} from "./evidenceModel";

const TRACE_LEVELS: readonly TraceLevel[] = ["info", "debug", "trace"];
const TAIL_POLL_MS = 2000;
const TAIL_LINE_CAP = 2000;

const { t } = useI18n();
const route = useRoute();
const ctx = useEvidenceContext();

const adminReason = computed(() =>
  ctx.canAdmin.value ? undefined : t("platform.trace.needsAdmin", { scope: "log:admin" }),
);

/* ------------------------------------------------------------------ */
/* Collection policy                                                   */
/* ------------------------------------------------------------------ */

interface PolicyDraft {
  enabled: boolean;
  level: TraceLevel;
  budget: number;
}

const policies = computed(() => ctx.policies.data.value ?? []);

/**
 * Idle nodes (policy off, no capture, no raw log source, nothing held) read
 * the same on every row, so they collapse into one line with a toggle, as on
 * Overview. A row being edited stays out, so a change is never hidden before
 * it is saved, and every node stays one click away.
 */
const showIdlePolicies = ref(false);
const idleNodeIds = computed(() => new Set(ctx.coverageRows.value.filter((row) => row.quiet).map((row) => row.nodeId)));
const idlePolicies = computed(() => policies.value.filter((row) => idleNodeIds.value.has(row.node_id) && !dirty(row)));
const shownPolicies = computed(() =>
  showIdlePolicies.value ? policies.value : policies.value.filter((row) => !idleNodeIds.value.has(row.node_id) || dirty(row)),
);
const drafts = ref<Record<string, PolicyDraft>>({});
const savingNode = ref("");

/**
 * Columns whose saved value is the same on every node (today: debug, 500 a
 * second, never changed) say it once in the header. The row's control stays
 * in place and in the tab order, shown when the row is hovered or holds
 * focus, always on a touch screen, and always once the row is edited.
 */
const uniform = computed(() => uniformPolicyColumns(policies.value));
const REVEAL = "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";
function revealUnlessEdited(row: TracePolicy, column: "level" | "budget"): string | undefined {
  return uniform.value[column] !== undefined && !dirty(row) ? REVEAL : undefined;
}

watch(
  policies,
  (rows) => {
    const next = { ...drafts.value };
    for (const row of rows) {
      if (next[row.node_id]) continue;
      next[row.node_id] = { enabled: row.enabled, level: row.level, budget: row.budget_lines_per_sec };
    }
    drafts.value = next;
  },
  { immediate: true },
);

function draftOf(row: TracePolicy): PolicyDraft {
  return drafts.value[row.node_id] ?? { enabled: row.enabled, level: row.level, budget: row.budget_lines_per_sec };
}

function dirty(row: TracePolicy): boolean {
  const d = draftOf(row);
  return d.enabled !== row.enabled || d.level !== row.level || Number(d.budget) !== row.budget_lines_per_sec;
}

function setField<K extends keyof PolicyDraft>(row: TracePolicy, key: K, value: PolicyDraft[K]): void {
  drafts.value = { ...drafts.value, [row.node_id]: { ...draftOf(row), [key]: value } };
}

async function savePolicy(row: TracePolicy): Promise<void> {
  if (!ctx.canAdmin.value || savingNode.value) return;
  const d = draftOf(row);
  savingNode.value = row.node_id;
  try {
    await api.trace.setPolicy({
      node_id: row.node_id,
      enabled: d.enabled,
      level: d.level,
      budget_lines_per_sec: Math.max(0, Math.floor(Number(d.budget) || 0)),
    });
    toast.success(t("platform.trace.policySaved", { node: ctx.nodeLabel(row.node_id) }));
    const { [row.node_id]: _saved, ...rest } = drafts.value;
    drafts.value = rest;
    await ctx.policies.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.policySaveFailed"));
  } finally {
    savingNode.value = "";
  }
}

/* ------------------------------------------------------------------ */
/* Capture history                                                     */
/* ------------------------------------------------------------------ */

const sessions = computed(() =>
  [...(ctx.sessions.data.value ?? [])].sort((a, b) => (b.started_at || "").localeCompare(a.started_at || "")),
);
const stoppingId = ref("");

function sessionNodes(session: TraceSession): string {
  const ids = session.filter?.node_ids ?? [];
  return ids.length === 0 ? t("platform.evidence.capture.allNodes") : ids.map((id) => ctx.nodeLabel(id)).join(", ");
}

function recordsLink(session: TraceSession) {
  const base = writeEvidenceLayer(route.query, "explore");
  return {
    query: writeEvidenceQuery(base, { ...EMPTY_EVIDENCE_QUERY, sessionId: session.id }, { range: "all", since: "", until: "" }),
  };
}

async function stopSession(session: TraceSession): Promise<void> {
  if (!ctx.canAdmin.value || stoppingId.value) return;
  stoppingId.value = session.id;
  try {
    await api.trace.stopSession(session.id);
    toast.success(t("platform.trace.sessionStopped", { name: session.name || session.id }));
    if (tailSessionId.value === session.id) stopTail();
    await ctx.sessions.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.sessionStopFailed"));
  } finally {
    stoppingId.value = "";
  }
}

/* Live tail --------------------------------------------------------- */

const tailSessionId = ref("");
const tailLines = ref<TraceLine[]>([]);
const tailSeq = ref(0);
const tailError = ref<Error | null>(null);
let tailTimer: ReturnType<typeof setInterval> | undefined;
let tailController: AbortController | undefined;
let tailInFlight = false;

const tailSession = computed(() => sessions.value.find((s) => s.id === tailSessionId.value));

/**
 * One tail poll. The AbortSignal takes the request past the client's 750ms
 * GET cache, which would otherwise hand a two second poll the page it already
 * had and make a running capture look like a quiet network.
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
    tailSeq.value = res.next_seq ?? lines.reduce((max, line) => Math.max(max, line.seq), tailSeq.value);
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

onBeforeUnmount(stopTail);

/* Capture with a filter -------------------------------------------- */

const filterFormOpen = ref(false);
const form = ref({
  name: "",
  level: "debug" as TraceLevel,
  ttlSeconds: TRACE_TTL_DEFAULT_SECONDS,
  nodeId: "",
  userId: "",
  lineUuid: "",
  dst: "",
});
const starting = ref(false);

/** The question asked in Explore is usually the capture wanted next. */
function prefillFromExplore(): void {
  const q = readEvidenceQuery(route.query);
  form.value.nodeId = q.nodeId;
  form.value.userId = q.userId;
  form.value.lineUuid = q.lineUuid;
  form.value.dst = q.dst;
}

function list(value: string): string[] | undefined {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

async function startFiltered(): Promise<void> {
  if (!ctx.canAdmin.value || starting.value) return;
  const name = form.value.name.trim();
  if (!name) return;
  starting.value = true;
  try {
    const created = await api.trace.startSession({
      name,
      level: form.value.level,
      ttl_seconds: clampTraceTtlSeconds(form.value.ttlSeconds),
      filter: {
        node_ids: list(form.value.nodeId),
        user_ids: list(form.value.userId),
        line_uuids: list(form.value.lineUuid),
        dst_patterns: form.value.dst.trim() ? [form.value.dst.trim()] : undefined,
      },
    });
    toast.success(t("platform.trace.sessionStarted", { name: created.name || created.id }));
    form.value.name = "";
    await ctx.sessions.refresh();
    startTail(created.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.sessionStartFailed"));
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div class="space-y-8">
    <!-- ── Collection policy ─────────────────────────────────────────── -->
    <section class="space-y-3" aria-labelledby="evidence-policy-title">
      <div class="space-y-1">
        <h2 id="evidence-policy-title" class="text-sm font-semibold tracking-[-0.01em]">{{ $t('platform.trace.policyTitle') }}</h2>
        <p class="max-w-3xl text-sm text-muted-foreground">{{ $t('platform.evidence.collection.policyHint') }}</p>
      </div>
      <DataState
        :loading="ctx.policies.loading.value"
        :error="ctx.policies.error.value"
        :has-data="ctx.policies.data.value !== undefined"
        :is-empty="policies.length === 0"
        :empty-title="$t('platform.trace.policyEmptyTitle')"
        :empty-description="$t('platform.trace.policyEmptyDescription')"
        @retry="ctx.policies.refresh"
      >
        <div v-if="shownPolicies.length" class="relative overflow-x-auto rounded-md border border-border">
          <table class="w-full min-w-[720px] text-sm">
            <thead>
              <tr class="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" class="pin-start px-3 py-2 font-medium">{{ $t('platform.trace.colPolicyNode') }}</th>
                <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colPolicyEnabled') }}</th>
                <th scope="col" class="px-3 py-2 font-medium">
                  {{ $t('platform.trace.colPolicyLevel') }}
                  <span v-if="uniform.level" class="block pt-0.5 font-normal text-foreground">
                    {{ $t('platform.evidence.collection.everyNode', { value: $t(`platform.trace.level.${uniform.level}`) }) }}
                  </span>
                </th>
                <th scope="col" class="px-3 py-2 font-medium">
                  {{ $t('platform.trace.colPolicyBudget') }}
                  <span v-if="uniform.budget !== undefined" class="block pt-0.5 font-normal text-foreground tabular">
                    {{ $t('platform.evidence.collection.everyNode', { value: uniform.budget }) }}
                  </span>
                </th>
                <th scope="col" class="px-3 py-2 font-medium">
                  {{ $t('platform.trace.colPolicyUpdated') }}
                  <span v-if="uniform.updated !== undefined" class="block pt-0.5 font-normal text-foreground tabular">
                    {{ $t('platform.evidence.collection.everyNode', {
                      value: uniform.updated ? formatDateTime(uniform.updated) : $t('platform.evidence.collection.neverChanged'),
                    }) }}
                  </span>
                </th>
                <th scope="col" class="pin-end px-3 py-2 text-right font-medium"><span class="sr-only">{{ $t('platform.trace.colPolicyActions') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in shownPolicies" :key="row.node_id" class="group border-b border-border last:border-b-0">
                <th scope="row" class="pin-start px-3 py-2 text-left font-medium">
                  <span class="block truncate" :title="row.node_id">{{ ctx.nodeLabel(row.node_id) }}</span>
                </th>
                <td class="px-3 py-2">
                  <Checkbox
                    :model-value="draftOf(row).enabled"
                    :disabled="!ctx.canAdmin.value"
                    :aria-label="$t('platform.evidence.collection.policyEnabledFor', { node: ctx.nodeLabel(row.node_id) })"
                    @update:model-value="(v) => setField(row, 'enabled', v === true)"
                  />
                </td>
                <td class="px-3 py-2" :class="revealUnlessEdited(row, 'level')">
                  <Select
                    :model-value="draftOf(row).level"
                    :disabled="!ctx.canAdmin.value"
                    @update:model-value="(v) => setField(row, 'level', String(v) as TraceLevel)"
                  >
                    <SelectTrigger class="h-8 w-28" :title="adminReason" :aria-label="$t('platform.trace.colPolicyLevel')">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="level in TRACE_LEVELS" :key="level" :value="level">{{ $t(`platform.trace.level.${level}`) }}</SelectItem>
                    </SelectContent>
                  </Select>
                </td>
                <td class="px-3 py-2" :class="revealUnlessEdited(row, 'budget')">
                  <Input
                    class="h-8 w-24 font-mono text-xs"
                    type="number"
                    min="0"
                    :model-value="draftOf(row).budget"
                    :disabled="!ctx.canAdmin.value"
                    :title="adminReason"
                    :aria-label="$t('platform.trace.colPolicyBudget')"
                    @update:model-value="(v) => setField(row, 'budget', Number(v) || 0)"
                  />
                </td>
                <td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-muted-foreground tabular">
                  <template v-if="uniform.updated === undefined">
                    {{ row.updated_at ? formatDateTime(row.updated_at) : $t('common.misc.none') }}
                  </template>
                </td>
                <td class="pin-end px-3 py-2 text-right">
                  <!-- Save exists only where there is something to save. -->
                  <Button
                    v-if="dirty(row) || savingNode === row.node_id"
                    size="sm"
                    variant="outline"
                    :disabled="!ctx.canAdmin.value || savingNode === row.node_id"
                    :title="adminReason"
                    @click="savePolicy(row)"
                  >
                    <RefreshCw v-if="savingNode === row.node_id" aria-hidden="true" class="size-4 animate-spin" />
                    {{ $t('common.actions.save') }}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="idlePolicies.length" class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
          <p class="text-sm text-muted-foreground">
            {{ showIdlePolicies
              ? $t('platform.evidence.overview.quietShown', { count: idlePolicies.length }, idlePolicies.length)
              : shownPolicies.length
                ? $t('platform.evidence.overview.quietRows', { count: idlePolicies.length }, idlePolicies.length)
                : $t('platform.evidence.overview.quietAll', { count: idlePolicies.length }, idlePolicies.length) }}
          </p>
          <Button variant="ghost" size="sm" :aria-expanded="showIdlePolicies" @click="showIdlePolicies = !showIdlePolicies">
            {{ showIdlePolicies
              ? $t('platform.evidence.overview.hideQuiet')
              : $t('platform.evidence.overview.showQuiet', { count: idlePolicies.length }, idlePolicies.length) }}
          </Button>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          {{ $t('platform.trace.budgetHint') }}
          <template v-if="!ctx.canAdmin.value"> {{ $t('platform.trace.needsAdmin', { scope: 'log:admin' }) }}</template>
        </p>
      </DataState>
    </section>

    <!-- ── Capture history ───────────────────────────────────────────── -->
    <section class="space-y-3" aria-labelledby="evidence-sessions-title">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div class="space-y-1">
          <h2 id="evidence-sessions-title" class="text-sm font-semibold tracking-[-0.01em]">{{ $t('platform.evidence.collection.historyTitle') }}</h2>
          <p class="max-w-3xl text-sm text-muted-foreground">{{ $t('platform.trace.sessionsHint') }}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          :aria-expanded="filterFormOpen"
          :disabled="!ctx.canAdmin.value"
          :title="adminReason"
          @click="() => { filterFormOpen = !filterFormOpen; if (filterFormOpen) prefillFromExplore(); }"
        >
          {{ $t('platform.evidence.collection.filteredCapture') }}
        </Button>
      </div>

      <!-- A capture narrowed to a user, a line or a destination. -->
      <form
        v-if="filterFormOpen"
        class="space-y-4 rounded-md border border-border p-4"
        @submit.prevent="startFiltered"
      >
        <p class="text-xs text-muted-foreground">{{ $t('platform.trace.startHint', { max: TRACE_TTL_MAX_SECONDS / 60 }) }}</p>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div class="grid gap-2">
            <Label for="capture-name">{{ $t('platform.trace.sessionNameLabel') }}</Label>
            <Input id="capture-name" v-model="form.name" :placeholder="$t('platform.trace.sessionNamePlaceholder')" />
          </div>
          <div class="grid gap-2">
            <Label for="capture-level">{{ $t('platform.trace.sessionLevelLabel') }}</Label>
            <Select v-model="form.level">
              <SelectTrigger id="capture-level" class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="level in TRACE_LEVELS" :key="level" :value="level">{{ $t(`platform.trace.level.${level}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-2">
            <Label for="capture-ttl">{{ $t('platform.trace.sessionTtlLabel') }}</Label>
            <Input id="capture-ttl" v-model.number="form.ttlSeconds" type="number" min="60" :max="TRACE_TTL_MAX_SECONDS" class="font-mono" />
            <p class="text-xs text-muted-foreground">{{ $t('platform.trace.sessionTtlHint', { seconds: clampTraceTtlSeconds(form.ttlSeconds) }) }}</p>
          </div>
          <div class="grid gap-2">
            <Label for="capture-node">{{ $t('platform.trace.nodeLabel') }}</Label>
            <Input id="capture-node" v-model.trim="form.nodeId" class="font-mono text-xs" :placeholder="$t('platform.trace.anyNode')" />
          </div>
          <div class="grid gap-2">
            <Label for="capture-user">{{ $t('platform.trace.userLabel') }}</Label>
            <Input id="capture-user" v-model.trim="form.userId" class="font-mono text-xs" :placeholder="$t('platform.trace.userPlaceholder')" />
          </div>
          <div class="grid gap-2">
            <Label for="capture-line">{{ $t('platform.trace.lineLabel') }}</Label>
            <Input id="capture-line" v-model.trim="form.lineUuid" class="font-mono text-xs" :placeholder="$t('platform.trace.linePlaceholder')" />
          </div>
          <div class="grid gap-2">
            <Label for="capture-dst">{{ $t('platform.trace.sessionDstLabel') }}</Label>
            <Input id="capture-dst" v-model.trim="form.dst" :placeholder="$t('platform.trace.dstPlaceholder')" />
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" @click="filterFormOpen = false">{{ $t('common.actions.cancel') }}</Button>
          <Button type="submit" size="sm" :disabled="starting || !form.name.trim()">
            <RefreshCw v-if="starting" aria-hidden="true" class="size-4 animate-spin" />
            <Play v-else aria-hidden="true" class="size-4" />
            {{ $t('platform.trace.sessionStart') }}
          </Button>
        </div>
      </form>

      <DataState
        :loading="ctx.sessions.loading.value"
        :error="ctx.sessions.error.value"
        :has-data="ctx.sessions.data.value !== undefined"
        :is-empty="sessions.length === 0"
        :empty-title="$t('platform.trace.sessionsEmptyTitle')"
        :empty-description="$t('platform.evidence.collection.historyEmpty')"
        @retry="ctx.sessions.refresh"
      >
        <div class="relative overflow-x-auto rounded-md border border-border">
          <table class="w-full min-w-[920px] text-sm">
            <thead>
              <tr class="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" class="pin-start px-3 py-2 font-medium [--pin-max:15rem]">{{ $t('platform.trace.colSessionName') }}</th>
                <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colSessionState') }}</th>
                <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.evidence.collection.colNodes') }}</th>
                <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colSessionLevel') }}</th>
                <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.trace.colSessionExpires') }}</th>
                <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colSessionLines') }}</th>
                <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colSessionRecords') }}</th>
                <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.trace.colSessionDropped') }}</th>
                <th scope="col" class="pin-end px-3 py-2 text-right font-medium"><span class="sr-only">{{ $t('platform.trace.colSessionActions') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="session in sessions" :key="session.id" class="border-b border-border last:border-b-0">
                <th scope="row" class="pin-start px-3 py-2 text-left font-medium [--pin-max:15rem]">
                  <span class="block truncate" :title="session.name">{{ session.name || session.id }}</span>
                  <span class="block font-mono text-xs font-normal text-muted-foreground">{{ shortId(session.id, 10) }}</span>
                </th>
                <td class="px-3 py-2">
                  <Badge :variant="session.state === 'running' ? 'info' : 'secondary'">{{ $t(`platform.trace.sessionState.${session.state}`) }}</Badge>
                </td>
                <td class="max-w-48 px-3 py-2 text-xs"><span class="block truncate" :title="sessionNodes(session)">{{ sessionNodes(session) }}</span></td>
                <td class="px-3 py-2 font-mono text-xs">{{ session.level }}</td>
                <td class="px-3 py-2 font-mono text-xs whitespace-nowrap tabular">{{ formatDateTime(session.expires_at) }}</td>
                <td class="px-3 py-2 text-right font-mono text-xs tabular">{{ session.lines }}</td>
                <td class="px-3 py-2 text-right font-mono text-xs tabular">
                  <RouterLink v-if="session.records > 0" :to="recordsLink(session)" class="text-primary hover:underline">{{ session.records }}</RouterLink>
                  <span v-else class="text-muted-foreground">0</span>
                </td>
                <!-- Dropped is never hidden: a capture that lost lines under
                     budget otherwise reads as a quiet network. -->
                <td class="px-3 py-2 text-right font-mono text-xs tabular">
                  <span v-if="session.dropped > 0" class="font-medium text-warning-text" :title="$t('platform.trace.droppedHint')">{{ session.dropped }}</span>
                  <span v-else class="text-muted-foreground">0</span>
                </td>
                <td class="pin-end px-3 py-2">
                  <div v-if="session.state === 'running'" class="flex justify-end gap-1">
                    <Button variant="outline" size="sm" @click="tailSessionId === session.id ? stopTail() : startTail(session.id)">
                      <ScrollText aria-hidden="true" class="size-4" />
                      <span class="max-sm:sr-only">{{ tailSessionId === session.id ? $t('platform.trace.tailStop') : $t('platform.trace.tailStart') }}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      :disabled="!ctx.canAdmin.value || stoppingId === session.id"
                      :title="adminReason"
                      @click="stopSession(session)"
                    >
                      <CircleStop aria-hidden="true" class="size-4" />
                      <span class="max-sm:sr-only">{{ $t('platform.trace.sessionStop') }}</span>
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>

      <!-- Live tail -->
      <div v-if="tailSessionId" class="space-y-2 rounded-md border border-border p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">{{ $t('platform.trace.tailTitle', { name: tailSession?.name || tailSessionId }) }}</p>
          <p class="text-xs text-muted-foreground">
            {{ $t('platform.trace.tailHint') }}
            <span v-if="tailSession && tailSession.dropped > 0" class="text-warning-text">{{ $t('platform.trace.tailDropped', { dropped: tailSession.dropped }) }}</span>
          </p>
        </div>
        <p v-if="tailError" class="text-xs text-destructive">{{ tailError.message }}</p>
        <div class="max-h-96 overflow-auto rounded-md border border-border bg-muted/10">
          <table class="w-full text-xs">
            <tbody class="font-mono">
              <tr v-for="line in tailLines" :key="`${line.session_id}:${line.seq}`" class="border-b border-border align-top last:border-b-0">
                <td class="px-3 py-1 whitespace-nowrap text-muted-foreground tabular">{{ line.seq }}</td>
                <td class="px-3 py-1 whitespace-nowrap text-muted-foreground">{{ formatDateTime(line.at) }}</td>
                <td class="px-3 py-1 whitespace-nowrap text-muted-foreground">{{ line.level }}</td>
                <td class="px-3 py-1"><span class="break-all whitespace-pre-wrap">{{ line.raw || line.message }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="tailLines.length === 0" class="text-xs text-muted-foreground">{{ $t('platform.trace.tailWaiting') }}</p>
      </div>
    </section>

    <!-- ── Raw log sources ───────────────────────────────────────────── -->
    <EvidenceLogSources />
  </div>
</template>
