<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { AlertTriangle, Ban, CheckCircle2, FileCode2, GitCompare, Play, RefreshCw, ShieldCheck } from "lucide-vue-next";
import {
  api,
  APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED,
  isAgentUpdateNoopError,
  isApprovalStaleError,
  unwrap,
  type ApprovalStatus,
  type ApprovalView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { approvalStatusMeta } from "@/lib/status";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import PlanDiff from "@/components/common/PlanDiff.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

const { t } = useI18n();
const auth = useAuthStore();
const approvalsQuery = useAsyncData(() => api.approvals.list().then((r) => unwrap(r, "approvals")), {
  pollInterval: 8000,
});

const selectedId = ref("");
const pendingApproval = ref<string | undefined>();
const replanningApproval = ref<string | undefined>();
const forceReplanOpen = ref(false);
const forceReplanApproval = ref<ApprovalView | undefined>();
const forceReplanMessage = ref("");
const { digestFor, cache: digestCache } = usePlanDigest();

const approvals = computed(() => approvalsQuery.data.value ?? []);
const pending = computed(() => approvals.value.filter((a) => a.status === "pending"));
const selected = computed<ApprovalView | undefined>(() =>
  sortedApprovals.value.find((approval) => approval.id === selectedId.value) ?? sortedApprovals.value[0],
);
const canApply = computed(() => auth.can("network:apply"));
const canDecideSelected = computed(() => canDecideApproval(selected.value));

const planView = ref<"diff" | "full">("diff");
const lastApprovalError = ref<{ approvalId: string; message: string; stale: boolean } | undefined>();
const selectedAgentUpdateStale = computed(() => {
  const approval = selected.value;
  if (!approval || approval.plugin !== "agentupdate") return false;
  if (isStaleAgentUpdateApproval(approval)) return true;
  return lastApprovalError.value?.approvalId === approval.id && lastApprovalError.value.stale;
});
const selectedAgentUpdateStaleReason = computed(() => {
  if (!selectedAgentUpdateStale.value) return "";
  return staleAgentUpdateReason(selected.value) || lastApprovalError.value?.message || t("operations.approvals.toastStale");
});
const canApproveSelected = computed(() => canDecideSelected.value && !selectedAgentUpdateStale.value);
const canReplanSelectedAgentUpdate = computed(() => canReplanAgentUpdate(selected.value, selectedAgentUpdateStale.value));

// The most recent earlier applied plan for the same target (node + plugin +
// action) — i.e. what is actually live. Approved-but-not-applied plans are not a
// live baseline and would make the diff lie about the current state.
const previousPlan = computed(() => {
  const cur = selected.value;
  if (!cur) return "";
  const prior = approvals.value
    .filter(
      (a) =>
        a.id !== cur.id &&
        a.node_id === cur.node_id &&
        a.plugin === cur.plugin &&
        a.action === cur.action &&
        a.status === "applied" &&
        (a.created_at || "") < (cur.created_at || ""),
    )
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return prior[0]?.plan ?? "";
});

const sortedApprovals = computed(() =>
  [...approvals.value].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    const created = (b.created_at || "").localeCompare(a.created_at || "");
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  }),
);

watch(
  sortedApprovals,
  (list) => {
    if (list.length === 0) {
      selectedId.value = "";
      return;
    }
    if (!selectedId.value || !list.some((approval) => approval.id === selectedId.value)) {
      selectedId.value = list[0]?.id ?? "";
    }
  },
  { immediate: true },
);

function statusRank(status: ApprovalStatus): number {
  switch (status) {
    case "pending":
      return 0;
    case "approved":
      return 1;
    case "applied":
      return 2;
    case "rejected":
      return 3;
    default:
      return 9;
  }
}

function variantFor(status: ApprovalStatus) {
  return approvalStatusMeta(status).badgeVariant;
}

