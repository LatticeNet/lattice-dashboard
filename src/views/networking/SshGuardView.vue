<script setup lang="ts">
/**
 * SSH Guard: shrink a node's SSH exposure without locking yourself out.
 *
 * The screen is built around the one thing that makes this safe, which is that
 * it takes two decisions rather than one. Arming applies the hardening and, at
 * the same moment, schedules an automatic revert. Confirming cancels that
 * revert. The gap between them exists so a human can open a fresh connection
 * over the new path and get a shell; if they cannot, doing nothing is what
 * restores access.
 *
 * So the loudest thing on the page is not the form. It is the list of nodes
 * whose revert timer is running, because that is a state with a deadline.
 */
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { AlertTriangle, KeyRound, ShieldCheck, Timer } from "lucide-vue-next";

import { api, ApiError, unwrap, type ApprovalView, type SSHGuardFinding } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import NodePicker from "@/components/common/NodePicker.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  DEFAULT_CONFIRM_WINDOW_SEC,
  buildPlanRequest,
  deriveNodeGuardState,
  hasBlocking,
  isSSHGuardApproval,
  nodesAwaitingConfirm,
  parseMgmtSources,
  sortFindings,
  validateForm,
  type GuardForm,
  type NodeGuardState,
} from "./sshGuardModel";

const { t } = useI18n();
const auth = useAuthStore();

// Both scopes are required server-side: the capability's own and the plan
// scope the approval is minted under. Checking only one would offer a button
// that always fails.
const canAdmin = computed(() => auth.canAll(["sshguard:admin", "network:plan"]));

const approvalsQuery = useAsyncData<ApprovalView[] | undefined>(
  () => api.approvals.list().then((r) => unwrap(r, "approvals")),
  { pollInterval: 15000 },
);

const approvals = computed(() => (approvalsQuery.data.value ?? []).filter(isSSHGuardApproval));

/** Every node SSH Guard has ever touched, newest activity first. */
const states = computed<NodeGuardState[]>(() => {
  const ids = Array.from(new Set(approvals.value.map((a) => a.node_id)));
  return ids.map((id) => deriveNodeGuardState(approvals.value, id));
});

const urgent = computed(() => nodesAwaitingConfirm(states.value));

const form = reactive<GuardForm>({
  nodeId: "",
  sshPort: 0,
  keepLegacyPort: true,
  mgmtSources: "",
  enableKnock: true,
  outOfBandFallback: false,
  confirmWindowSec: DEFAULT_CONFIRM_WINDOW_SEC,
  acceptFindings: false,
});

const findings = ref<SSHGuardFinding[]>([]);
const planning = ref(false);
const confirming = ref("");

const sourceParse = computed(() => parseMgmtSources(form.mgmtSources));
const errors = computed(() => validateForm(form));
const blocked = computed(() => hasBlocking(findings.value) && !form.acceptFindings);
const selected = computed(() =>
  form.nodeId ? deriveNodeGuardState(approvals.value, form.nodeId) : undefined,
);

// A fresh node is a fresh decision: findings and the acceptance that went with
// them belong to the profile they were computed for.
watch(
  () => form.nodeId,
  () => {
    findings.value = [];
    form.acceptFindings = false;
  },
);

