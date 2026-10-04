<script setup lang="ts">
/**
 * One plan, as the Approvals sheet shows it (design 23, section 4.3): who
 * wrote it and for which node, why an approved plan has not applied (every
 * sentence from the control plane), the plan as a diff against what is live,
 * the hash of the bytes on screen beside the server's, and the tasks it
 * queued. The decision row lives in the sheet's footer, owned by the page.
 *
 * Reads of its own: the applied plans of the same node and plugin, once per
 * target, for the diff baseline; and the tasks queued by this plan, through
 * GET /api/tasks?approval_id=.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, ArchiveX, Clock, ExternalLink, FileCode2, GitCompare, RefreshCw, ServerOff } from "lucide-vue-next";

import { api, unwrap, type ApprovalView, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { approvalStatusMeta } from "@/lib/status";
import { approvalPlanSummary } from "@/lib/approvalKind";
import { describeNodeStatus } from "@/lib/nodeStatus";
import { formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { taskStateStyle } from "@/lib/taskLease";
import { looksLikeShell } from "@/lib/shellTokens";
import { cn } from "@/lib/utils";

import CopyButton from "@/components/common/CopyButton.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import PlanDiff from "@/components/common/PlanDiff.vue";
import ScriptView from "@/components/common/ScriptView.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { approvalWaitLabelKey, approvalWaitTone, approvalWaitWayKey, isApprovalStuck } from "./approvalsModel";
import { baselineKey, baselineParams, previousAppliedPlan } from "./approvalsListModel";
import { normalizeTaskPage } from "./tasksModel";

const props = defineProps<{
  approval: ApprovalView;
  /** Whether the plan text is in hand, being read, or failed to read. */
  planState: "ready" | "loading" | "error";
  planError?: string | null;
  /** An agent-update plan that no longer matches policy. */
  stale: boolean;
  staleReason: string;
  /** The server's own English for the stale reason, shown in mono under the translation. */
  staleRaw?: string;
  canReplan: boolean;
  canDismissStale: boolean;
  canDismissWaiting: boolean;
  dismissing: boolean;
  replanning: boolean;
  /** The last decision on this plan failed, with this message. */
  decisionError?: string | null;
}>();

const emit = defineEmits<{
  retryPlan: [];
  dismissWaiting: [];
  dismissStale: [];
  replan: [];
  openApproval: [id: string];
}>();

const { t } = useI18n();

/* ------------------------------------------------------------------ */
/* Why an approved plan has not applied                                */
/* ------------------------------------------------------------------ */

const waiting = computed(() => (props.approval.status === "approved" ? props.approval.waiting : undefined));
/** The plan's own sentence, when it is JSON that carries one ("Add alice to hk-reality on [cd]-hkg"). */
const planSummary = computed(() => approvalPlanSummary(props.approval.plan));
const stuck = computed(() => isApprovalStuck(props.approval));
const moving = computed(() => props.approval.status === "approved" && !!props.approval.waiting && !props.approval.waiting.blocked);

function waitingVariant(): "warning" | "destructive" | "outline" {
  if (!waiting.value) return "outline";
  const tone = approvalWaitTone(waiting.value);
  return tone === "destructive" ? "destructive" : tone === "warning" ? "warning" : "outline";
}

/* ------------------------------------------------------------------ */
/* The plan, its baseline and its hash                                 */
/* ------------------------------------------------------------------ */

const planView = ref<"diff" | "full">("diff");
/** Coloured only when the plan declares itself shell (lib/shellTokens, looksLikeShell); no server-rendered plan does today. */
const planLanguage = computed(() => (looksLikeShell(props.approval.plan || "") ? "shell" : "plain"));

