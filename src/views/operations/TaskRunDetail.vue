<script setup lang="ts">
/**
 * One run, as the Tasks sheet shows it (design 23, section 4.3): what it
 * was, where it came from, and what every target answered, with failed
 * targets opened to their stderr so the reason is on screen without a
 * click. Full output is read for this run alone; the list's poll carries no
 * bodies.
 *
 * The script stays behind a second factor (Reveal script), as it always
 * has: a task script can hold credentials, and the list carries only its
 * digest.
 *
 * Rerun this node asks the page (`rerunNode`), which confirms with a
 * preview before anything is queued: a rerun runs on the host now.
 */
import { computed, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { ChevronDown, KeyRound, Lock, RefreshCw, RotateCcw } from "lucide-vue-next";

import { api, unwrap, type Node, type TaskResult, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useStepUp } from "@/composables/useStepUp";
import { formatBytes, formatDateTime, shortId } from "@/lib/format";
import { leaseAttemptLabel, stalledText, taskLeaseProgress, taskStateStyle, type TaskLeaseProgress } from "@/lib/taskLease";
import { cn } from "@/lib/utils";

import CopyButton from "@/components/common/CopyButton.vue";
import DataState from "@/components/common/DataState.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";

import { failureReason, latestByNode, readTimeout, resultFailed, RESULT_PAGE_LIMIT, taskLive } from "./tasksModel";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "warning";
type NodeRunStatus = "queued" | "leased" | "finished" | "failed" | "cancelled" | "expired" | "stalled";

const props = defineProps<{
  task: TaskView;
  nodes: Node[];
  /** The plan that queued it, when the page could read its title. */
  planTitle?: string | null;
  /** Reruns of this run among the rows on screen. */
  reruns: TaskView[];
  canRun: boolean;
  executionDisabled: boolean;
  /** An action on this run is in flight on the page. */
  busy?: boolean;
}>();

/** The node to rerun, and the button that asked, for focus to return to. */
const emit = defineEmits<{ rerunNode: [nodeId: string, opener: HTMLElement] }>();

const { t } = useI18n();

const nodesById = computed<Record<string, Node>>(() => Object.fromEntries(props.nodes.map((n) => [n.id, n])));

/**
 * Full output for this run alone. A settled run does not change, so it is
 * read once; a live one is read again every 10 s while the sheet is open.
 * Bodies run to 64 KB per target, so re-reading a settled fan-out on a
 * timer would cost megabytes for nothing.
 */
const live = computed(() => taskLive(props.task.status));

const resultsQuery = useAsyncData<TaskResult[]>(
  (signal) => api.tasks.results({ task_id: props.task.id, limit: RESULT_PAGE_LIMIT }, { signal }).then((r) => unwrap(r, "results") ?? []),
);
const timer = setInterval(() => {
  if (live.value && document.visibilityState !== "hidden") void resultsQuery.refresh();
}, 10_000);
onScopeDispose(() => clearInterval(timer));
watch(
  () => props.task.id,
  () => {
    expanded.value = new Set();
    collapsed.value = new Set();
    revealed.value = null;
    void resultsQuery.refresh();
  },
);
watch(
  () => props.task.status,
  (status, before) => {
    if (status !== before) void resultsQuery.refresh();
  },
);

const latest = computed(() => latestByNode((resultsQuery.data.value ?? []).filter((r) => r.task_id === props.task.id)));

interface NodeRow {
  nodeId: string;
  node?: Node;
  result?: TaskResult;
  status: NodeRunStatus;
  lease?: TaskLeaseProgress;
}

const rows = computed<NodeRow[]>(() =>
  [...new Set(props.task.targets)].map((nodeId) => {
    const result = latest.value.get(nodeId);
    const lease = taskLeaseProgress(props.task, nodeId);
    const leaseStatus = lease?.status ?? props.task.status;
    const status: NodeRunStatus = result
      ? resultFailed(result)
        ? "failed"
        : "finished"
      : props.task.status === "expired"
        ? "expired"
        : props.task.status === "failed"
          ? "failed"
          : props.task.status === "cancelled"
            ? "cancelled"
            : leaseStatus === "stalled" || leaseStatus === "leased" || leaseStatus === "failed" || leaseStatus === "finished"
              ? leaseStatus
              : "queued";
    return { nodeId, node: nodesById.value[nodeId], result, status, lease };
  }),
);

/** Failed targets first: the sheet is opened to read why. */
const orderedRows = computed(() => {
  const rank: Record<NodeRunStatus, number> = { failed: 0, stalled: 1, leased: 2, queued: 3, expired: 4, cancelled: 5, finished: 6 };
  return [...rows.value].sort((a, b) => rank[a.status] - rank[b.status]);
});

const counts = computed(() => {
  const list = rows.value;
  return {
    total: list.length,
    passed: list.filter((row) => row.status === "finished").length,
    failed: list.filter((row) => row.status === "failed").length,
    reported: list.filter((row) => row.result).length,
  };
});

/** Rows the operator opened or closed by hand; failed rows start open. */
const expanded = ref<Set<string>>(new Set());
const collapsed = ref<Set<string>>(new Set());

function isOpen(row: NodeRow): boolean {
  if (collapsed.value.has(row.nodeId)) return false;
  return row.status === "failed" || expanded.value.has(row.nodeId);
}

function toggle(row: NodeRow): void {
  const open = isOpen(row);
  const nextOpen = new Set(expanded.value);
  const nextClosed = new Set(collapsed.value);
  if (open) {
    nextOpen.delete(row.nodeId);
    nextClosed.add(row.nodeId);
  } else {
    nextClosed.delete(row.nodeId);
    nextOpen.add(row.nodeId);
  }
  expanded.value = nextOpen;
  collapsed.value = nextClosed;
}

function statusVariant(status: string): BadgeVariant {
  return taskStateStyle(status).variant;
}

function statusLabel(status: string): string {
  return t(`operations.tasks.status.${status}`);
}

function exitWord(code: number): string {
  return t("operations.tasks.exit", { code });
}

function leaseText() {
  return {
    leasedFor: (age: string) => t("operations.tasks.leasedFor", { age }),
    attemptOf: (attempt: number, max: number) => t("operations.tasks.attemptOf", { attempt, max }),
    duration: {
      days: (n: number) => t("common.duration.days", { n }),
      hours: (n: number) => t("common.duration.hours", { n }),
      minutes: (n: number) => t("common.duration.minutes", { n }),
      seconds: (n: number) => t("common.duration.seconds", { n }),
    },
    stalledNoLease: t("operations.tasks.stalledNoLease"),
  };
}

/** What a target that answered nothing is doing, in one line. */
function resultlessText(row: NodeRow): string {
  if (row.status === "queued") return t("operations.tasks.waitingLease");
  const text = leaseText();
  if (row.status === "leased") {
    const lease = leaseAttemptLabel(row.lease, text);
    return lease ? `${t("operations.tasks.running")} · ${lease}` : t("operations.tasks.running");
  }
  if (row.status === "stalled") return stalledText(row.lease, text);
  if (row.status === "cancelled") return t("operations.tasks.cancelledNoResult");
  if (row.status === "expired") return t("operations.tasks.sheet.expiredNoResult");
  return t("operations.tasks.failedNoResult");
}

function rowLine(row: NodeRow): string {
  if (!row.result) return resultlessText(row);
  if (row.status === "failed") return failureReason(row.result, exitWord);
  return `${exitWord(row.result.exit_code ?? 0)} · ${formatDateTime(row.result.finished_at)}`;
}

/**
 * Whether a target's agent could have measured anything privileged.
 *
 * A survey script that probes root-only state (`sshd -T` needs to read host
 * keys, `nft list table` needs CAP_NET_ADMIN) returns nothing at all on an
 * unprivileged agent. If that script swallows stderr - and shell scripts
 * written as `echo "k=$(cmd 2>/dev/null)"` almost always do - the node reports
 * empty fields and exit 0, which is indistinguishable from "measured, and the
 * answer is nothing". A whole fleet audit can be read off a wall of green
 * "Finished" rows that measured none of what it claims.
 *
 * The agent already reports this: SandboxProfile appends `non-root-agent` when
 * its euid is not 0, and warns "task scripts run as root" when it is. The fact
 * existed on the node record and was rendered on the node page, one click away
 * from the results it qualifies. This puts it next to the output.
 *
 * Caveat, and the reason this is not the whole fix: `agent_runtime` is the
 * agent's CURRENT state, not its state when the task ran. An agent restarted
 * with different flags since then will describe the wrong run. Pinning the
 * context onto TaskResult is what makes this audit-grade; this makes it useful
 * today, including for tasks that already ran.
 */
type ExecContext = { kind: "root" | "unprivileged" | "exec-disabled"; label: string; hint: string };

function execContext(node?: Node, result?: TaskResult): ExecContext | undefined {
  // Prefer what the server pinned when this result landed. The node's live
  // runtime is a fallback for results recorded before the pin existed, and it
  // describes the agent as it is now, which is not necessarily how it was.
  const pinned = result?.exec_context;
  const runtime = pinned
    ? {
        no_exec: pinned.exec_disabled,
        allow_exec: !pinned.exec_disabled,
        allow_root_exec: pinned.root_exec,
        task_sandbox_features: pinned.non_root ? ["non-root-agent"] : [],
        reported_at: pinned.reported_at ?? "pinned",
      }
    : node?.agent_runtime;
  if (!runtime || !runtime.reported_at) return undefined;
  if (runtime.no_exec || runtime.allow_exec === false) {
    return {
      kind: "exec-disabled",
      label: t("operations.tasks.execContext.disabled"),
      hint: t("operations.tasks.execContext.disabledHint"),
    };
  }
  if (runtime.task_sandbox_features?.includes("non-root-agent")) {
    return {
      kind: "unprivileged",
      label: t("operations.tasks.execContext.unprivileged"),
      hint: t("operations.tasks.execContext.unprivilegedHint"),
    };
  }
  if (runtime.allow_root_exec) {
    return {
      kind: "root",
      label: t("operations.tasks.execContext.root"),
      hint: t("operations.tasks.execContext.rootHint"),
    };
  }
  return undefined;
}

function execContextVariant(kind: ExecContext["kind"]): BadgeVariant {
  // Unprivileged is the one that silently invalidates results, so it is the one
  // that gets attention. Running as root is worth stating but is not a fault.
  return kind === "unprivileged" ? "destructive" : "outline";
}

/* ------------------------------------------------------------------ */
/* Reveal the script                                                   */
/* ------------------------------------------------------------------ */

const stepUp = useStepUp({
  required: t("operations.tasks.stepUpRequired"),
  failed: t("operations.tasks.stepUpFailed"),
  passkeyFailed: t("operations.tasks.stepUpPasskeyFailed"),
});
const stepUpOpen = stepUp.open;
const stepUpCode = stepUp.code;
const stepUpError = stepUp.error;
const stepUpPending = stepUp.pending;

const revealed = ref<{ id: string; script: string } | null>(null);
const revealing = ref(false);

async function revealScript(): Promise<void> {
  if (revealed.value?.id === props.task.id) {
    revealed.value = null;
    return;
  }
  if (revealing.value) return;
  revealing.value = true;
  try {
    const grant = await stepUp.request();
    const result = await api.tasks.revealScript(props.task.id, grant);
    revealed.value = { id: props.task.id, script: result.script };
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastRevealScriptFailed"));
  } finally {
    revealing.value = false;
  }
}

const shownScript = computed(() => (revealed.value?.id === props.task.id ? revealed.value.script : ""));

function originText(): string {
  const task = props.task;
  if (task.origin === "rerun" || task.rerun_of_task_id) return t("operations.tasks.origin.rerun");
  if (task.origin === "approval" || task.approval_id) return t("operations.tasks.origin.approval");
  return t("operations.tasks.origin.direct");
}
</script>

<template>
  <div class="space-y-6" data-testid="task-run-detail">
    <dl class="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.tasks.colStatus') }}</dt>
        <dd><Badge :variant="statusVariant(task.status)">{{ statusLabel(task.status) }}</Badge></dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.tasks.sheet.targets') }}</dt>
        <dd class="tabular">
          {{ $t('operations.tasks.passCount', { passed: counts.passed, total: counts.total }) }}
          <span v-if="counts.failed" class="text-destructive"> · {{ $t('operations.tasks.failedCount', { count: counts.failed }) }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.tasks.sheet.queued') }}</dt>
        <dd class="tabular" :title="task.created_at">{{ formatDateTime(task.created_at) }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.tasks.sheet.finished') }}</dt>
        <dd class="tabular" :title="task.finished_at">{{ task.finished_at ? formatDateTime(task.finished_at) : $t('operations.tasks.sheet.notFinished') }}</dd>
      </div>
      <div class="sm:col-span-2">
        <dt class="text-xs text-muted-foreground">{{ $t('operations.tasks.sheet.origin') }}</dt>
        <dd class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span>{{ originText() }}</span>
          <RouterLink
            v-if="task.approval_id"
            :to="{ name: 'approvals', query: { open: task.approval_id } }"
            class="min-w-0 truncate rounded-sm text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            :title="task.approval_id"
            data-testid="task-plan-link"
          >
            {{ planTitle || shortId(task.approval_id, 14) }}
          </RouterLink>
          <RouterLink
            v-if="task.rerun_of_task_id"
            :to="{ name: 'tasks', query: { open: task.rerun_of_task_id } }"
            class="rounded-sm font-mono text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            :title="task.rerun_of_task_id"
          >
            {{ shortId(task.rerun_of_task_id, 12) }}
          </RouterLink>
          <span v-if="task.rerun_of_node_id" class="text-xs text-muted-foreground">
            {{ $t('operations.tasks.sheet.oneNode') }} <NodeLabel :id="task.rerun_of_node_id" />
          </span>
          <span v-if="task.actor_id" class="text-xs text-muted-foreground">· {{ task.actor_id }}</span>
        </dd>
      </div>
      <div class="sm:col-span-2">
        <dt class="text-xs text-muted-foreground">{{ $t('operations.tasks.sheet.script') }}</dt>
        <dd class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="text-xs">{{ task.interpreter }} · {{ formatBytes(task.script_size_bytes) }}<template v-if="readTimeout(task) !== undefined"> · {{ $t('operations.tasks.sheet.timeout', { n: readTimeout(task) }) }}</template></span>
          <code v-if="task.script_sha256" class="min-w-0 truncate font-mono text-xs text-muted-foreground" :title="task.script_sha256">sha256 {{ shortId(task.script_sha256, 12) }}</code>
          <Button variant="outline" size="sm" type="button" :disabled="revealing" @click="revealScript">
            <RefreshCw v-if="revealing" class="size-4 animate-spin" aria-hidden="true" />
            <KeyRound v-else class="size-4" aria-hidden="true" />
            {{ shownScript ? $t('operations.tasks.hideScript') : $t('operations.tasks.revealScript') }}
          </Button>
        </dd>
      </div>
    </dl>

    <div v-if="shownScript" class="rounded-md border border-border bg-muted/20 p-3">
      <div class="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span class="inline-flex items-center gap-1">
          <Lock class="size-3.5" aria-hidden="true" />
          {{ $t('operations.tasks.scriptRevealed') }}
        </span>
        <CopyButton :value="shownScript" />
      </div>
      <pre class="relative max-h-64 overflow-auto rounded bg-background/70 p-3 font-mono text-xs">{{ shownScript }}</pre>
    </div>

    <section class="space-y-2" :aria-label="$t('operations.tasks.sheet.perNode')">
      <h3 class="text-sm font-medium">{{ $t('operations.tasks.sheet.perNode') }}</h3>
      <DataState
        :loading="resultsQuery.loading.value"
        :error="resultsQuery.error.value"
        :has-data="resultsQuery.data.value !== undefined"
        @retry="resultsQuery.refresh"
      >
        <ul class="divide-y divide-border rounded-md border border-border" data-testid="task-node-results">
          <li v-for="row in orderedRows" :key="row.nodeId" class="min-w-0" :data-node="row.nodeId">
            <div class="flex min-w-0 items-start gap-2 px-3 py-2.5">
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge :variant="statusVariant(row.status)">{{ statusLabel(row.status) }}</Badge>
                  <NodeLabel :id="row.nodeId" link class="text-sm font-medium" />
                  <Badge
                    v-if="execContext(row.node, row.result)"
                    :variant="execContextVariant(execContext(row.node, row.result)!.kind)"
                    :title="execContext(row.node, row.result)!.hint"
                  >
                    {{ execContext(row.node, row.result)!.label }}
                  </Badge>
                </div>
                <p :class="cn('break-words font-mono text-xs', row.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')">{{ rowLine(row) }}</p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  v-if="row.status === 'failed' && canRun"
                  variant="outline"
                  size="sm"
                  type="button"
                  :disabled="executionDisabled || busy"
                  @click="(e: MouseEvent) => emit('rerunNode', row.nodeId, e.currentTarget as HTMLElement)"
                >
                  <RotateCcw class="size-4" aria-hidden="true" />
                  <span class="sr-only sm:not-sr-only">{{ $t('operations.tasks.actions.rerunNode') }}</span>
                </Button>
                <Button
                  v-if="row.result"
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  :aria-expanded="isOpen(row)"
                  :aria-label="isOpen(row) ? $t('operations.tasks.collapseResults') : $t('operations.tasks.expandResults')"
                  @click="toggle(row)"
                >
                  <ChevronDown :class="cn('size-4 transition-transform', isOpen(row) && 'rotate-180')" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div v-if="row.result && isOpen(row)" class="space-y-2 px-3 pb-3">
              <pre v-if="row.result.stderr" class="relative max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/10 p-3 text-xs text-destructive">{{ row.result.stderr }}</pre>
              <pre v-if="row.result.stdout" class="relative max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{{ row.result.stdout }}</pre>
              <p v-if="!row.result.stdout && !row.result.stderr" class="text-xs text-muted-foreground">
                {{ $t('operations.tasks.sheet.noOutput') }}
              </p>
            </div>
          </li>
        </ul>
      </DataState>
    </section>

    <section v-if="reruns.length" class="space-y-2">
      <h3 class="text-sm font-medium">{{ $t('operations.tasks.sheet.reruns') }}</h3>
      <ul class="space-y-1 text-sm">
        <li v-for="rerun in reruns" :key="rerun.id" class="flex flex-wrap items-center gap-2">
          <Badge :variant="statusVariant(rerun.status)">{{ statusLabel(rerun.status) }}</Badge>
          <RouterLink
            :to="{ name: 'tasks', query: { open: rerun.id } }"
            class="rounded-sm font-mono text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {{ shortId(rerun.id, 12) }}
          </RouterLink>
          <span class="text-xs text-muted-foreground">{{ formatDateTime(rerun.created_at) }}</span>
        </li>
      </ul>
    </section>

    <Dialog v-model:open="stepUpOpen">
      <DialogScrollContent class="sm:max-w-md" @escape-key-down.prevent="stepUp.cancel">
        <DialogHeader>
          <DialogTitle>{{ $t('operations.tasks.stepUpTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('operations.tasks.stepUpDescription') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="stepUp.submitTotp">
          <div class="grid gap-2">
            <Label for="task-step-up-code">{{ $t('operations.tasks.stepUpCode') }}</Label>
            <Input id="task-step-up-code" v-model="stepUpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123456" />
            <p v-if="stepUpError" class="text-xs text-destructive">{{ stepUpError }}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="stepUp.cancel">{{ $t('common.actions.cancel') }}</Button>
            <Button type="button" variant="outline" :disabled="!!stepUpPending || !stepUp.supportsPasskey" @click="stepUp.submitPasskey">
              <RefreshCw v-if="stepUpPending === 'passkey'" class="size-4 animate-spin" aria-hidden="true" />
              <KeyRound v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.tasks.stepUpPasskey') }}
            </Button>
            <Button type="submit" :disabled="!!stepUpPending || !stepUpCode.trim()">
              <RefreshCw v-if="stepUpPending === 'totp'" class="size-4 animate-spin" aria-hidden="true" />
              <Lock v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.tasks.stepUpSubmit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