async function plan() {
  if (!form.nodeId || errors.value.length || planning.value) return;
  planning.value = true;
  try {
    const res = await api.sshGuard.plan(buildPlanRequest(form));
    findings.value = res.findings ?? [];
    form.acceptFindings = false;
    toast.success(t("networking.sshGuard.planned", { id: shortId(res.approval.id) }));
    approvalsQuery.refresh();
  } catch (err) {
    // 409 is the lint refusing the plan. It carries the reasons, so show them
    // instead of a generic failure: the operator's next move is to read them.
    if (err instanceof ApiError && err.status === 409) {
      const body = err.body as { findings?: SSHGuardFinding[] } | undefined;
      findings.value = body?.findings ?? [];
      toast.error(t("networking.sshGuard.blockedByLint"));
    } else {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  } finally {
    planning.value = false;
  }
}

async function confirmNode(nodeId: string) {
  if (confirming.value) return;
  confirming.value = nodeId;
  try {
    const res = await api.sshGuard.confirm(nodeId);
    toast.success(t("networking.sshGuard.confirmPlanned", { id: shortId(res.approval.id) }));
    approvalsQuery.refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    confirming.value = "";
  }
}

const stageTone: Record<string, "default" | "secondary" | "warning" | "destructive"> = {
  idle: "secondary",
  armPending: "secondary",
  armApproved: "secondary",
  awaitingConfirm: "warning",
  confirmPending: "warning",
  confirmApproved: "warning",
  confirmed: "default",
  armFailed: "destructive",
};
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      :title="$t('networking.sshGuard.title')"
      :description="$t('networking.sshGuard.description')"
    />

    <!-- The only state with a deadline. It goes first and it is loud. -->
    <Card v-if="urgent.length" class="border-warning">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Timer class="size-4 text-warning" aria-hidden="true" />
          {{ $t('networking.sshGuard.awaiting.title') }}
          <Badge variant="warning">{{ urgent.length }}</Badge>
        </CardTitle>
        <CardDescription>{{ $t('networking.sshGuard.awaiting.description') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <p class="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {{ $t('networking.sshGuard.awaiting.instruction') }}
        </p>
        <div
          v-for="state in urgent"
          :key="state.nodeId"
          class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
        >
          <div class="min-w-0">
            <p class="truncate font-mono text-sm">{{ state.nodeId }}</p>
            <p class="text-xs text-muted-foreground">
              {{ $t(`networking.sshGuard.stage.${state.stage}`) }}
            </p>
          </div>
          <Button
            v-if="state.stage === 'awaitingConfirm'"
            size="sm"
            :disabled="!canAdmin || confirming === state.nodeId"
            @click="confirmNode(state.nodeId)"
          >
            {{ $t('networking.sshGuard.confirmAction') }}
          </Button>
          <Badge v-else variant="warning">{{ $t('networking.sshGuard.confirmQueued') }}</Badge>
        </div>
      </CardContent>
    </Card>

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- Plan -->
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <ShieldCheck class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('networking.sshGuard.plan.title') }}
          </CardTitle>
          <CardDescription>{{ $t('networking.sshGuard.plan.description') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <NodePicker id="sshguard-node" v-model="form.nodeId" :disabled="!canAdmin" />

          <div class="grid gap-2">
            <Label for="sshguard-port">{{ $t('networking.sshGuard.fields.sshPort') }}</Label>
            <Input
              id="sshguard-port"
              v-model.number="form.sshPort"
              type="number"
              min="0"
              max="65535"
              :disabled="!canAdmin"
            />
            <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.sshPortHint') }}</p>
          </div>

          <label class="flex items-start gap-3 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.keepLegacyPort" :disabled="!canAdmin"
              @update:model-value="(v) => (form.keepLegacyPort = v === true)" />
            <span class="space-y-1">
              <span class="block font-medium">{{ $t('networking.sshGuard.fields.keepLegacy') }}</span>
              <span class="block text-muted-foreground">{{ $t('networking.sshGuard.fields.keepLegacyHint') }}</span>
            </span>
          </label>

          <div class="grid gap-2">
            <Label for="sshguard-sources">{{ $t('networking.sshGuard.fields.mgmtSources') }}</Label>
            <Input id="sshguard-sources" v-model="form.mgmtSources" :disabled="!canAdmin"
              :placeholder="$t('networking.sshGuard.fields.mgmtSourcesPlaceholder')" />
            <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.mgmtSourcesHint') }}</p>
            <p v-if="sourceParse.invalid.length" class="text-xs text-destructive">
              {{ $t('networking.sshGuard.fields.mgmtSourcesInvalid', { values: sourceParse.invalid.join(', ') }) }}
            </p>
          </div>

          <label class="flex items-start gap-3 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.enableKnock" :disabled="!canAdmin"
              @update:model-value="(v) => (form.enableKnock = v === true)" />
            <span class="space-y-1">
              <span class="block font-medium">{{ $t('networking.sshGuard.fields.knock') }}</span>
              <span class="block text-muted-foreground">{{ $t('networking.sshGuard.fields.knockHint') }}</span>
            </span>
          </label>

          <label class="flex items-start gap-3 text-sm">
            <Checkbox class="mt-0.5" :model-value="form.outOfBandFallback" :disabled="!canAdmin"
              @update:model-value="(v) => (form.outOfBandFallback = v === true)" />
            <span class="space-y-1">
              <span class="block font-medium">{{ $t('networking.sshGuard.fields.fallback') }}</span>
              <span class="block text-muted-foreground">{{ $t('networking.sshGuard.fields.fallbackHint') }}</span>
            </span>
          </label>

          <div class="grid gap-2">
            <Label for="sshguard-window">{{ $t('networking.sshGuard.fields.window') }}</Label>
            <Input id="sshguard-window" v-model.number="form.confirmWindowSec" type="number" min="120"
              :disabled="!canAdmin" />
            <p class="text-xs text-muted-foreground">{{ $t('networking.sshGuard.fields.windowHint') }}</p>
          </div>

          <ul v-if="errors.length" class="space-y-1 text-xs text-destructive">
            <li v-for="code in errors" :key="code">{{ $t(`networking.sshGuard.errors.${code}`) }}</li>
          </ul>

          <div class="flex items-center gap-3">
            <Button :disabled="!canAdmin || !form.nodeId || errors.length > 0 || planning || blocked" @click="plan">
              {{ $t('networking.sshGuard.planAction') }}
            </Button>
            <p v-if="selected && selected.stage !== 'idle'" class="text-xs text-muted-foreground">
              {{ $t(`networking.sshGuard.stage.${selected.stage}`) }}
            </p>
          </div>
        </CardContent>
      </Card>

      <!-- Findings + fleet state -->
      <div class="space-y-6">
        <Card v-if="findings.length">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <AlertTriangle class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('networking.sshGuard.findings.title') }}
            </CardTitle>
            <CardDescription>{{ $t('networking.sshGuard.findings.description') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div
              v-for="finding in sortFindings(findings)"
              :key="finding.code"
              class="rounded-md border border-border p-3"
            >
              <div class="flex items-center gap-2">
                <Badge :variant="finding.severity === 'block' ? 'destructive' : 'warning'">
                  {{ finding.severity }}
                </Badge>
                <code class="font-mono text-xs">{{ finding.code }}</code>
              </div>
              <p class="mt-1 text-sm">{{ finding.message }}</p>
            </div>
            <label v-if="hasBlocking(findings)" class="flex items-start gap-3 text-sm">
              <Checkbox class="mt-0.5" :model-value="form.acceptFindings" :disabled="!canAdmin"
                @update:model-value="(v) => (form.acceptFindings = v === true)" />
              <span class="space-y-1">
                <span class="block font-medium">{{ $t('networking.sshGuard.findings.accept') }}</span>
                <span class="block text-muted-foreground">{{ $t('networking.sshGuard.findings.acceptHint') }}</span>
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('networking.sshGuard.fleet.title') }}
            </CardTitle>
            <CardDescription>{{ $t('networking.sshGuard.fleet.description') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="approvalsQuery.loading.value"
              :error="approvalsQuery.error.value"
              :has-data="approvalsQuery.data.value !== undefined"
              :is-empty="states.length === 0"
              :empty-description="$t('networking.sshGuard.fleet.empty')"
              :skeleton-rows="3"
              @retry="approvalsQuery.refresh"
            >
              <ul class="space-y-2">
                <li
                  v-for="state in states"
                  :key="state.nodeId"
                  class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <button
                    type="button"
                    class="min-w-0 text-left font-mono text-sm hover:underline"
                    @click="form.nodeId = state.nodeId"
                  >{{ state.nodeId }}</button>
                  <Badge :variant="stageTone[state.stage] ?? 'secondary'">
                    {{ $t(`networking.sshGuard.stage.${state.stage}`) }}
                  </Badge>
                </li>
              </ul>
            </DataState>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</template>