const baselines = ref<Record<string, ApprovalView[]>>({});
async function loadBaseline(row: ApprovalView): Promise<void> {
  const key = baselineKey(row);
  if (baselines.value[key]) return;
  try {
    const rows = unwrap(await api.approvals.list(baselineParams(row)), "approvals");
    baselines.value = { ...baselines.value, [key]: rows };
  } catch {
    // The diff then says there is no prior applied plan; the next open tries again.
  }
}
watch(
  () => baselineKey(props.approval),
  () => void loadBaseline(props.approval),
  { immediate: true },
);
const previousPlan = computed(() => previousAppliedPlan(props.approval, baselines.value[baselineKey(props.approval)] ?? []));

const { digestFor } = usePlanDigest();
const localDigest = ref<{ id: string; sha: string } | null>(null);
watch(
  () => [props.approval.id, props.approval.plan] as const,
  async ([id, plan]) => {
    if (plan === undefined) return;
    const sha = await digestFor({ id, plan });
    if (props.approval.id === id) localDigest.value = { id, sha };
  },
  { immediate: true },
);
const shownDigest = computed(() => (localDigest.value?.id === props.approval.id ? localDigest.value.sha : ""));
const digestMismatch = computed(() => !!shownDigest.value && !!props.approval.plan_sha256 && shownDigest.value !== props.approval.plan_sha256);

/* ------------------------------------------------------------------ */
/* The tasks it queued                                                 */
/* ------------------------------------------------------------------ */

/** A pending or rejected-before-approval plan never queued anything. */
const mayHaveTasks = computed(() => props.approval.status !== "pending");

const tasksQuery = useAsyncData<TaskView[]>(
  async (signal) => {
    if (!mayHaveTasks.value) return [];
    const params = { approval_id: props.approval.id, limit: 20, offset: 0 };
    return normalizeTaskPage(await api.tasks.query(params, { signal }), params).tasks;
  },
  { pollInterval: 15_000 },
);
watch(
  () => props.approval.id,
  () => void tasksQuery.refresh(),
);
const tasksForbidden = computed(() => (tasksQuery.error.value as { status?: number } | undefined)?.status === 403);

function statusLabel(status: string): string {
  return t(`common.status.${status}`);
}
</script>

