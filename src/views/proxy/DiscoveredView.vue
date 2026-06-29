<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  CircleCheck,
  CircleX,
  Cpu,
  Info,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  type ProxyManagedAddRequest,
  type SingBoxInventory,
  type SingBoxNode,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import StatCard from "@/components/common/StatCard.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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

const auth = useAuthStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

// Read-only adoption bridge: on-box sing-box inventories reported by agents
// started with -singbox-discover. Poll modestly — this is observational.
const discoveredQuery = useAsyncData(() => api.proxy.discovered(), { pollInterval: 10000 });

// Write actions (Model-B adoption bridge) are gated on proxy:admin; with only
// proxy:read the add/delete controls are hidden entirely.
const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = computed(() => t("proxy.discovered.adminReason"));

const inventories = computed<SingBoxInventory[]>(
  () => discoveredQuery.data.value?.inventories ?? [],
);
const focusedNodeId = computed(() => String(route.query.node ?? "").trim());
const visibleInventories = computed(() => {
  const nodeId = focusedNodeId.value;
  if (!nodeId) return inventories.value;
  return inventories.value.filter((inv) => inv.node_id === nodeId);
});
const isEmpty = computed(() => visibleInventories.value.length === 0);

// Stable, machine-grouped ordering so cards don't reshuffle on every poll.
const sortedInventories = computed(() =>
  [...visibleInventories.value].sort((a, b) => a.node_id.localeCompare(b.node_id)),
);

// ── KPI strip ───────────────────────────────────────────────────────────────
const machineCount = computed(() => visibleInventories.value.length);
const totalNodes = computed(() =>
  visibleInventories.value.reduce((sum, inv) => sum + (inv.nodes?.length ?? 0), 0),
);
const errorCount = computed(
  () => visibleInventories.value.filter((inv) => !invOk(inv)).length,
);

function invOk(inv: SingBoxInventory): boolean {
  return (inv.status ?? "ok") === "ok" && !inv.error;
}

function clearNodeFilter() {
  const next = { ...route.query };
  delete next.node;
  router.replace({ query: next });
}

// Mask the credential-bearing share link: keep only the protocol scheme so the
// operator can recognise it, but never render the secret-bearing remainder.
function maskShareUrl(url?: string): string {
  if (!url) return "";
  const idx = url.indexOf("://");
  if (idx > 0) return `${url.slice(0, idx)}://••••••`;
  return "••••••";
}

// ── Protocol allowlist (UI subset) ───────────────────────────────────────────
// The value sent is the exact server token (e.g. "reality", "hy2", "ss"); only
// the visible label is decorated.
const PROTOCOLS: { value: string; label: string }[] = [
  { value: "reality", label: "reality" },
  { value: "vless", label: "vless" },
  { value: "vmess", label: "vmess" },
  { value: "trojan", label: "trojan" },
  { value: "hy2", label: "hysteria2 (hy2)" },
  { value: "ss", label: "shadowsocks (ss)" },
  { value: "tuic", label: "tuic" },
  { value: "anytls", label: "anytls" },
  { value: "socks", label: "socks" },
];

// ── Per-inventory node table ──────────────────────────────────────────────────
const nodeColumns = computed<DataTableColumn<SingBoxNode>[]>(() => {
  const cols: DataTableColumn<SingBoxNode>[] = [
    { key: "name", label: t("proxy.discovered.colName"), sortable: true, searchable: true, value: (n) => n.name || "" },
    { key: "protocol", label: t("proxy.discovered.colProtocol"), sortable: true, value: (n) => n.protocol || "" },
    { key: "network", label: t("proxy.discovered.colNetwork"), sortable: true, value: (n) => n.network || "" },
    { key: "port", label: t("proxy.discovered.colPort"), align: "right", sortable: true, value: (n) => n.port || "" },
    { key: "sni", label: t("proxy.discovered.colSni"), searchable: true, value: (n) => n.sni || "" },
    { key: "link", label: t("proxy.discovered.colLink"), align: "right" },
  ];
  if (canAdmin.value) {
    cols.push({ key: "actions", label: t("proxy.discovered.colActions"), align: "right" });
  }
  return cols;
});

