<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { CheckCircle2, GitCompare, Play, RefreshCw, ShieldCheck } from "lucide-vue-next";
import { api, unwrap, type ApprovalStatus, type ApprovalView } from "@/lib/api";
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
import { Badge } from "@/components/ui/badge";

const { t } = useI18n();
const auth = useAuthStore();
const approvalsQuery = useAsyncData(() => api.approvals.list().then((r) => unwrap(r, "approvals")), {
  pollInterval: 8000,
});

const selectedId = ref("");
const pendingApproval = ref<string | undefined>();
const { digestFor, cache: digestCache } = usePlanDigest();

const approvals = computed(() => approvalsQuery.data.value ?? []);
const pending = computed(() => approvals.value.filter((a) => a.status === "pending"));
const selected = computed<ApprovalView | undefined>(() =>
  approvals.value.find((approval) => approval.id === selectedId.value) ?? approvals.value[0],
);
const canApply = computed(() => auth.can("network:apply"));

const planView = ref<"diff" | "full">("diff");

// The most recent earlier plan for the same target (node + plugin + action) that
// was approved/applied — i.e. what is currently live. Diffing the selection
// against it shows exactly what this change does. Empty = no prior config.
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
        (a.status === "applied" || a.status === "approved") &&
        (a.created_at || "") < (cur.created_at || ""),
    )
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return prior[0]?.plan ?? "";
});

const sortedApprovals = computed(() =>
  [...approvals.value].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return (b.created_at || "").localeCompare(a.created_at || "");
  }),
);

function variantFor(status: ApprovalStatus) {
  return approvalStatusMeta(status).badgeVariant;
}

async function approve(approval: ApprovalView, queueApply: boolean) {
  pendingApproval.value = approval.id;
  try {
    const digest = await digestFor(approval);
    await api.approvals.approve(approval.id, queueApply, digest);
    toast.success(queueApply ? t("operations.approvals.toastQueued") : t("operations.approvals.toastRecorded"));
    approvalsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.approvals.toastFailed"));
  } finally {
    pendingApproval.value = undefined;
  }
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
                  <Badge :variant="variantFor(approval.status)">{{ $t('common.status.' + approval.status) }}</Badge>
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
            <span class="font-medium">sha256</span>
            <code class="break-all font-mono">{{ digestCache[selected.id] }}</code>
            <CopyButton :value="digestCache[selected.id] || ''" />
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
              :disabled="!canApply || pendingApproval === selected.id"
              @click="approve(selected, false)"
            >
              <CheckCircle2 class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.approveOnly') }}
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              :disabled="!canApply || pendingApproval === selected.id"
              @click="approve(selected, true)"
            >
              <RefreshCw v-if="pendingApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
              <Play v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.approveAndQueue') }}
            </Button>
          </div>

          <p v-if="!canApply" class="text-sm text-muted-foreground">
            {{ $t('operations.approvals.applyRequired') }}
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
