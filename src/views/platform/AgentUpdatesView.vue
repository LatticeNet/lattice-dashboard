<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  DownloadCloud,
  FileCode2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  ApiError,
  type AgentUpdatePolicy,
  type AgentUpdatePolicyUpsertRequest,
  type ApprovalView,
} from "@/lib/api";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const TARGET_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DEFAULT_INSTALL_PATH = "/usr/local/bin/lattice-agent";
const DEFAULT_SERVICE_NAME = "lattice-agent.service";

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("node:admin"));
const canPlan = computed(() => auth.can("node:admin") && auth.can("network:plan"));

const policiesQuery = useAsyncData(
  () => api.agentUpdates.list().then((r) => unwrap(r, "policies")),
  { pollInterval: 15000 },
);
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const policies = computed(() => policiesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedPolicies = computed(() =>
  [...policies.value].sort((a, b) => a.node_id.localeCompare(b.node_id)),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

// ── Create / edit dialog ─────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const editing = ref(false);

const form = ref({
  node_id: "",
  enabled: true,
  auto_plan: false,
  target_version: "",
  binary_url: "",
  sha256: "",
  install_path: "",
  service_name: "",
});

function resetForm(): void {
  form.value = {
    node_id: "",
    enabled: true,
    auto_plan: false,
    target_version: "",
    binary_url: "",
    sha256: "",
    install_path: "",
    service_name: "",
  };
}

function openCreate(): void {
  if (!canAdmin.value) return;
  editing.value = false;
  resetForm();
  formOpen.value = true;
}

function openEdit(policy: AgentUpdatePolicy): void {
  if (!canAdmin.value) return;
  editing.value = true;
  form.value = {
    node_id: policy.node_id,
    enabled: policy.enabled,
    auto_plan: policy.auto_plan,
    target_version: policy.target_version,
    binary_url: policy.binary_url,
    sha256: policy.sha256,
    install_path: policy.install_path === DEFAULT_INSTALL_PATH ? "" : policy.install_path,
    service_name: policy.service_name === DEFAULT_SERVICE_NAME ? "" : policy.service_name,
  };
  formOpen.value = true;
}

const versionValid = computed(
  () => !form.value.target_version || TARGET_VERSION_RE.test(form.value.target_version.trim()),
);
const urlValid = computed(() => {
  const url = form.value.binary_url.trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
});
const shaValid = computed(() => SHA256_RE.test(form.value.sha256.trim()));

const canSubmit = computed(
  () =>
    !!form.value.node_id &&
    !!form.value.target_version.trim() &&
    versionValid.value &&
    urlValid.value &&
    shaValid.value,
);

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: AgentUpdatePolicyUpsertRequest = {
      node_id: form.value.node_id,
      enabled: form.value.enabled,
      auto_plan: form.value.auto_plan,
      target_version: form.value.target_version.trim(),
      binary_url: form.value.binary_url.trim(),
      sha256: form.value.sha256.trim(),
    };
    if (form.value.install_path.trim()) req.install_path = form.value.install_path.trim();
    if (form.value.service_name.trim()) req.service_name = form.value.service_name.trim();
    await api.agentUpdates.upsert(req);
    toast.success(editing.value ? t("platform.agentUpdates.policyUpdated") : t("platform.agentUpdates.policyCreated"));
    formOpen.value = false;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.agentUpdates.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<AgentUpdatePolicy | undefined>();
const deleting = ref(false);

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.agentUpdates.delete(deleteTarget.value.node_id);
    toast.success(t("platform.agentUpdates.policyDeleted"));
    deleteTarget.value = undefined;
    policiesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.agentUpdates.deleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan → approval ──────────────────────────────────────────────────────────
const planOpen = ref(false);
const planning = ref<string | undefined>();
const approval = ref<ApprovalView | undefined>();
const planDigest = ref("");

// Noop (409) state: offer a forced re-plan.
const noopOpen = ref(false);
const noopNodeId = ref<string | undefined>();
const noopMessage = ref("");

async function runPlan(nodeId: string, force: boolean): Promise<void> {
  if (!canPlan.value) return;
  planning.value = nodeId;
  try {
    const result = await api.agentUpdates.plan(nodeId, force || undefined);
    approval.value = result;
    planDigest.value = await sha256Hex(result.plan || "");
    noopOpen.value = false;
    planOpen.value = true;
    toast.success(t("platform.agentUpdates.planCreated"));
    policiesQuery.refresh();
  } catch (error) {
    // 409 = node already at target / noop. Offer a forced re-plan.
    if (error instanceof ApiError && error.status === 409 && !force) {
      noopNodeId.value = nodeId;
      noopMessage.value = error.message || t("platform.agentUpdates.nodeAlreadyTarget");
      noopOpen.value = true;
    } else {
      toast.error(error instanceof Error ? error.message : t("platform.agentUpdates.planFailed"));
    }
  } finally {
    planning.value = undefined;
  }
}

function forcePlan(): void {
  if (noopNodeId.value) void runPlan(noopNodeId.value, true);
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.agentUpdates.title')"
      :description="$t('platform.agentUpdates.description')"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="policiesQuery.refreshing.value"
          @click="policiesQuery.refresh"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', policiesQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.agentUpdates.newPolicy') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <DownloadCloud aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.agentUpdates.policiesTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('platform.agentUpdates.policiesCount', { count: policies.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="policiesQuery.loading.value"
          :error="policiesQuery.error.value"
          :is-empty="policies.length === 0"
          :empty-title="$t('platform.agentUpdates.emptyTitle')"
          :empty-description="$t('platform.agentUpdates.emptyDescription')"
          @retry="policiesQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.colNode') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.colState') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.colTarget') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.colApplied') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.colLastPlanned') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.colBinaryUrl') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.agentUpdates.colSha256') }}</th>
                  <th scope="col" class="py-2 pl-4 text-right font-medium">{{ $t('platform.agentUpdates.colActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="policy in sortedPolicies"
                  :key="policy.node_id"
                  class="border-b border-border hover:bg-muted/40"
                >
                  <td class="py-3 pr-4">
                    <div class="font-medium">{{ nodeName(policy.node_id) }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(policy.node_id, 16) }}</div>
                  </td>
                  <td class="py-3 pr-4">
                    <div class="flex flex-wrap gap-1">
                      <Badge :variant="policy.enabled ? 'success' : 'secondary'">
                        {{ policy.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
                      </Badge>
                      <Badge :variant="policy.auto_plan ? 'info' : 'outline'">
                        {{ policy.auto_plan ? $t('platform.agentUpdates.autoPlan') : $t('platform.agentUpdates.manual') }}
                      </Badge>
                    </div>
                    <p v-if="policy.last_error" class="mt-1 max-w-[220px] break-words text-xs text-destructive">
                      {{ policy.last_error }}
                    </p>
                  </td>
                  <td class="py-3 pr-4 font-mono text-xs">{{ policy.target_version || "—" }}</td>
                  <td class="py-3 pr-4 font-mono text-xs">{{ policy.last_applied_version || "—" }}</td>
                  <td class="py-3 pr-4 text-xs text-muted-foreground">
                    {{ policy.last_planned_at ? formatDateTime(policy.last_planned_at) : "—" }}
                  </td>
                  <td class="py-3 pr-4">
                    <div class="flex items-center gap-1">
                      <code class="max-w-[200px] truncate font-mono text-xs" :title="policy.binary_url">
                        {{ policy.binary_url }}
                      </code>
                      <CopyButton :value="policy.binary_url" />
                    </div>
                  </td>
                  <td class="py-3 pr-4">
                    <div class="flex items-center gap-1">
                      <code class="font-mono text-xs">{{ shortId(policy.sha256, 12) }}</code>
                      <CopyButton :value="policy.sha256" />
                    </div>
                  </td>
                  <td class="py-3 pl-4">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canPlan"
                        variant="ghost"
                        size="sm"
                        :disabled="planning === policy.node_id"
                        @click="runPlan(policy.node_id, false)"
                      >
                        <RefreshCw v-if="planning === policy.node_id" aria-hidden="true" class="size-4 animate-spin" />
                        <FileCode2 v-else aria-hidden="true" class="size-4" />
                        {{ $t('platform.agentUpdates.plan') }}
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        :aria-label="$t('platform.agentUpdates.editPolicyAria')"
                        @click="openEdit(policy)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        :aria-label="$t('platform.agentUpdates.deletePolicyAria')"
                        @click="deleteTarget = policy"
                      >
                        <Trash2 class="size-4 text-destructive" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? $t('platform.agentUpdates.editPolicyTitle') : $t('platform.agentUpdates.newPolicyTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.agentUpdates.formHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="pol-node">{{ $t('platform.agentUpdates.nodeLabel') }}</Label>
              <Select v-model="form.node_id" :disabled="editing">
                <SelectTrigger id="pol-node">
                  <SelectValue :placeholder="$t('platform.agentUpdates.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="editing" class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.nodeImmutable') }}</p>
            </div>
            <div class="grid gap-2">
              <Label for="pol-version">{{ $t('platform.agentUpdates.targetVersionLabel') }}</Label>
              <Input
                id="pol-version"
                v-model="form.target_version"
                required
                placeholder="1.4.2"
                :class="cn(form.target_version && !versionValid && 'border-destructive')"
              />
              <p v-if="form.target_version && !versionValid" class="text-xs text-destructive">
                {{ $t('platform.agentUpdates.versionInvalid') }}
              </p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="pol-url">{{ $t('platform.agentUpdates.binaryUrlLabel') }}</Label>
            <Input
              id="pol-url"
              v-model="form.binary_url"
              required
              placeholder="https://releases.example.com/lattice-agent-1.4.2"
              :class="cn(form.binary_url && !urlValid && 'border-destructive')"
            />
            <p v-if="form.binary_url && !urlValid" class="text-xs text-destructive">
              {{ $t('platform.agentUpdates.urlInvalid') }}
            </p>
          </div>

          <div class="grid gap-2">
            <Label for="pol-sha">{{ $t('platform.agentUpdates.sha256Label') }}</Label>
            <Input
              id="pol-sha"
              v-model="form.sha256"
              required
              :placeholder="$t('platform.agentUpdates.sha256Placeholder')"
              :class="cn('font-mono', form.sha256 && !shaValid && 'border-destructive')"
            />
            <p v-if="form.sha256 && !shaValid" class="text-xs text-destructive">
              {{ $t('platform.agentUpdates.sha256Invalid') }}
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="pol-install">{{ $t('platform.agentUpdates.installPathLabel') }}</Label>
              <Input id="pol-install" v-model="form.install_path" :placeholder="DEFAULT_INSTALL_PATH" />
              <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.installPathHint', { path: DEFAULT_INSTALL_PATH }) }}</p>
            </div>
            <div class="grid gap-2">
              <Label for="pol-service">{{ $t('platform.agentUpdates.serviceNameLabel') }}</Label>
              <Input id="pol-service" v-model="form.service_name" :placeholder="DEFAULT_SERVICE_NAME" />
              <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdates.serviceNameHint', { name: DEFAULT_SERVICE_NAME }) }}</p>
            </div>
          </div>

          <div class="flex flex-wrap gap-6">
            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
              {{ $t('platform.agentUpdates.enabledLabel') }}
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.auto_plan" type="checkbox" class="size-4 accent-primary" />
              {{ $t('platform.agentUpdates.autoPlanLabel') }}
            </label>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" aria-hidden="true" class="size-4 animate-spin" />
              <Plus v-else-if="!editing" aria-hidden="true" class="size-4" />
              <Pencil v-else aria-hidden="true" class="size-4" />
              {{ editing ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.agentUpdates.deletePolicyTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.agentUpdates.deletePolicyConfirm', { node: deleteTarget ? nodeName(deleteTarget.node_id) : "" }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" aria-hidden="true" class="size-4 animate-spin" />
            <Trash2 v-else aria-hidden="true" class="size-4" />
            {{ $t('common.actions.delete') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Noop (409) — offer force plan -->
    <Dialog v-model:open="noopOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.agentUpdates.noopTitle') }}</DialogTitle>
          <DialogDescription>{{ noopMessage }}</DialogDescription>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">
          {{ $t('platform.agentUpdates.noopHint') }}
        </p>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button
            type="button"
            :disabled="!!noopNodeId && planning === noopNodeId"
            @click="forcePlan"
          >
            <RefreshCw v-if="!!noopNodeId && planning === noopNodeId" aria-hidden="true" class="size-4 animate-spin" />
            <FileCode2 v-else aria-hidden="true" class="size-4" />
            {{ $t('platform.agentUpdates.forcePlan') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Plan dialog (creates a pending Approval) -->
    <Dialog v-model:open="planOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <FileCode2 aria-hidden="true" class="size-5 text-muted-foreground" />
            {{ $t('platform.agentUpdates.planTitle') }}
          </DialogTitle>
          <DialogDescription v-if="approval">
            {{ $t('platform.agentUpdates.planReviewOn', { plugin: approval.plugin, action: approval.action, node: nodeName(approval.node_id) }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="approval" class="space-y-4">
          <div class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
            {{ $t('platform.agentUpdates.planCreatedReview') }}
            <span class="font-medium text-foreground">{{ $t('platform.agentUpdates.operationsApprovals') }}</span>{{ $t('platform.agentUpdates.planAppliesAfter') }}
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('platform.agentUpdates.plan') }}</span>
              <CopyButton :value="approval.plan || ''" />
            </div>
            <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ approval.plan }}</pre>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">sha256</span>
            <code class="break-all font-mono">{{ planDigest }}</code>
            <CopyButton :value="planDigest" />
          </div>

          <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{{ $t('platform.agentUpdates.approvalLabel', { id: shortId(approval.id, 12) }) }}</Badge>
            <Badge variant="warning">{{ approval.status }}</Badge>
            <span v-if="approval.created_at">{{ formatDateTime(approval.created_at) }}</span>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.close') }}</Button>
          </DialogClose>
          <RouterLink to="/approvals">
            <Button type="button">{{ $t('platform.agentUpdates.goToApprovals') }}</Button>
          </RouterLink>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
