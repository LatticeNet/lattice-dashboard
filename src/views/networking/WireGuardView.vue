<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  FileCode2,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Spline,
} from "lucide-vue-next";
import { api, unwrap, type ApprovalView, type Node } from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
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
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const PLACEHOLDER = "__LATTICE_WG_PRIVATE_KEY__";

const { t } = useI18n();
const auth = useAuthStore();
const canPlan = computed(() => auth.can("network:plan"));

const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const nodes = computed(() => nodesQuery.data.value ?? []);
const sortedNodes = computed(() =>
  [...nodes.value].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);
const meshReadyCount = computed(() => nodes.value.filter((n) => !!n.wireguard_ip).length);

const columns = computed<DataTableColumn<Node>[]>(() => [
  {
    key: "node",
    label: t("networking.wireguard.colNode"),
    sortable: true,
    searchable: true,
    value: (n) => n.name || n.id,
  },
  { key: "wireguard_ip", label: t("networking.wireguard.colWireguardIp"), sortable: true },
  { key: "endpoint", label: t("networking.wireguard.colEndpoint") },
  { key: "role", label: t("networking.wireguard.colRole"), sortable: true },
  { key: "status", label: t("networking.wireguard.colStatus"), sortable: true, value: (n) => (n.online && !n.disabled ? 1 : 0) },
  { key: "actions", label: t("networking.wireguard.colActions"), align: "right" },
]);

// ── Plan parameters dialog ──────────────────────────────────────────────────
const paramsOpen = ref(false);
const paramsNode = ref<Node | undefined>();
const listenPort = ref<string>("");
const planning = ref<string | undefined>();

function openParams(node: Node) {
  if (!canPlan.value) return;
  paramsNode.value = node;
  listenPort.value = "";
  paramsOpen.value = true;
}

// ── Plan result dialog ──────────────────────────────────────────────────────
const planOpen = ref(false);
const approval = ref<ApprovalView | undefined>();
const planDigest = ref("");