<template>
  <div class="space-y-6" data-testid="approval-review">
    <p v-if="planSummary" class="break-words text-sm text-foreground" data-testid="approval-summary">{{ planSummary }}</p>
    <!-- Two columns at every width: one field per row at 375 stacked six
         rows and pushed the plan, the thing being decided, below the fold. -->
    <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm [&>div]:min-w-0 [&_dd]:break-words">
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.approvals.columns.status') }}</dt>
        <dd class="flex flex-wrap items-center gap-1">
          <Badge v-if="stale" variant="outline">{{ $t('operations.approvals.staleBadge') }}</Badge>
          <Badge v-else :variant="approvalStatusMeta(approval.status).badgeVariant">{{ statusLabel(approval.status) }}</Badge>
          <Badge v-if="stuck" :variant="waitingVariant()">{{ $t('operations.approvals.waiting.stuckBadge') }}</Badge>
          <Badge v-else-if="moving" variant="outline">{{ $t('operations.approvals.waiting.movingBadge') }}</Badge>
        </dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.approvals.columns.target') }}</dt>
        <dd>
          <NodeLabel v-if="approval.node_id" :id="approval.node_id" link />
          <span v-else class="text-muted-foreground">{{ $t('common.misc.global') }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.approvals.sheet.writer') }}</dt>
        <dd>{{ approval.actor_id || $t('operations.approvals.events.unknownWriter') }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.approvals.sheet.decided') }}</dt>
        <dd>
          <template v-if="approval.approved_by">{{ $t('operations.approvals.sheet.approvedBy', { actor: approval.approved_by }) }}</template>
          <template v-else-if="approval.rejected_by">{{ $t('operations.approvals.sheet.rejectedBy', { actor: approval.rejected_by }) }}</template>
          <span v-else class="text-muted-foreground">{{ $t('operations.approvals.sheet.notDecided') }}</span>
        </dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.approvals.sheet.created') }}</dt>
        <dd class="tabular" :title="approval.created_at">{{ formatDateTime(approval.created_at) }}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">{{ $t('operations.approvals.sheet.updated') }}</dt>
        <dd class="tabular" :title="approval.updated_at">{{ formatDateTime(approval.updated_at) }}</dd>
      </div>
    </dl>

    <!-- Approved says nothing about what happens next; every sentence here
         comes from the control plane. -->
    <section
      v-if="approval.status === 'approved'"
      :class="cn('rounded-md border p-3 text-sm text-muted-foreground', stuck ? 'border-warning/40 bg-warning/5' : 'border-border bg-muted/20')"
      data-testid="approval-waiting"
    >
      <div class="flex flex-wrap items-start justify-between gap-2">
        <p class="flex min-w-0 items-center gap-2 font-medium text-foreground">
          <ServerOff v-if="stuck" class="size-4 shrink-0 text-warning-text" aria-hidden="true" />
          <Clock v-else-if="moving" class="size-4 shrink-0" aria-hidden="true" />
          <AlertTriangle v-else class="size-4 shrink-0 text-warning-text" aria-hidden="true" />
          <span class="min-w-0 break-words">
            {{ stuck ? $t('operations.approvals.waiting.blockedTitle') : moving ? $t('operations.approvals.waiting.movingTitle') : $t('operations.approvals.waiting.unexplainedTitle') }}
          </span>
        </p>
        <Badge v-if="waiting" :variant="waitingVariant()" class="shrink-0">{{ $t(approvalWaitLabelKey(waiting.code)) }}</Badge>
      </div>
      <p class="mt-1">{{ $t('operations.approvals.waiting.approvedAge', { age: formatRelativeTime(approval.updated_at || approval.created_at) }) }}</p>
      <template v-if="waiting">
        <p class="mt-3 text-xs font-medium text-muted-foreground">{{ $t('operations.approvals.waiting.evidence') }}</p>
        <p class="mt-1 break-words text-foreground">{{ waiting.reason }}</p>
        <template v-if="waiting.node_status">
          <p class="mt-3 text-xs font-medium text-muted-foreground">{{ $t('operations.approvals.waiting.nodeHeading') }}</p>
          <p class="mt-1 flex flex-wrap items-center gap-2">
            <NodeLabel :id="waiting.node_id || approval.node_id" class="font-medium text-foreground" />
            <Badge variant="outline">{{ $t(describeNodeStatus(waiting.node_status).labelKey) }}</Badge>
            <span v-if="waiting.node_status_since" class="text-xs">{{ formatDateTime(waiting.node_status_since) }}</span>
          </p>
          <p v-if="waiting.node_status_reason" class="mt-1 break-words text-xs">{{ waiting.node_status_reason }}</p>
        </template>
        <p class="mt-3 text-xs font-medium text-muted-foreground">{{ $t('operations.approvals.waiting.wayOutHeading') }}</p>
        <p class="mt-1 break-words">{{ $t(approvalWaitWayKey(waiting.code)) }}</p>
      </template>
      <p v-else class="mt-2 break-words">{{ $t('operations.approvals.waiting.unexplainedBody') }}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button v-if="waiting?.node_id" variant="outline" size="sm" as-child>
          <RouterLink :to="{ name: 'node-detail', params: { id: waiting.node_id } }">
            <ExternalLink class="size-4" aria-hidden="true" />
            {{ $t('operations.approvals.waiting.openNode') }}
          </RouterLink>
        </Button>
        <Button v-if="waiting?.superseded_by" type="button" variant="outline" size="sm" @click="emit('openApproval', waiting.superseded_by)">
          <FileCode2 class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.waiting.openSuperseding') }}
        </Button>
        <Button v-if="canDismissWaiting" type="button" variant="ghost" size="sm" :disabled="dismissing" @click="emit('dismissWaiting')">
          <RefreshCw v-if="dismissing" class="size-4 animate-spin" aria-hidden="true" />
          <ArchiveX v-else class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.waiting.dismiss') }}
        </Button>
      </div>
      <p v-if="stuck && !canDismissWaiting" class="mt-2 text-xs">{{ $t('operations.approvals.waiting.notDismissible') }}</p>
    </section>

    <section v-if="stale" class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground" data-testid="approval-stale">
      <p class="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle class="size-4 text-warning-text" aria-hidden="true" />
        {{ $t('operations.approvals.staleTitle') }}
      </p>
      <p class="mt-1">{{ $t('operations.approvals.staleDescription') }}</p>
      <p class="mt-2 text-xs font-medium text-muted-foreground">{{ $t('operations.approvals.rejectionReason') }}</p>
      <p class="mt-1 break-words">{{ staleReason }}</p>
      <p v-if="staleRaw && staleRaw !== staleReason" class="mt-1 break-words font-mono text-xs" data-testid="approval-stale-raw">{{ staleRaw }}</p>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button v-if="canReplan" type="button" variant="outline" size="sm" :disabled="replanning" @click="emit('replan')">
          <RefreshCw v-if="replanning" class="size-4 animate-spin" aria-hidden="true" />
          <FileCode2 v-else class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.replanAgentUpdate') }}
        </Button>
        <Button v-if="canDismissStale" type="button" variant="ghost" size="sm" :disabled="dismissing" @click="emit('dismissStale')">
          <RefreshCw v-if="dismissing" class="size-4 animate-spin" aria-hidden="true" />
          <ArchiveX v-else class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.dismissStale') }}
        </Button>
      </div>
    </section>
    <section v-else-if="approval.status === 'pending' && approval.reason" class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
      <p class="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle class="size-4 text-warning-text" aria-hidden="true" />
        {{ $t('operations.approvals.approvalNote') }}
      </p>
      <p class="mt-1 break-words">{{ approval.reason }}</p>
    </section>
    <section v-else-if="approval.status === 'rejected' && approval.reason" class="rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
      <p class="font-medium text-foreground">{{ $t('operations.approvals.rejectionReason') }}</p>
      <p class="mt-1 break-words">{{ approval.reason }}</p>
    </section>

    <section class="space-y-2" :aria-label="$t('operations.approvals.plan')">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-medium">{{ $t('operations.approvals.plan') }}</h3>
        <div class="flex items-center gap-1">
          <Button
            :variant="planView === 'diff' ? 'secondary' : 'ghost'"
            size="sm"
            type="button"
            :aria-pressed="planView === 'diff'"
            @click="planView = 'diff'"
          >
            <GitCompare class="size-3.5" aria-hidden="true" />
            {{ $t('operations.approvals.viewDiff') }}
          </Button>
          <Button :variant="planView === 'full' ? 'secondary' : 'ghost'" size="sm" type="button" :aria-pressed="planView === 'full'" @click="planView = 'full'">
            {{ $t('operations.approvals.viewFull') }}
          </Button>
          <CopyButton :value="approval.plan || ''" />
        </div>
      </div>
      <div
        v-if="planState === 'loading'"
        class="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-6 text-sm text-muted-foreground"
        data-plan-state="loading"
      >
        <RefreshCw class="size-4 animate-spin" aria-hidden="true" />
        {{ $t('operations.approvals.planLoading') }}
      </div>
      <div
        v-else-if="planState === 'error'"
        class="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-muted-foreground"
        data-plan-state="error"
      >
        <p class="break-words">{{ $t('operations.approvals.planLoadFailed', { message: planError ?? '' }) }}</p>
        <Button type="button" variant="outline" size="sm" @click="emit('retryPlan')">
          <RefreshCw class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.history.retry') }}
        </Button>
      </div>
      <template v-else-if="planView === 'diff'">
        <p class="text-xs text-muted-foreground">
          {{ previousPlan ? $t('operations.approvals.diffAgainstApplied') : $t('operations.approvals.diffNoPrior') }}
        </p>
        <PlanDiff :before="previousPlan" :after="approval.plan || ''" />
      </template>
      <!-- The plan exactly as hashed, with line numbers and wrap. The plans
           the server renders (SSH Guard and witness prose with key-value
           lines and file sections, line-chain JSON, nft rulesets, DNS and
           agent-update key-value) are shown without colour; colour turns on
           only for a plan that declares itself shell (a shell shebang or a
           leading `set -X`). The header's Copy covers both views. -->
      <ScriptView
        v-else
        :text="approval.plan || ''"
        :language="planLanguage"
        wrap
        :copy="false"
        max-height="520px"
        :label="$t('operations.approvals.plan')"
      />
    </section>

    <section class="space-y-1 text-xs" data-testid="approval-hash">
      <h3 class="text-sm font-medium">{{ $t('operations.approvals.sheet.hash') }}</h3>
      <div v-if="shownDigest" class="flex min-w-0 items-center gap-2">
        <code class="min-w-0 break-all font-mono text-muted-foreground">{{ shownDigest }}</code>
        <CopyButton :value="shownDigest" />
      </div>
      <p v-else-if="approval.plan_sha256" class="flex min-w-0 items-center gap-2">
        <code class="min-w-0 break-all font-mono text-muted-foreground">{{ approval.plan_sha256 }}</code>
      </p>
      <p v-if="digestMismatch" class="text-destructive">{{ $t('operations.approvals.sheet.hashMismatch', { server: shortId(approval.plan_sha256, 16) }) }}</p>
      <p v-else-if="shownDigest && approval.plan_sha256" class="text-muted-foreground">{{ $t('operations.approvals.sheet.hashMatches') }}</p>
      <p v-else-if="!shownDigest && approval.plan_sha256" class="text-muted-foreground">{{ $t('operations.approvals.sheet.hashServer') }}</p>
    </section>

    <p v-if="decisionError" class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-muted-foreground">
      <span class="font-medium text-foreground">{{ $t('operations.approvals.approveErrorTitle') }}</span>
      · {{ decisionError }}
    </p>

    <section v-if="mayHaveTasks" class="space-y-2" data-testid="approval-tasks">
      <h3 class="text-sm font-medium">{{ $t('operations.approvals.sheet.tasks') }}</h3>
      <p v-if="tasksQuery.loading.value" class="text-xs text-muted-foreground">{{ $t('operations.approvals.sheet.tasksReading') }}</p>
      <p v-else-if="tasksForbidden" class="text-xs text-muted-foreground">{{ $t('operations.approvals.sheet.tasksForbidden') }}</p>
      <p v-else-if="tasksQuery.error.value" class="text-xs text-destructive">
        {{ $t('operations.approvals.sheet.tasksFailed', { message: tasksQuery.error.value.message }) }}
      </p>
      <p v-else-if="!(tasksQuery.data.value ?? []).length" class="text-xs text-muted-foreground">{{ $t('operations.approvals.sheet.noTasks') }}</p>
      <ul v-else class="divide-y divide-border rounded-md border border-border text-sm">
        <li v-for="task in tasksQuery.data.value" :key="task.id" class="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
          <Badge :variant="taskStateStyle(task.status).variant">{{ $t(`operations.tasks.status.${task.status}`) }}</Badge>
          <RouterLink
            :to="{ name: 'tasks', query: { open: task.id } }"
            class="rounded-sm font-mono text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            :title="task.id"
          >
            {{ shortId(task.id, 12) }}
          </RouterLink>
          <span class="ms-auto text-xs text-muted-foreground" :title="formatDateTime(task.created_at)">{{ formatRelativeTime(task.created_at) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