function approvalDecisionExtraScope(approval: ApprovalView): string {
  switch (approval.plugin) {
    case "nftpolicy":
      return "netpolicy:admin";
    case "agentupdate":
      return "node:admin";
    case "selfdns":
      return "dns:admin";
    case "proxycore":
      return "proxy:admin";
    case "cftunnel":
      return "tunnel:admin";
    default:
      return "";
  }
}

function canDecideApproval(approval?: ApprovalView): boolean {
  if (!approval || !auth.can("network:apply")) return false;
  const extraScope = approvalDecisionExtraScope(approval);
  return extraScope === "" || auth.can(extraScope);
}

async function approve(approval: ApprovalView, queueApply: boolean) {
  pendingApproval.value = approval.id;
  lastApprovalError.value = undefined;
  try {
    const digest = await digestFor(approval);
    await api.approvals.approve(approval.id, queueApply, digest);
    toast.success(queueApply ? t("operations.approvals.toastQueued") : t("operations.approvals.toastRecorded"));
    await approvalsQuery.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastFailed");
    const stale = isApprovalStaleError(error);
    lastApprovalError.value = { approvalId: approval.id, message, stale };
    toast.error(stale ? t("operations.approvals.toastStale") : message);
    await approvalsQuery.refresh();
  } finally {
    pendingApproval.value = undefined;
  }
}

async function rejectApproval(approval: ApprovalView) {
  if (!window.confirm(t("operations.approvals.rejectConfirm", { id: shortId(approval.id, 12) }))) return;
  pendingApproval.value = approval.id;
  lastApprovalError.value = undefined;
  try {
    await api.approvals.reject(approval.id);
    toast.success(t("operations.approvals.toastRejected"));
    await approvalsQuery.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastRejectFailed");
    lastApprovalError.value = { approvalId: approval.id, message, stale: false };
    toast.error(message);
    await approvalsQuery.refresh();
  } finally {
    pendingApproval.value = undefined;
  }
}

async function replanAgentUpdate(approval: ApprovalView, force = false, staleOverride = false) {
  if (!canReplanAgentUpdate(approval, staleOverride)) return;
  replanningApproval.value = approval.id;
  lastApprovalError.value = undefined;
  try {
    const fresh = await api.agentUpdates.plan(approval.node_id, force || undefined);
    toast.success(t("operations.approvals.replanCreated"));
    forceReplanOpen.value = false;
    forceReplanApproval.value = undefined;
    forceReplanMessage.value = "";
    await approvalsQuery.refresh();
    selectedId.value = fresh.id;
  } catch (error) {
    if (isAgentUpdateNoopError(error) && !force) {
      forceReplanApproval.value = approval;
      forceReplanMessage.value = error.message || t("operations.approvals.forceReplanAlreadyTarget");
      forceReplanOpen.value = true;
    } else {
      toast.error(error instanceof Error ? error.message : t("operations.approvals.replanFailed"));
    }
    await approvalsQuery.refresh();
  } finally {
    replanningApproval.value = undefined;
  }
}

function forceReplanAgentUpdate() {
  if (forceReplanApproval.value) void replanAgentUpdate(forceReplanApproval.value, true);
}

function staleAgentUpdateReason(approval?: ApprovalView): string {
  if (!approval || approval.plugin !== "agentupdate") return "";
  if (approval.stale || approval.stale_code === APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED) {
    return approval.reason || t("operations.approvals.toastStale");
  }
  if (!approval.reason) return "";
  const reason = approval.reason.toLowerCase();
  const stale =
    reason.includes("re-plan") ||
    reason.includes("replan") ||
    (reason.includes("policy changed") && reason.includes("approval"));
  return stale ? approval.reason : "";
}

function isStaleAgentUpdateApproval(approval?: ApprovalView): boolean {
  return staleAgentUpdateReason(approval) !== "";
}