function nodeKey(node: SingBoxNode): string {
  return `${node.name}|${node.address ?? ""}|${node.port ?? ""}|${node.protocol ?? ""}`;
}

// ── Add-node dialog (queues an async agent task) ──────────────────────────────
const addOpen = ref(false);
const addNodeId = ref<string | undefined>();
const addNodeLabel = ref("");
const addSaving = ref(false);
const addAttempted = ref(false);
const addForm = reactive({ protocol: "", port: "", arg1: "", arg2: "" });

function openAdd(inv: SingBoxInventory) {
  if (!canAdmin.value) return;
  addNodeId.value = inv.node_id;
  addNodeLabel.value = inv.node_id;
  addAttempted.value = false;
  addForm.protocol = "";
  addForm.port = "";
  addForm.arg1 = "";
  addForm.arg2 = "";
  addOpen.value = true;
}

const protocolValid = computed(() => addForm.protocol.trim().length > 0);
const addPortValid = computed(() => {
  if (!addForm.port.trim()) return true; // optional
  const n = Number(addForm.port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
});
const protocolError = computed(() =>
  addAttempted.value && !protocolValid.value ? t("proxy.discovered.errorProtocolRequired") : "",
);
const addPortError = computed(() =>
  addAttempted.value && !addPortValid.value ? t("proxy.discovered.errorPort") : "",
);
const addFormValid = computed(() => protocolValid.value && addPortValid.value);

async function submitAdd() {
  addAttempted.value = true;
  const nodeId = addNodeId.value;
  if (!nodeId || !addFormValid.value || addSaving.value) return;

  const input: ProxyManagedAddRequest = { node_id: nodeId, protocol: addForm.protocol };
  if (addForm.port.trim()) input.port = Number(addForm.port);
  const args = [addForm.arg1, addForm.arg2].map((a) => a.trim()).filter(Boolean);
  if (args.length) input.args = args;

  addSaving.value = true;
  try {
    // The endpoint returns a task_id, not the final node — surface the queued
    // task and let the next discovery poll reflect the change.
    const res = await api.proxy.managed.add(input);
    toast.success(t("proxy.discovered.toastAddQueued", { id: res.task_id }));
    addOpen.value = false;
    discoveredQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.discovered.toastAddFailed"));
  } finally {
    addSaving.value = false;
  }
}

// ── Delete-node confirm (queues an async agent task) ──────────────────────────
const deleteOpen = ref(false);
const deleteNodeId = ref<string | undefined>();
const deleteName = ref("");
const deleting = ref(false);

function askDelete(inv: SingBoxInventory, node: SingBoxNode) {
  if (!canAdmin.value) return;
  deleteNodeId.value = inv.node_id;
  deleteName.value = node.name;
  deleteOpen.value = true;
}

async function confirmDelete() {
  const nodeId = deleteNodeId.value;
  const name = deleteName.value;
  if (!nodeId || !name || deleting.value) return;
  deleting.value = true;
  try {
    const res = await api.proxy.managed.delete({ node_id: nodeId, name });
    toast.success(t("proxy.discovered.toastDeleteQueued", { id: res.task_id }));
    deleteOpen.value = false;
    discoveredQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.discovered.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.discovered.title')"
      :description="$t('proxy.discovered.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="discoveredQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="discoveredQuery.refreshing.value"
          @click="discoveredQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', discoveredQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3">
      <StatCard :label="$t('proxy.discovered.kpiMachines')" :value="machineCount" :icon="Server" />
      <StatCard :label="$t('proxy.discovered.kpiNodes')" :value="totalNodes" :icon="Boxes" tone="success" />
      <StatCard
        :label="$t('proxy.discovered.kpiErrors')"
        :value="errorCount"
        :icon="AlertTriangle"
        :tone="errorCount > 0 ? 'destructive' : undefined"
      />
    </div>

    <DataState
      :loading="discoveredQuery.loading.value"
      :error="discoveredQuery.error.value"
      :has-data="discoveredQuery.data.value !== undefined"
      :is-empty="isEmpty"
      :empty-title="$t('proxy.discovered.emptyTitle')"
      :empty-description="$t('proxy.discovered.emptyDescription')"
      @retry="discoveredQuery.refresh"
    >
      <div class="space-y-6">
        <div
          v-if="focusedNodeId"
          class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
        >
          <span class="min-w-0 truncate text-muted-foreground">
            {{ $t('proxy.discovered.filteredToNode', { node: focusedNodeId }) }}
          </span>
          <Button variant="ghost" size="sm" @click="clearNodeFilter">
            {{ $t('proxy.discovered.clearNodeFilter') }}
          </Button>
        </div>

        <!-- Write actions are asynchronous: queued on the agent, visible on the next poll. -->
        <div
          v-if="canAdmin"
          class="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
        >
          <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div class="space-y-0.5">
            <p class="font-medium text-foreground">{{ $t('proxy.discovered.asyncNoteTitle') }}</p>
            <p>{{ $t('proxy.discovered.asyncNoteBody') }}</p>
          </div>
        </div>

        <Card v-for="inv in sortedInventories" :key="inv.node_id">
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <CardTitle class="flex items-center gap-2">
                  <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <RouterLink
                    :to="{ name: 'node-detail', params: { id: inv.node_id } }"
                    class="inline-flex min-w-0 items-center gap-1 truncate font-mono text-sm hover:text-primary hover:underline"
                    :title="$t('proxy.discovered.viewNode')"
                  >
                    <span class="truncate">{{ inv.node_id }}</span>
                    <ArrowUpRight class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  </RouterLink>
                </CardTitle>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span class="inline-flex items-center gap-1">
                    <Cpu class="size-3.5" aria-hidden="true" />
                    {{ inv.core_version
                      ? $t('proxy.discovered.coreVersion', { version: inv.core_version })
                      : $t('proxy.discovered.coreUnknown') }}
                  </span>
                  <span>
                    {{ $t('proxy.discovered.reportedAt') }}:
                    <span :title="formatDateTime(inv.at)">{{ formatRelativeTime(inv.at) }}</span>
                  </span>
                  <span>{{ $t('proxy.discovered.nodeCount', { count: inv.nodes?.length ?? 0 }, inv.nodes?.length ?? 0) }}</span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Badge v-if="invOk(inv)" variant="success" class="gap-1">
                  <CircleCheck class="size-3" aria-hidden="true" />
                  {{ $t('proxy.discovered.statusOk') }}
                </Badge>
                <Badge v-else variant="destructive" class="gap-1">
                  <CircleX class="size-3" aria-hidden="true" />
                  {{ $t('proxy.discovered.statusError') }}
                </Badge>
                <Button
                  v-if="canAdmin"
                  size="sm"
                  variant="outline"
                  :title="$t('proxy.discovered.addNode')"
                  @click="openAdd(inv)"
                >
                  <Plus class="size-4" aria-hidden="true" />
                  {{ $t('proxy.discovered.addNode') }}
                </Button>
              </div>
            </div>

            <p
              v-if="inv.error"
              class="mt-2 break-words rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
            >
              {{ inv.error }}
            </p>
          </CardHeader>

          <CardContent>
            <DataTable
              :columns="nodeColumns"
              :rows="inv.nodes ?? []"
              :row-key="nodeKey"
              :page-size="0"
              :empty-title="$t('proxy.discovered.noNodes')"
              :actions-label="$t('proxy.discovered.colActions')"
              :showing-label="$t('proxy.table.showing')"
              :of-label="$t('proxy.table.of')"
              :page-of-label="$t('proxy.table.of')"
              :prev-label="$t('proxy.table.prevPage')"
              :next-label="$t('proxy.table.nextPage')"
            >
              <template #cell-name="{ row }">
                <span class="font-medium">{{ row.name || "—" }}</span>
              </template>
              <template #cell-protocol="{ row }">
                <Badge v-if="row.protocol" variant="outline">{{ row.protocol }}</Badge>
                <span v-else class="text-muted-foreground">—</span>
              </template>
              <template #cell-network="{ row }">
                <span class="font-mono text-xs text-muted-foreground">{{ row.network || "—" }}</span>
              </template>
              <template #cell-port="{ row }">
                <span class="font-mono text-xs tabular">{{ row.port || "—" }}</span>
              </template>
              <template #cell-sni="{ row }">
                <span class="font-mono text-xs text-muted-foreground">{{ row.sni || "—" }}</span>
              </template>
              <template #cell-link="{ row }">
                <div v-if="row.share_url" class="flex items-center justify-end gap-2">
                  <code
                    class="hidden max-w-[180px] truncate font-mono text-xs text-muted-foreground sm:inline"
                    :title="$t('proxy.discovered.linkHidden')"
                  >{{ maskShareUrl(row.share_url) }}</code>
                  <CopyButton :value="row.share_url" :label="$t('proxy.discovered.copyLink')" />
                </div>
                <span v-else class="text-xs text-muted-foreground">{{ $t('proxy.discovered.noLink') }}</span>
              </template>
              <template #cell-actions="{ row }">
                <div class="flex justify-end">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    :disabled="!canAdmin || !row.name"
                    :title="canAdmin ? $t('proxy.discovered.deleteNode') : adminReason"
                    :aria-label="$t('proxy.discovered.deleteNode')"
                    @click="askDelete(inv, row)"
                  >
                    <Trash2 class="size-4 text-destructive" />
                  </Button>
                </div>
              </template>
            </DataTable>
          </CardContent>
        </Card>
      </div>
    </DataState>

    <!-- Add node dialog (queues an async agent task) -->
    <Dialog v-model:open="addOpen">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t('proxy.discovered.addDialogTitle', { node: addNodeLabel }) }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.discovered.addDialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitAdd">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="managed-protocol">{{ $t('proxy.discovered.fieldProtocol') }}</Label>
              <Select v-model="addForm.protocol">
                <SelectTrigger
                  id="managed-protocol"
                  :aria-invalid="!!protocolError"
                  :class="cn(protocolError && 'border-destructive')"
                >
                  <SelectValue :placeholder="$t('proxy.discovered.selectProtocol')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="p in PROTOCOLS" :key="p.value" :value="p.value">
                    {{ p.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="protocolError" class="text-xs text-destructive">{{ protocolError }}</p>
            </div>
            <div class="grid gap-2">
              <Label for="managed-port">{{ $t('proxy.discovered.fieldPort') }}</Label>
              <Input
                id="managed-port"
                v-model="addForm.port"
                type="number"
                min="1"
                max="65535"
                :aria-invalid="!!addPortError"
                :class="cn(addPortError && 'border-destructive')"
                :placeholder="$t('proxy.discovered.fieldPortPlaceholder')"
              />
              <p v-if="addPortError" class="text-xs text-destructive">{{ addPortError }}</p>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="managed-arg1">{{ $t('proxy.discovered.fieldArg1') }}</Label>
              <Input
                id="managed-arg1"
                v-model="addForm.arg1"
                autocomplete="off"
                :placeholder="$t('proxy.discovered.fieldArg1Placeholder')"
              />
            </div>
            <div class="grid gap-2">
              <Label for="managed-arg2">{{ $t('proxy.discovered.fieldArg2') }}</Label>
              <Input
                id="managed-arg2"
                v-model="addForm.arg2"
                autocomplete="off"
                :placeholder="$t('proxy.discovered.fieldArg2Placeholder')"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('proxy.discovered.argsHint') }}</p>

          <DialogFooter>
            <Button type="button" variant="outline" @click="addOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!addFormValid || addSaving">
              <RefreshCw v-if="addSaving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t('proxy.discovered.addSubmit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete node confirm (queues an async agent task) -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('proxy.discovered.deleteTitle')"
      :description="$t('proxy.discovered.deleteConfirm', { name: deleteName })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @confirm="confirmDelete"
    />
  </div>
</template>
