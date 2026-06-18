<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  AlertTriangle,
  ArrowRight,
  Cpu,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type ProxyCore,
  type ProxyInboundView,
  type ProxyNodeProfileView,
  type ProxyNodeProfileUpsertRequest,
} from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const auth = useAuthStore();
const { t } = useI18n();

const profilesQuery = useAsyncData(
  () => api.proxy.profiles().then((r) => unwrap(r, "profiles")),
  { pollInterval: 12000 },
);
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 30000,
});
const inboundsQuery = useAsyncData(
  () => api.proxy.inbounds().then((r) => unwrap(r, "inbounds")),
  { pollInterval: 30000 },
);

const profiles = computed(() => profilesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const inbounds = computed(() => inboundsQuery.data.value ?? []);

const canAdmin = computed(() => auth.can("proxy:admin"));
const canPlan = computed(() => auth.can("network:plan") && auth.can("proxy:read"));

const sortedProfiles = computed(() =>
  [...profiles.value].sort((a, b) =>
    (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id),
  ),
);

const driftCount = computed(() => profiles.value.filter((p) => p.config_stale).length);
const appliedCount = computed(() => profiles.value.filter((p) => !!p.applied_sha256).length);

function inboundName(id: string): string {
  return inbounds.value.find((inb) => inb.id === id)?.name || shortId(id, 12);
}

function coreVariant(core: string): "info" | "secondary" {
  return core === "xray" ? "info" : "secondary";
}

function collectorVariant(status?: string): "success" | "destructive" | "secondary" {
  if (status === "ok") return "success";
  if (status === "error") return "destructive";
  return "secondary";
}

// ── DataTable columns ──────────────────────────────────────────────────────────
const profileColumns = computed<DataTableColumn<ProxyNodeProfileView>[]>(() => [
  { key: "node", label: t("proxy.profiles.colNode"), sortable: true, searchable: true, value: (p) => p.node_name || p.node_id },
  { key: "core", label: t("proxy.profiles.colCore"), sortable: true, searchable: true, value: (p) => p.core },
  { key: "inbounds", label: t("proxy.profiles.colInbounds"), sortable: true, value: (p) => p.inbound_ids.length },
  { key: "hostname", label: t("proxy.profiles.colHostname"), sortable: true, value: (p) => p.hostname || "" },
  { key: "appliedConfig", label: t("proxy.profiles.colAppliedConfig"), value: (p) => p.applied_sha256 || "" },
  { key: "drift", label: t("proxy.profiles.colDrift"), sortable: true, value: (p) => (p.config_stale ? 1 : 0) },
  { key: "collector", label: t("proxy.profiles.colCollector"), sortable: true, value: (p) => p.usage_collector_status || "" },
  { key: "lastApply", label: t("proxy.profiles.colLastApply"), sortable: true, value: (p) => p.last_apply_at || "" },
  { key: "actions", label: t("proxy.profiles.colActions"), align: "right" },
]);

// ── Create / edit dialog ──────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const editingId = ref<string | undefined>();

const form = reactive<{
  node_id: string;
  core: ProxyCore;
  inbound_ids: string[];
  hostname: string;
  listen_ip: string;
  config_path: string;
  stats_api: string;
}>({
  node_id: "",
  core: "sing-box",
  inbound_ids: [],
  hostname: "",
  listen_ip: "",
  config_path: "",
  stats_api: "",
});

// Inbounds must share the profile's core: filter the checkbox list by selected core.
const eligibleInbounds = computed<ProxyInboundView[]>(() =>
  inbounds.value.filter((inb) => inb.core === form.core),
);

const canSubmit = computed(
  () => !!form.node_id && form.inbound_ids.length > 0 && !saving.value,
);

// When the core changes, drop any selected inbounds that no longer match.
watch(
  () => form.core,
  () => {
    const allowed = new Set(eligibleInbounds.value.map((inb) => inb.id));
    form.inbound_ids = form.inbound_ids.filter((id) => allowed.has(id));
  },
);

function resetForm() {
  editingId.value = undefined;
  form.node_id = "";
  form.core = "sing-box";
  form.inbound_ids = [];
  form.hostname = "";
  form.listen_ip = "";
  form.config_path = "";
  form.stats_api = "";
}

function openCreate() {
  resetForm();
  formOpen.value = true;
}

function openEdit(profile: ProxyNodeProfileView) {
  editingId.value = profile.id;
  form.node_id = profile.node_id;
  form.core = (profile.core === "xray" ? "xray" : "sing-box") as ProxyCore;
  form.inbound_ids = [...profile.inbound_ids];
  form.hostname = profile.hostname ?? "";
  form.listen_ip = profile.listen_ip ?? "";
  form.config_path = profile.config_path ?? "";
  form.stats_api = profile.stats_api ?? "";
  formOpen.value = true;
}

function toggleInbound(id: string, checked: boolean) {
  if (checked) {
    if (!form.inbound_ids.includes(id)) form.inbound_ids = [...form.inbound_ids, id];
  } else {
    form.inbound_ids = form.inbound_ids.filter((value) => value !== id);
  }
}

async function submitForm() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    const req: ProxyNodeProfileUpsertRequest = {
      node_id: form.node_id,
      core: form.core,
      inbound_ids: [...form.inbound_ids],
      hostname: form.hostname.trim() || undefined,
      listen_ip: form.listen_ip.trim() || undefined,
      config_path: form.config_path.trim() || undefined,
      stats_api: form.stats_api.trim() || undefined,
    };
    await api.proxy.upsertProfile(req);
    toast.success(editingId.value ? t("proxy.profiles.toastUpdated") : t("proxy.profiles.toastCreated"));
    formOpen.value = false;
    resetForm();
    profilesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.profiles.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirm ────────────────────────────────────────────────────────────
const deleteTarget = ref<ProxyNodeProfileView | undefined>();
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.proxy.deleteProfile(deleteTarget.value.node_id);
    toast.success(t("proxy.profiles.toastDeleted"));
    deleteTarget.value = undefined;
    profilesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.profiles.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan → approve ────────────────────────────────────────────────────────────
const planning = ref<string | undefined>();
const planOpen = ref(false);
const planApproval = ref<ApprovalView | undefined>();
const planDigest = ref("");

async function planNode(profile: ProxyNodeProfileView) {
  if (!canPlan.value) return;
  planning.value = profile.node_id;
  try {
    const approval = await api.proxy.planNode(profile.node_id);
    planApproval.value = approval;
    planDigest.value = await sha256Hex(approval.plan || "");
    planOpen.value = true;
    toast.success(t("proxy.profiles.toastPlanCreated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.profiles.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

function closePlan(open: boolean) {
  planOpen.value = open;
  if (!open) {
    planApproval.value = undefined;
    planDigest.value = "";
  }
}

// Badges for the shared PlanReviewDialog (status / id / scope) — plain text only.
const planBadges = computed(() => {
  const approval = planApproval.value;
  if (!approval) return [];
  return [
    { label: approval.status, variant: "warning" as const },
    { label: t("proxy.profiles.idLabel", { id: shortId(approval.id, 12) }), variant: "outline" as const },
    { label: approval.node_id || t("common.misc.global"), variant: "secondary" as const },
  ];
});

function refreshAll() {
  profilesQuery.refresh();
  nodesQuery.refresh();
  inboundsQuery.refresh();
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.profiles.title')"
      :description="$t('proxy.profiles.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="profilesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="profilesQuery.refreshing.value"
          @click="refreshAll"
        >
          <RefreshCw :class="cn('size-4', profilesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('proxy.profiles.newProfile') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('proxy.profiles.kpiProfiles') }}</p>
            <p class="text-2xl font-semibold tabular">{{ profiles.length }}</p>
          </div>
          <ServerCog class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('proxy.profiles.kpiApplied') }}</p>
            <p class="text-2xl font-semibold tabular text-success">{{ appliedCount }}</p>
          </div>
          <Cpu class="size-5 text-success" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('proxy.profiles.kpiConfigDrift') }}</p>
            <p :class="cn('text-2xl font-semibold tabular', driftCount > 0 ? 'text-warning' : 'text-foreground')">
              {{ driftCount }}
            </p>
          </div>
          <AlertTriangle :class="cn('size-5', driftCount > 0 ? 'text-warning' : 'text-muted-foreground')" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>{{ $t('proxy.profiles.deploymentProfiles') }}</CardTitle>
        <CardDescription>
          {{ $t('proxy.profiles.deploymentProfilesDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="profileColumns"
          :rows="sortedProfiles"
          :row-key="(p) => p.id"
          :loading="profilesQuery.loading.value"
          :error="profilesQuery.error.value"
          :page-size="15"
          searchable
          :search-placeholder="$t('proxy.profiles.searchPlaceholder')"
          :empty-title="$t('proxy.profiles.emptyTitle')"
          :empty-description="$t('proxy.profiles.emptyDescription')"
          :no-match-title="$t('proxy.table.noMatchTitle')"
          :no-match-description="$t('proxy.table.noMatchDescription')"
          :actions-label="$t('proxy.profiles.colActions')"
          :showing-label="$t('proxy.table.showing')"
          :of-label="$t('proxy.table.of')"
          :page-of-label="$t('proxy.table.of')"
          :prev-label="$t('proxy.table.prevPage')"
          :next-label="$t('proxy.table.nextPage')"
          :clear-search-label="$t('proxy.table.clearSearch')"
          @retry="profilesQuery.refresh"
        >
          <template #cell-node="{ row }">
            <div class="min-w-0">
              <p class="truncate font-medium">{{ row.node_name || row.node_id }}</p>
              <p class="font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 16) }}</p>
            </div>
          </template>
          <template #cell-core="{ row }">
            <Badge :variant="coreVariant(row.core)">{{ row.core }}</Badge>
          </template>
          <template #cell-inbounds="{ row }">
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="tabular cursor-default">{{ row.inbound_ids.length }}</span>
              </TooltipTrigger>
              <TooltipContent v-if="row.inbound_ids.length" class="max-w-xs">
                <span class="break-words">{{ row.inbound_ids.map(inboundName).join(", ") }}</span>
              </TooltipContent>
            </Tooltip>
          </template>
          <template #cell-hostname="{ row }">
            <span v-if="row.hostname" class="font-mono text-xs">{{ row.hostname }}</span>
            <span v-else class="text-xs text-muted-foreground">—</span>
          </template>
          <template #cell-appliedConfig="{ row }">
            <div v-if="row.applied_sha256" class="flex items-center gap-1">
              <code class="font-mono text-xs">{{ shortId(row.applied_sha256, 12) }}</code>
              <CopyButton :value="row.applied_sha256" />
            </div>
            <span v-else class="text-xs text-muted-foreground">{{ $t('proxy.profiles.notApplied') }}</span>
          </template>
          <template #cell-drift="{ row }">
            <div class="flex flex-col gap-1">
              <Tooltip v-if="row.config_stale">
                <TooltipTrigger as-child>
                  <span class="w-fit cursor-default">
                    <Badge variant="warning">
                      <AlertTriangle class="size-3" aria-hidden="true" />
                      {{ $t('proxy.profiles.drift') }}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent class="max-w-xs">
                  <span class="break-words">{{ row.drift_reason || $t('proxy.profiles.driftReasonFallback') }}</span>
                </TooltipContent>
              </Tooltip>
              <span v-else class="text-xs text-muted-foreground">{{ $t('proxy.profiles.inSync') }}</span>
              <span
                v-if="row.ineligible_users && row.ineligible_users > 0"
                class="text-xs text-warning"
              >
                {{ $t('proxy.profiles.ineligibleUsers', { count: row.ineligible_users }, row.ineligible_users) }}
              </span>
            </div>
          </template>
          <template #cell-collector="{ row }">
            <Tooltip v-if="row.usage_collector_status === 'error'">
              <TooltipTrigger as-child>
                <span class="w-fit cursor-default">
                  <Badge variant="destructive">{{ $t('common.status.error') }}</Badge>
                </span>
              </TooltipTrigger>
              <TooltipContent class="max-w-xs">
                <span class="break-words">
                  {{ row.usage_collector_last_error || $t('proxy.profiles.collectorErrorFallback') }}
                </span>
              </TooltipContent>
            </Tooltip>
            <Badge v-else-if="row.usage_collector_status === 'ok'" variant="success">{{ $t('common.status.ok') }}</Badge>
            <span v-else class="text-xs text-muted-foreground">—</span>
          </template>
          <template #cell-lastApply="{ row }">
            <div class="min-w-0">
              <p class="text-xs text-muted-foreground">
                {{ row.last_apply_at ? formatRelativeTime(row.last_apply_at) : $t('common.misc.never') }}
              </p>
              <Tooltip v-if="row.last_error">
                <TooltipTrigger as-child>
                  <span class="cursor-default text-xs text-destructive">{{ $t('proxy.profiles.lastError') }}</span>
                </TooltipTrigger>
                <TooltipContent class="max-w-xs">
                  <span class="break-words">{{ row.last_error }}</span>
                </TooltipContent>
              </Tooltip>
            </div>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-1">
              <Button
                v-if="canPlan"
                variant="outline"
                size="sm"
                :disabled="planning === row.node_id"
                @click="planNode(row)"
              >
                <RefreshCw v-if="planning === row.node_id" class="size-4 animate-spin" aria-hidden="true" />
                <ArrowRight v-else class="size-4" aria-hidden="true" />
                {{ $t('proxy.profiles.plan') }}
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('proxy.profiles.editProfile')"
                @click="openEdit(row)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('proxy.profiles.deleteProfile')"
                @click="deleteTarget = row"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('proxy.profiles.dialogTitleEdit') : $t('proxy.profiles.dialogTitleNew') }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.profiles.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="grid gap-2">
            <Label>{{ $t('proxy.profiles.fieldNode') }}</Label>
            <Select v-model="form.node_id" :disabled="!!editingId">
              <SelectTrigger>
                <SelectValue :placeholder="$t('proxy.profiles.selectNode')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name || node.id }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="editingId" class="text-xs text-muted-foreground">
              {{ $t('proxy.profiles.nodeLocked') }}
            </p>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('proxy.profiles.fieldCore') }}</Label>
            <Select v-model="form.core">
              <SelectTrigger>
                <SelectValue :placeholder="$t('proxy.profiles.selectCore')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sing-box">sing-box</SelectItem>
                <SelectItem value="xray">xray</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('proxy.profiles.fieldInbounds') }}</Label>
            <div
              v-if="eligibleInbounds.length"
              class="grid max-h-56 gap-1 overflow-auto rounded-md border border-border p-2"
            >
              <label
                v-for="inb in eligibleInbounds"
                :key="inb.id"
                class="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  class="size-4 accent-primary"
                  :checked="form.inbound_ids.includes(inb.id)"
                  @change="toggleInbound(inb.id, ($event.target as HTMLInputElement).checked)"
                />
                <span class="min-w-0 flex-1 truncate">{{ inb.name || inb.id }}</span>
                <Badge variant="outline">:{{ inb.port }}</Badge>
                <Badge :variant="inb.enabled ? 'success' : 'secondary'">
                  {{ inb.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
                </Badge>
              </label>
            </div>
            <p v-else class="rounded-md border border-border p-3 text-xs text-muted-foreground">
              {{ $t('proxy.profiles.noMatchingInbounds', { core: form.core }) }}
            </p>
            <p class="text-xs text-muted-foreground">
              {{ $t('proxy.profiles.selectedCount', { count: form.inbound_ids.length }) }}
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="profile-hostname">{{ $t('proxy.profiles.fieldHostname') }}</Label>
              <Input id="profile-hostname" v-model="form.hostname" :placeholder="$t('proxy.profiles.optional')" />
            </div>
            <div class="grid gap-2">
              <Label for="profile-listen">{{ $t('proxy.profiles.fieldListenIp') }}</Label>
              <Input id="profile-listen" v-model="form.listen_ip" :placeholder="$t('proxy.profiles.optional')" />
            </div>
            <div class="grid gap-2">
              <Label for="profile-config-path">{{ $t('proxy.profiles.fieldConfigPath') }}</Label>
              <Input id="profile-config-path" v-model="form.config_path" :placeholder="$t('proxy.profiles.fieldConfigPathPlaceholder')" />
            </div>
            <div class="grid gap-2">
              <Label for="profile-stats-api">{{ $t('proxy.profiles.fieldStatsApi') }}</Label>
              <Input id="profile-stats-api" v-model="form.stats_api" :placeholder="$t('proxy.profiles.fieldStatsApiPlaceholder')" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" :disabled="saving" @click="formOpen = false">{{ $t('common.actions.cancel') }}</Button>
          <Button :disabled="!canSubmit" @click="submitForm">
            <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
            <Plus v-else class="size-4" aria-hidden="true" />
            {{ editingId ? $t('common.actions.saveChanges') : $t('proxy.profiles.createProfile') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('proxy.profiles.deleteTitle')"
      :description="$t('proxy.profiles.deleteConfirmPrefix') + ' ' + (deleteTarget?.node_name || deleteTarget?.node_id || '') + '. ' + $t('proxy.profiles.deleteConfirmSuffix')"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(o) => { if (!o) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Plan review (shared renderer; digest is the SAME sha256Hex(approval.plan) bytes) -->
    <PlanReviewDialog
      :open="planOpen"
      :plan-text="planApproval?.plan || ''"
      :digest="planDigest"
      :badges="planBadges"
      :title="$t('proxy.profiles.planTitle')"
      :description="$t('proxy.profiles.planDescription')"
      :plan-label="$t('proxy.profiles.plan')"
      :close-label="$t('common.actions.close')"
      :approvals-label="$t('proxy.profiles.reviewInApprovals')"
      approvals-to="/approvals"
      @update:open="closePlan"
    />
  </div>
</template>