function canReplanAgentUpdate(approval?: ApprovalView, staleOverride = false): boolean {
  return (
    !!approval?.node_id &&
    approval.plugin === "agentupdate" &&
    (isStaleAgentUpdateApproval(approval) || staleOverride) &&
    auth.can("node:admin") &&
    auth.can("network:plan")
  );
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('operations.approvals.title')" :description="$t('operations.approvals.description')">
      <template #status>
        <FreshnessLabel :last-updated="approvalsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="approvalsQuery.refreshing.value" @click="approvalsQuery.refresh">
          <RefreshCw :class="cn('size-4', approvalsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.total') }}</p>
            <p class="text-2xl font-semibold">{{ approvals.length }}</p>
          </div>
          <ShieldCheck class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.pending') }}</p>
            <p class="text-2xl font-semibold text-warning">{{ pending.length }}</p>
          </div>
          <GitCompare class="size-5 text-warning" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.canApply') }}</p>
            <p class="text-2xl font-semibold">{{ canApply ? $t('common.misc.yes') : $t('common.misc.no') }}</p>
          </div>
          <CheckCircle2 class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <div class="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>{{ $t('operations.approvals.inbox') }}</CardTitle>
          <CardDescription>{{ $t('operations.approvals.inboxHint') }}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="approvalsQuery.loading.value"
            :error="approvalsQuery.error.value"
            :has-data="approvalsQuery.data.value !== undefined"
            :is-empty="approvals.length === 0"
            :empty-title="$t('operations.approvals.emptyTitle')"
            :empty-description="$t('operations.approvals.emptyDescription')"
            @retry="approvalsQuery.refresh"
          >
            <div class="space-y-2">
              <button
                v-for="approval in sortedApprovals"
                :key="approval.id"
                type="button"
                :class="cn('surface-interactive w-full rounded-md border border-border p-3 text-left', selected?.id === approval.id && 'border-primary bg-primary/5')"
                @click="selectedId = approval.id"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-medium">{{ approval.plugin }} · {{ approval.action }}</span>
                  <div class="flex shrink-0 items-center gap-1">
                    <Badge v-if="isStaleAgentUpdateApproval(approval)" variant="outline">{{ $t('operations.approvals.staleBadge') }}</Badge>
                    <Badge :variant="variantFor(approval.status)">{{ $t('common.status.' + approval.status) }}</Badge>
                  </div>
                </div>
                <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{{ shortId(approval.id) }}</span>
                  <span>{{ approval.node_id || $t('common.misc.global') }}</span>
                  <span>{{ formatDateTime(approval.created_at) }}</span>
                </div>
              </button>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ $t('operations.approvals.planReview') }}</CardTitle>
          <CardDescription v-if="selected">
            {{ $t('operations.approvals.planReviewOn', { plugin: selected.plugin, action: selected.action, node: selected.node_id || $t('common.misc.global') }) }}
          </CardDescription>
          <CardDescription v-else>
            {{ $t('operations.approvals.selectPrompt') }}
          </CardDescription>
        </CardHeader>
        <CardContent v-if="selected" class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge :variant="variantFor(selected.status)">{{ $t('common.status.' + selected.status) }}</Badge>
            <Badge variant="outline">{{ $t('operations.approvals.idLabel', { id: shortId(selected.id, 12) }) }}</Badge>
            <Badge v-if="selected.approved_by" variant="secondary">{{ $t('operations.approvals.byLabel', { actor: selected.approved_by }) }}</Badge>
          </div>
          <div
            v-if="selectedAgentUpdateStale"
            class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground"
          >
            <p class="flex items-center gap-2 font-medium text-foreground">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />
              {{ $t('operations.approvals.staleTitle') }}
            </p>
            <p class="mt-1">{{ $t('operations.approvals.staleDescription') }}</p>
            <p class="mt-2 text-xs font-medium uppercase text-muted-foreground">
              {{ $t('operations.approvals.rejectionReason') }}
            </p>
            <p class="mt-1 break-words">{{ selectedAgentUpdateStaleReason }}</p>
            <Button
              v-if="canReplanSelectedAgentUpdate"
              type="button"
              variant="outline"
              size="sm"
              class="mt-3"
              :disabled="replanningApproval === selected.id"
              @click="replanAgentUpdate(selected, false, selectedAgentUpdateStale)"
            >
              <RefreshCw v-if="replanningApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
              <FileCode2 v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.replanAgentUpdate') }}
            </Button>
          </div>
          <div
            v-else-if="selected.status === 'rejected' && selected.reason"
            class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground"
          >
            <p class="font-medium text-foreground">{{ $t('operations.approvals.rejectionReason') }}</p>
            <p class="mt-1 break-words">{{ selected.reason }}</p>
          </div>

          <div class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-1">
                <Button :variant="planView === 'diff' ? 'secondary' : 'ghost'" size="sm" @click="planView = 'diff'">
                  <GitCompare class="size-3.5" aria-hidden="true" />
                  {{ $t('operations.approvals.viewDiff') }}
                </Button>
                <Button :variant="planView === 'full' ? 'secondary' : 'ghost'" size="sm" @click="planView = 'full'">
                  {{ $t('operations.approvals.viewFull') }}
                </Button>
              </div>
              <CopyButton :value="selected.plan || ''" />
            </div>
            <template v-if="planView === 'diff'">
              <PlanDiff :before="previousPlan" :after="selected.plan || ''" />
              <p v-if="!previousPlan" class="text-xs text-muted-foreground">{{ $t('operations.approvals.diffNoPrior') }}</p>
            </template>
            <pre v-else class="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-md border border-border p-4 font-mono text-xs leading-relaxed">{{ selected.plan }}</pre>
          </div>

          <div v-if="digestCache[selected.id]" class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">{{ $t('operations.approvals.planSha256') }}</span>
            <code class="break-all font-mono">{{ digestCache[selected.id] }}</code>
            <CopyButton :value="digestCache[selected.id] || ''" />
          </div>

          <div
            v-if="lastApprovalError?.approvalId === selected.id && !lastApprovalError.stale"
            :class="cn(
              'rounded-md border p-3 text-sm',
              'border-destructive/40 bg-destructive/5 text-muted-foreground',
            )"
          >
            <p class="font-medium text-foreground">
              {{ $t('operations.approvals.approveErrorTitle') }}
            </p>
            <p class="mt-1">
              {{ lastApprovalError.message }}
            </p>
          </div>

          <div class="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              :disabled="pendingApproval === selected.id"
              @click="digestFor(selected)"
            >
              <GitCompare class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.computeHash') }}
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              variant="outline"
              :disabled="!canApproveSelected || pendingApproval === selected.id"
              @click="approve(selected, false)"
            >
              <CheckCircle2 class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.approveOnly') }}
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              variant="destructive"
              :disabled="!canDecideSelected || pendingApproval === selected.id"
              @click="rejectApproval(selected)"
            >
              <Ban class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.reject') }}
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              :disabled="!canApproveSelected || pendingApproval === selected.id"
              @click="approve(selected, true)"
            >
              <RefreshCw v-if="pendingApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
              <Play v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.approveAndQueue') }}
            </Button>
          </div>

          <p v-if="!canDecideSelected" class="text-sm text-muted-foreground">
            {{ $t('operations.approvals.applyRequired') }}
          </p>
        </CardContent>
      </Card>
    </div>

    <Dialog v-model:open="forceReplanOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ $t('operations.approvals.forceReplanTitle') }}</DialogTitle>
          <DialogDescription>{{ forceReplanMessage }}</DialogDescription>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">
          {{ $t('operations.approvals.forceReplanHint') }}
        </p>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button
            type="button"
            :disabled="!!forceReplanApproval && replanningApproval === forceReplanApproval.id"
            @click="forceReplanAgentUpdate"
          >
            <RefreshCw
              v-if="!!forceReplanApproval && replanningApproval === forceReplanApproval.id"
              class="size-4 animate-spin"
              aria-hidden="true"
            />
            <FileCode2 v-else class="size-4" aria-hidden="true" />
            {{ $t('operations.approvals.forceReplanAgentUpdate') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