async function submitPlan() {
  if (!paramsNode.value || !canPlan.value) return;
  const node = paramsNode.value;
  planning.value = node.id;
  try {
    const trimmed = listenPort.value.trim();
    const port = trimmed ? Number(trimmed) : undefined;
    const result = await api.wireguard.plan({
      node_id: node.id,
      listen_port: port && port > 0 ? port : undefined,
    });
    approval.value = result;
    planDigest.value = await sha256Hex(result.plan || "");
    paramsOpen.value = false;
    planOpen.value = true;
    toast.success(t("networking.wireguard.toastPlanCreated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.wireguard.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.wireguard.title')"
      :description="$t('networking.wireguard.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="nodesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="nodesQuery.refreshing.value"
          @click="nodesQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Security explainer -->
    <Card class="border-info/40 bg-info/5">
      <CardContent class="flex items-start gap-3 p-4">
        <ShieldCheck class="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
        <div class="space-y-1 text-sm">
          <p class="font-medium">{{ $t('networking.wireguard.keysNeverReachServer') }}</p>
          <p class="text-muted-foreground">
            {{ $t('networking.wireguard.keysExplainerLead') }}
            <code class="font-mono">[Interface]</code> {{ $t('networking.wireguard.keysExplainerCarries') }}
            <code class="font-mono">{{ PLACEHOLDER }}</code>, {{ $t('networking.wireguard.keysExplainerSubstitutes') }}
            <span class="font-medium text-foreground">{{ $t('networking.wireguard.keysExplainerPublic') }}</span>
            {{ $t('networking.wireguard.keysExplainerKeys') }} <code class="font-mono">AllowedIPs</code> {{ $t('networking.wireguard.keysExplainerPinned') }}
            <code class="font-mono">/32</code> {{ $t('networking.wireguard.keysExplainerOr') }} <code class="font-mono">/128</code> {{ $t('networking.wireguard.keysExplainerHostRoute') }}
          </p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Spline class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('networking.wireguard.meshNodes') }}
        </CardTitle>
        <CardDescription>
          {{ nodes.length === 1 ? $t('networking.wireguard.meshReadyOne', { ready: meshReadyCount, total: nodes.length }) : $t('networking.wireguard.meshReady', { ready: meshReadyCount, total: nodes.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="sortedNodes"
          :row-key="(node) => node.id"
          :loading="nodesQuery.loading.value"
          :error="nodesQuery.error.value"
          searchable
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('networking.wireguard.emptyTitle')"
          :empty-description="$t('networking.wireguard.emptyDescription')"
          :no-match-title="$t('networking.shared.noMatchTitle')"
          :no-match-description="$t('networking.shared.noMatchDescription')"
          :actions-label="$t('networking.wireguard.colActions')"
          @retry="nodesQuery.refresh"
        >
          <template #cell-node="{ row: node }">
            <div class="font-medium">{{ node.name || node.id }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ shortId(node.id, 16) }}</div>
          </template>
          <template #cell-wireguard_ip="{ row: node }">
            <span v-if="node.wireguard_ip" class="font-mono text-xs">{{ node.wireguard_ip }}</span>
            <span v-else class="font-mono text-xs text-warning">{{ $t('networking.wireguard.notSet') }}</span>
          </template>
          <template #cell-endpoint="{ row: node }">
            <span class="font-mono text-xs text-muted-foreground">{{ node.wireguard_endpoint || "—" }}</span>
          </template>
          <template #cell-role="{ row: node }">
            <Badge v-if="node.role" variant="outline">{{ node.role }}</Badge>
            <span v-else class="text-xs text-muted-foreground">—</span>
          </template>
          <template #cell-status="{ row: node }">
            <StatusDot :online="node.online && !node.disabled" :label="node.online ? $t('common.status.online') : $t('common.status.offline')" />
          </template>
          <template #cell-actions="{ row: node }">
            <div class="flex justify-end">
              <Button
                v-if="canPlan"
                variant="outline"
                size="sm"
                :disabled="planning === node.id || !node.wireguard_ip"
                :title="!node.wireguard_ip ? $t('networking.wireguard.noWireguardIp') : undefined"
                @click="openParams(node)"
              >
                <RefreshCw v-if="planning === node.id" class="size-4 animate-spin" aria-hidden="true" />
                <FileCode2 v-else class="size-4" aria-hidden="true" />
                {{ $t('networking.wireguard.planMeshConfig') }}
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <!-- Plan parameters dialog -->
    <Dialog v-model:open="paramsOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.wireguard.planMeshTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.wireguard.planMeshDescription', { node: paramsNode?.name || paramsNode?.id }) }}
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="grid gap-2">
            <Label for="wg-listen-port">{{ $t('networking.wireguard.listenPort') }}</Label>
            <Input
              id="wg-listen-port"
              v-model="listenPort"
              type="number"
              min="1"
              max="65535"
              :placeholder="$t('networking.wireguard.listenPortPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">{{ $t('networking.wireguard.listenPortHint') }}</p>
          </div>
        </div>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button
            type="button"
            :disabled="planning === paramsNode?.id"
            @click="submitPlan"
          >
            <RefreshCw v-if="planning === paramsNode?.id" class="size-4 animate-spin" aria-hidden="true" />
            <FileCode2 v-else class="size-4" aria-hidden="true" />
            {{ $t('networking.shared.plan') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Plan result dialog (creates a pending Approval) -->
    <Dialog v-model:open="planOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <FileCode2 class="size-5 text-muted-foreground" aria-hidden="true" />
            {{ $t('networking.wireguard.planTitle') }}
          </DialogTitle>
          <DialogDescription v-if="approval">
            {{ $t('networking.wireguard.planSubtitle', { plugin: approval.plugin, action: approval.action, node: nodeName(approval.node_id) }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="approval" class="space-y-4">
          <i18n-t keypath="networking.wireguard.planReviewHint" tag="div" class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground" scope="global">
            <template #approvals>
              <span class="font-medium text-foreground">{{ $t('networking.wireguard.approvalsLabel') }}</span>
            </template>
          </i18n-t>

          <div class="flex items-start gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-xs text-muted-foreground">
            <KeyRound class="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
            <p>
              <code class="font-mono">[Interface]</code> {{ $t('networking.wireguard.keyNoticeInterface') }}
              <code class="font-mono">{{ PLACEHOLDER }}</code> — {{ $t('networking.wireguard.keyNoticeSubstitutes') }}
            </p>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">wg0.conf</span>
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
            <Badge variant="outline">{{ $t('networking.wireguard.approvalLabel', { id: shortId(approval.id, 12) }) }}</Badge>
            <Badge variant="warning">{{ approval.status }}</Badge>
            <span v-if="approval.created_at">{{ formatDateTime(approval.created_at) }}</span>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.close') }}</Button>
          </DialogClose>
          <RouterLink to="/approvals">
            <Button type="button">{{ $t('networking.shared.goToApprovals') }}</Button>
          </RouterLink>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
