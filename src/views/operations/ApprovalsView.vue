<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { CheckCircle2, GitCompare, Play, RefreshCw, ShieldCheck } from "lucide-vue-next";
import { api, unwrap, type ApprovalStatus, type ApprovalView } from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const auth = useAuthStore();
const approvalsQuery = useAsyncData(() => api.approvals.list().then((r) => unwrap(r, "approvals")), {
  pollInterval: 8000,
});

const selectedId = ref("");
const pendingApproval = ref<string | undefined>();
const digestCache = ref<Record<string, string>>({});

const approvals = computed(() => approvalsQuery.data.value ?? []);
const pending = computed(() => approvals.value.filter((a) => a.status === "pending"));
const selected = computed<ApprovalView | undefined>(() =>
  approvals.value.find((approval) => approval.id === selectedId.value) ?? approvals.value[0],
);
const canApply = computed(() => auth.can("network:apply"));

const sortedApprovals = computed(() =>
  [...approvals.value].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return (b.created_at || "").localeCompare(a.created_at || "");
  }),
);

function variantFor(status: ApprovalStatus): "success" | "warning" | "destructive" | "secondary" {
  if (status === "pending" || status === "approved") return "warning";
  if (status === "applied") return "success";
  if (status === "failed" || status === "rejected") return "destructive";
  return "secondary";
}

async function digestFor(approval: ApprovalView): Promise<string> {
  const cached = digestCache.value[approval.id];
  if (cached) return cached;
  const digest = await sha256Hex(approval.plan || "");
  digestCache.value = { ...digestCache.value, [approval.id]: digest };
  return digest;
}

async function approve(approval: ApprovalView, queueApply: boolean) {
  pendingApproval.value = approval.id;
  try {
    const digest = await digestFor(approval);
    await api.approvals.approve(approval.id, queueApply, digest);
    toast.success(queueApply ? "Approval queued for apply" : "Approval recorded");
    approvalsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Approval failed");
  } finally {
    pendingApproval.value = undefined;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Approvals" description="Review plans, bind plan hashes, and queue approved changes">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="approvalsQuery.refreshing.value" @click="approvalsQuery.refresh">
          <RefreshCw :class="cn('size-4', approvalsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Total</p>
            <p class="text-2xl font-semibold">{{ approvals.length }}</p>
          </div>
          <ShieldCheck class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Pending</p>
            <p class="text-2xl font-semibold text-warning">{{ pending.length }}</p>
          </div>
          <GitCompare class="size-5 text-warning" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Can apply</p>
            <p class="text-2xl font-semibold">{{ canApply ? "Yes" : "No" }}</p>
          </div>
          <CheckCircle2 class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <div class="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Inbox</CardTitle>
          <CardDescription>Newest and pending approvals first</CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="approvalsQuery.loading.value"
            :error="approvalsQuery.error.value"
            :is-empty="approvals.length === 0"
            empty-title="No approvals"
            empty-description="Planned network and platform changes appear here."
            @retry="approvalsQuery.refresh"
          >
            <div class="space-y-2">
              <button
                v-for="approval in sortedApprovals"
                :key="approval.id"
                type="button"
                :class="cn('w-full rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40', selected?.id === approval.id && 'border-primary bg-primary/5')"
                @click="selectedId = approval.id"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-medium">{{ approval.plugin }} · {{ approval.action }}</span>
                  <Badge :variant="variantFor(approval.status)">{{ approval.status }}</Badge>
                </div>
                <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{{ shortId(approval.id) }}</span>
                  <span>{{ approval.node_id || "global" }}</span>
                  <span>{{ formatDateTime(approval.created_at) }}</span>
                </div>
              </button>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plan Review</CardTitle>
          <CardDescription v-if="selected">
            {{ selected.plugin }} / {{ selected.action }} on {{ selected.node_id || "global" }}
          </CardDescription>
          <CardDescription v-else>
            Select an approval to inspect its plan.
          </CardDescription>
        </CardHeader>
        <CardContent v-if="selected" class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge :variant="variantFor(selected.status)">{{ selected.status }}</Badge>
            <Badge variant="outline">id {{ shortId(selected.id, 12) }}</Badge>
            <Badge v-if="selected.approved_by" variant="secondary">by {{ selected.approved_by }}</Badge>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">Plan</span>
              <CopyButton :value="selected.plan || ''" />
            </div>
            <pre class="max-h-[520px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ selected.plan }}</pre>
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
              Compute hash
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              variant="outline"
              :disabled="!canApply || pendingApproval === selected.id"
              @click="approve(selected, false)"
            >
              <CheckCircle2 class="size-4" aria-hidden="true" />
              Approve only
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              :disabled="!canApply || pendingApproval === selected.id"
              @click="approve(selected, true)"
            >
              <RefreshCw v-if="pendingApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
              <Play v-else class="size-4" aria-hidden="true" />
              Approve and queue
            </Button>
          </div>

          <p v-if="!canApply" class="text-sm text-muted-foreground">
            `network:apply` is required to approve plans.
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
