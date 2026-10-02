<script setup lang="ts">
/**
 * Tunnels (design 23, section 4.4): Cloudflare tunnels that map public
 * hostnames to services on one node.
 *
 * With no tunnel the page is a checklist read from live state: whether a
 * node reports, whether the session may plan, and, honestly, that the
 * credentials file on the node cannot be checked from here. A row opens the
 * tunnel in the sheet on `?open=` with its ingress; Plan and Delete sit in
 * one row menu. The server keeps no apply state for a tunnel, so nothing
 * here claims one runs. Delete leaves cloudflared running on the node with
 * its last config (design 23, 3.8, "leaves config on a node"): the confirm
 * names the node and the hostnames that stay served, and asks for the name.
 */
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  FileCode2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type TunnelIngress,
  type TunnelUpsertRequest,
  type TunnelView,
} from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import { useProof } from "@/composables/useProof";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { describeNodeStatus } from "@/lib/nodeStatus";
import { proofReason } from "@/components/common/proofModel";
import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import SetupChecklist, { type SetupItem } from "@/components/networking/SetupChecklist.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import NodePicker from "@/components/common/NodePicker.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const TUNNEL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Where cloudflared expects the credentials JSON a tunnel cannot run without.
 * Named once rather than written into the copy, so the one string an operator
 * will retype is a mono path in both locales instead of prose either locale
 * can drift.
 */
const CREDENTIALS_PATH = "/etc/cloudflared/<tunnel id>.json";

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("tunnel:admin"));

// BARE ARRAY endpoint: do NOT unwrap.
const tunnelsQuery = useAsyncData((signal) => api.tunnels.list({ signal }), { pollInterval: 15000 });
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const tunnels = computed(() => tunnelsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedTunnels = computed(() =>
  [...tunnels.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || id;
}

// ── Create dialog ───────────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);

const form = reactive({
  name: "",
  node_id: "",
  tunnel_id: "",
  credentials_file: "",
  ingress: [{ hostname: "", service: "", path: "" }] as TunnelIngress[],
});

function resetForm() {
  form.name = "";
  form.node_id = "";
  form.tunnel_id = "";
  form.credentials_file = "";
  form.ingress = [{ hostname: "", service: "", path: "" }];
}

function openCreate() {
  if (!canAdmin.value) return;
  resetForm();
  formOpen.value = true;
}

/**
 * A half-filled tunnel form is real work: the tunnel id, the credentials path
 * and every ingress row. Confirm before an Escape or an overlay click drops it.
 */
const isDirty = computed(
  () =>
    !!form.name.trim() ||
    !!form.node_id ||
    !!form.tunnel_id.trim() ||
    !!form.credentials_file.trim() ||
    form.ingress.some(
      (rule) => rule.hostname.trim() || rule.service.trim() || rule.path?.trim(),
    ),
);
const discardOpen = ref(false);

function onFormOpenChange(next: boolean) {
  if (next) {
    formOpen.value = true;
    return;
  }
  if (isDirty.value && !saving.value) {
    discardOpen.value = true;
    return;
  }
  formOpen.value = false;
}

function confirmDiscard() {
  discardOpen.value = false;
  formOpen.value = false;
  resetForm();
}

function addRow() {
  form.ingress.push({ hostname: "", service: "", path: "" });
}
function removeRow(index: number) {
  form.ingress.splice(index, 1);
}

const tunnelIdValid = computed(() => TUNNEL_ID_RE.test(form.tunnel_id.trim()));
const credentialsPlaceholder = computed(() =>
  tunnelIdValid.value
    ? `/etc/cloudflared/${form.tunnel_id.trim()}.json`
    : "/etc/cloudflared/<tunnel_id>.json",
);

const validIngress = computed(() =>
  form.ingress.filter((rule) => rule.hostname.trim() && rule.service.trim()),
);

const canSubmit = computed(
  () =>
    !!form.name.trim() &&
    !!form.node_id &&
    tunnelIdValid.value &&
    validIngress.value.length > 0,
);

async function submitForm() {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: TunnelUpsertRequest = {
      name: form.name.trim(),
      node_id: form.node_id,
      tunnel_id: form.tunnel_id.trim(),
      ingress: validIngress.value.map((rule) => {
        const out: TunnelIngress = {
          hostname: rule.hostname.trim(),
          service: rule.service.trim(),
        };
        if (rule.path?.trim()) out.path = rule.path.trim();
        return out;
      }),
    };
    if (form.credentials_file.trim()) {
      req.credentials_file = form.credentials_file.trim();
    }
    await api.tunnels.create(req);
    toast.success(t("networking.tunnels.toastCreated"));
    formOpen.value = false;
    tunnelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.tunnels.toastCreateFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ─────────────────────────────────────────────────────
const deleteTarget = ref<TunnelView | undefined>();
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.tunnels.delete(deleteTarget.value.id);
    toast.success(t("networking.tunnels.toastDeleted"));
    deleteTarget.value = undefined;
    tunnelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.tunnels.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan to approval ─────────────────────────────────────────────────────────
const planOpen = ref(false);
const planning = ref<string | undefined>();
const approval = ref<ApprovalView | undefined>();
const planDigest = ref("");

async function openPlan(tunnel: TunnelView) {
  if (!canAdmin.value) return;
  planning.value = tunnel.id;
  try {
    const result = await api.tunnels.plan(tunnel.id);
    approval.value = result;
    planDigest.value = await sha256Hex(result.plan || "");
    planOpen.value = true;
    toast.success(t("networking.tunnels.toastPlanCreated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.tunnels.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}
/* ------------------------------------------------------------------ */
/* Head, attention, empty state, sheet (design 23, section 4.4)        */
/* ------------------------------------------------------------------ */

provideNodeDirectory(computed(() => nodesQuery.data.value));
const proof = useProof(tunnelsQuery);
const sheet = useRouteOpen();

const nodeById = computed(() => new Map(nodes.value.map((node) => [node.id, node])));

function tunnelName(tunnel: TunnelView): string {
  return tunnel.name || tunnel.id;
}

function hostnames(tunnel: TunnelView): string[] {
  return tunnel.ingress.map((rule) => rule.hostname).filter(Boolean);
}

const proofSegments = computed<ProofSegment[]>(() => {
  const n = tunnels.value.length;
  const parts: ProofSegment[] = [{ key: "tunnels", text: t("networking.tunnelsPage.proof.tunnels", { n }, n) }];
  if (n === 0) return parts;
  const hosts = tunnels.value.reduce((sum, tunnel) => sum + hostnames(tunnel).length, 0);
  parts.push({ key: "hostnames", text: t("networking.tunnelsPage.proof.hostnames", { n: hosts }, hosts) });
  if (nodesQuery.data.value !== undefined) {
    const down = tunnels.value.filter((tunnel) => {
      const node = nodeById.value.get(tunnel.node_id);
      return node && !describeNodeStatus(node).reporting;
    }).length;
    if (down) parts.push({ key: "down", text: t("networking.tunnelsPage.proof.down", { n: down }, down), tone: "warning" });
  }
  return parts;
});

function refreshAll(): void {
  void tunnelsQuery.refresh();
  void nodesQuery.refresh();
}

/**
 * What the console can check about a tunnel from here: whether its node
 * exists and reports. The server stores no apply state for a tunnel, so the
 * page never claims one is running.
 */
const attention = computed<AttentionItem[]>(() => {
  if (nodesQuery.data.value === undefined) return [];
  const items: AttentionItem[] = [];
  for (const tunnel of sortedTunnels.value) {
    const node = nodeById.value.get(tunnel.node_id);
    const open = { label: t("networking.tunnelsPage.attention.open"), run: () => sheet.open(tunnel.id) };
    if (!node) {
      items.push({
        key: `missing:${tunnel.id}`,
        tone: "danger",
        claim: t("networking.tunnelsPage.attention.missingClaim", { name: tunnelName(tunnel) }),
        proof: t("networking.tunnelsPage.attention.missingProof", { id: tunnel.node_id, hosts: hostnames(tunnel).join(", ") }),
        action: open,
      });
    } else if (!describeNodeStatus(node).reporting) {
      items.push({
        key: `down:${tunnel.id}`,
        tone: "warning",
        claim: t("networking.tunnelsPage.attention.downClaim", { name: tunnelName(tunnel), node: node.name, status: t(describeNodeStatus(node).labelKey) }),
        proof: t("networking.tunnelsPage.attention.downProof", { hosts: hostnames(tunnel).join(", ") }, Math.max(1, hostnames(tunnel).length)),
        action: open,
      });
    }
  }
  return items;
});

const listEmpty = computed(() => tunnelsQuery.data.value !== undefined && tunnels.value.length === 0);

const setupItems = computed<SetupItem[]>(() => {
  const nodesRead = nodesQuery.data.value !== undefined;
  const online = nodes.value.filter((node) => describeNodeStatus(node).reporting).length;
  return [
    {
      key: "cloudflared",
      label: t("networking.tunnelsPage.setup.cloudflared", { path: CREDENTIALS_PATH }),
      ready: null,
      detail: t("networking.tunnelsPage.setup.cloudflaredDetail"),
    },
    {
      key: "node",
      label: t("networking.tunnelsPage.setup.node"),
      ready: nodesRead ? online > 0 : null,
      detail: nodesRead
        ? t("networking.dnsPage.setup.nodeDetail", { online, total: nodes.value.length })
        : nodesQuery.error.value
          ? t("networking.setup.notRead", { reason: proofReason(nodesQuery.error.value) })
          : undefined,
    },
    {
      key: "scope",
      label: t("networking.tunnelsPage.setup.scope"),
      ready: canAdmin.value,
      detail: canAdmin.value ? t("networking.tunnelsPage.setup.scopeHeld") : t("networking.tunnelsPage.setup.scopeMissing"),
    },
  ];
});

const columns = computed<DataTableColumn<TunnelView>[]>(() => [
  { key: "name", label: t("networking.tunnels.colName"), sortable: true, searchable: true, value: (tunnel) => tunnelName(tunnel) },
  { key: "node", label: t("networking.tunnels.colNode"), sortable: true, searchable: true, value: (tunnel) => nodeName(tunnel.node_id) },
  { key: "hostnames", label: t("networking.tunnelsPage.colHostnames"), searchable: true, value: (tunnel) => hostnames(tunnel).join(" ") },
  { key: "tunnel_id", label: t("networking.tunnels.colTunnelId"), searchable: true },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const openTunnel = computed(() => tunnels.value.find((tunnel) => tunnel.id === sheet.openId.value));
const openNode = computed(() => (openTunnel.value ? nodeById.value.get(openTunnel.value.node_id) : undefined));
const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (openTunnel.value) return tunnelsQuery.error.value ? ("stale" as const) : ("ready" as const);
  if (tunnelsQuery.data.value === undefined) return tunnelsQuery.error.value ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

function menuFor(tunnel: TunnelView): RowMenuItem[] {
  return [
    { key: "plan", label: t("networking.shared.plan"), icon: Play, hidden: !canAdmin.value, disabled: planning.value === tunnel.id, run: () => void openPlan(tunnel) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = tunnel) },
  ];
}

const deleteImpact = computed(() => {
  const tunnel = deleteTarget.value;
  if (!tunnel) return [];
  const lines = [t("networking.tunnelsPage.delete.impactRunning", { node: nodeName(tunnel.node_id) })];
  const hosts = hostnames(tunnel);
  if (hosts.length) lines.push(t("networking.tunnelsPage.delete.impactHosts", { hosts: hosts.join(", ") }, hosts.length));
  lines.push(t("networking.tunnelsPage.delete.impactNoRemoval"));
  return lines;
});
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('networking.tunnels.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('networking.tunnels.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="tunnelsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', tunnelsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin && tunnels.length > 0" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.tunnels.newTunnel') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <SetupChecklist v-if="listEmpty" :title="$t('networking.tunnels.emptyTitle')" :items="setupItems">
      <!--
        Why there is no demo, above the checklist and the button: a tunnel
        saved without its credentials file plans cleanly and then fails on the
        node, so this has to be read before the click, not after it. The path
        is a path, set once and as code, so it is copied right.
      -->
      <template #description>
        <i18n-t keypath="networking.tunnelsPage.emptyDescription" tag="p" scope="global">
          <template #path>
            <code class="whitespace-nowrap font-mono text-xs text-foreground">{{ CREDENTIALS_PATH }}</code>
          </template>
        </i18n-t>
      </template>
      <Button v-if="canAdmin" size="sm" variant="outline" type="button" @click="openCreate">
        <Plus aria-hidden="true" />
        {{ $t('networking.tunnels.newTunnel') }}
      </Button>
    </SetupChecklist>

    <DataTable
      v-else
      state-key="tunnels"
      :columns="columns"
      :rows="sortedTunnels"
      :row-key="(tunnel) => tunnel.id"
      :loading="tunnelsQuery.loading.value"
      :error="tunnelsQuery.error.value"
      :has-data="tunnelsQuery.data.value !== undefined"
      searchable
      :expression-filter="false"
      :search-placeholder="$t('networking.tunnelsPage.searchPlaceholder')"
      :row-click="(tunnel, el) => sheet.open(tunnel.id, el)"
      :active-row-id="sheet.openId.value"
      :show-summary="false"
      :empty-title="$t('networking.tunnels.emptyTitle')"
      :empty-description="$t('networking.tunnels.emptyDescription')"
      :no-match-title="$t('networking.shared.noMatchTitle')"
      :no-match-description="$t('networking.shared.noMatchDescription')"
      @retry="refreshAll"
    >
      <template #cell-name="{ row: tunnel }">
        <span class="font-medium">{{ tunnelName(tunnel) }}</span>
      </template>
      <template #cell-node="{ row: tunnel }">
        <NodeLabel :id="tunnel.node_id" class="text-sm" />
      </template>
      <template #cell-hostnames="{ row: tunnel }">
        <div class="flex flex-col font-mono text-xs">
          <span v-for="host in hostnames(tunnel)" :key="host" class="whitespace-nowrap">{{ host }}</span>
        </div>
      </template>
      <template #cell-tunnel_id="{ row: tunnel }">
        <span class="whitespace-nowrap font-mono text-xs text-muted-foreground" :title="tunnel.tunnel_id">{{ shortId(tunnel.tunnel_id, 18) }}</span>
      </template>
      <template #cell-actions="{ row: tunnel }">
        <RowMenu v-if="canAdmin" :name="tunnelName(tunnel)" :items="menuFor(tunnel)" />
      </template>
    </DataTable>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openTunnel ? tunnelName(openTunnel) : (sheet.openId.value ?? '')"
      :subtitle="openTunnel ? openTunnel.tunnel_id : undefined"
      :state="sheetState"
      :error="tunnelsQuery.error.value ? proofReason(tunnelsQuery.error.value) : null"
      :read-only="!canAdmin"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('networking.tunnelsPage.goneTitle')"
      :gone-description="$t('networking.tunnelsPage.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="openTunnel" class="space-y-5 text-sm">
        <p class="text-muted-foreground">{{ $t('networking.tunnelsPage.sheet.noState') }}</p>
        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.tunnels.colNode') }}</dt>
            <dd class="flex flex-wrap items-center gap-x-2">
              <NodeLabel :id="openTunnel.node_id" :link="!!openNode" />
              <span v-if="openNode && !describeNodeStatus(openNode).reporting" class="text-xs text-warning-text">{{ $t(describeNodeStatus(openNode).labelKey) }}</span>
              <span v-else-if="!openNode && nodesQuery.data.value !== undefined" class="text-xs text-destructive">{{ $t('networking.tunnelsPage.sheet.nodeMissing') }}</span>
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.tunnels.colTunnelId') }}</dt>
            <dd class="flex items-center gap-1">
              <code class="break-all font-mono text-xs">{{ openTunnel.tunnel_id }}</code>
              <CopyButton :value="openTunnel.tunnel_id" />
            </dd>
          </div>
          <div class="min-w-0 sm:col-span-2">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.tunnels.colCredentialsFile') }}</dt>
            <dd class="break-all font-mono text-xs">{{ openTunnel.credentials_file || $t('networking.tunnelsPage.sheet.defaultPath', { path: CREDENTIALS_PATH }) }}</dd>
          </div>
        </dl>
        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.tunnelsPage.sheet.ingress', { n: openTunnel.ingress.length }, openTunnel.ingress.length) }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="(rule, index) in openTunnel.ingress" :key="index" class="flex flex-wrap items-baseline gap-x-2 px-3 py-2 font-mono text-xs">
              <span class="break-all text-foreground">{{ rule.hostname }}{{ rule.path ? rule.path : '' }}</span>
              <span class="text-muted-foreground">{{ $t('networking.shared.to') }}</span>
              <span class="break-all">{{ rule.service }}</span>
            </li>
          </ul>
        </section>
      </div>
      <template v-if="openTunnel" #actions>
        <Button variant="outline" size="sm" type="button" :disabled="planning === openTunnel.id" @click="openPlan(openTunnel)">
          <RefreshCw v-if="planning === openTunnel.id" class="animate-spin" aria-hidden="true" />
          <Play v-else aria-hidden="true" />
          {{ $t('networking.shared.plan') }}
        </Button>
        <RowMenu :name="tunnelName(openTunnel)" :items="menuFor(openTunnel).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

    <!-- Create dialog -->
    <Dialog :open="formOpen" @update:open="onFormOpenChange">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.tunnels.newTunnelTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.tunnels.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="tun-name">{{ $t('networking.tunnels.name') }}</Label>
              <Input id="tun-name" v-model="form.name" required placeholder="edge-tunnel" />
            </div>
            <NodePicker
              id="tun-node"
              v-model="form.node_id"
              :label="$t('networking.tunnels.nodeLabel')"
              :placeholder="$t('networking.tunnels.selectNode')"
            />
          </div>

          <div class="grid gap-2">
            <Label for="tun-id">{{ $t('networking.tunnels.tunnelId') }}</Label>
            <Input
              id="tun-id"
              v-model="form.tunnel_id"
              required
              :placeholder="$t('networking.tunnels.tunnelIdPlaceholder')"
              :class="cn(form.tunnel_id && !tunnelIdValid && 'border-destructive')"
            />
            <p v-if="form.tunnel_id && !tunnelIdValid" class="text-xs text-destructive">
              {{ $t('networking.tunnels.tunnelIdError') }}
            </p>
          </div>

          <div class="grid gap-2">
            <Label for="tun-creds">{{ $t('networking.tunnels.credentialsFile') }}</Label>
            <Input id="tun-creds" v-model="form.credentials_file" :placeholder="credentialsPlaceholder" />
            <p class="text-xs text-muted-foreground">
              {{ $t('networking.tunnels.credentialsHint') }}
              <code class="font-mono">{{ credentialsPlaceholder }}</code>.
            </p>
          </div>

          <div class="grid gap-2">
            <div class="flex items-center justify-between">
              <Label>{{ $t('networking.tunnels.ingressRules') }}</Label>
              <Button type="button" variant="outline" size="sm" @click="addRow">
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('networking.tunnels.addRule') }}
              </Button>
            </div>
            <div class="space-y-2">
              <div
                v-for="(rule, index) in form.ingress"
                :key="index"
                class="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_120px_auto]"
              >
                <Input
                  v-model="rule.hostname"
                  :aria-label="$t('networking.tunnels.hostnameAria', { index: index + 1 })"
                  :placeholder="$t('networking.tunnels.hostnamePlaceholder')"
                />
                <Input
                  v-model="rule.service"
                  :aria-label="$t('networking.tunnels.serviceAria', { index: index + 1 })"
                  :placeholder="$t('networking.tunnels.servicePlaceholder')"
                />
                <Input
                  v-model="rule.path"
                  :aria-label="$t('networking.tunnels.pathAria', { index: index + 1 })"
                  :placeholder="$t('networking.tunnels.pathPlaceholder')"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="$t('networking.tunnels.removeRule')"
                  :disabled="form.ingress.length === 1"
                  :title="form.ingress.length === 1 ? $t('networking.tunnels.removeRuleDisabled') : undefined"
                  @click="removeRow(index)"
                >
                  <X class="size-4" />
                </Button>
              </div>
            </div>
            <i18n-t keypath="networking.tunnels.serviceExamples" tag="p" class="text-xs text-muted-foreground" scope="global">
              <template #http>
                <code class="font-mono">http://localhost:8088</code>
              </template>
              <template #ssh>
                <code class="font-mono">ssh://localhost:22</code>
              </template>
              <template #status>
                <code class="font-mono">http_status:404</code>
              </template>
            </i18n-t>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="onFormOpenChange(false)">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete: cloudflared keeps running on the node (design 23, 3.8, "leaves config on a node"). -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.tunnelsPage.delete.title', { name: deleteTarget ? tunnelName(deleteTarget) : '' })"
      :description="$t('networking.tunnelsPage.delete.description')"
      :impact="deleteImpact"
      :impact-title="$t('networking.tunnelsPage.delete.impactTitle')"
      :typed-confirm="deleteTarget ? tunnelName(deleteTarget) : undefined"
      :confirm-label="$t('networking.tunnelsPage.delete.confirm')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Unsaved-changes guard: the form describes a whole tunnel. -->
    <ConfirmDialog
      :open="discardOpen"
      variant="destructive"
      :title="$t('networking.shared.discardTitle')"
      :description="$t('networking.shared.discardDescription')"
      :confirm-label="$t('networking.shared.discardConfirm')"
      :cancel-label="$t('common.actions.cancel')"
      @update:open="(v) => { if (!v) discardOpen = false; }"
      @confirm="confirmDiscard"
    />

    <!-- Plan dialog (creates a pending Approval) -->
    <Dialog v-model:open="planOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <FileCode2 class="size-5 text-muted-foreground" aria-hidden="true" />
            {{ $t('networking.tunnels.planTitle') }}
          </DialogTitle>
          <DialogDescription v-if="approval">
            {{ $t('networking.tunnels.planSubtitle', { plugin: approval.plugin, action: approval.action, node: nodeName(approval.node_id) }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="approval" class="space-y-4">
          <i18n-t keypath="networking.tunnels.planReviewHint" tag="div" class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground" scope="global">
            <template #approvals>
              <span class="font-medium text-foreground">{{ $t('networking.tunnels.approvalsLabel') }}</span>
            </template>
            <template #configYml>
              <code class="font-mono">config.yml</code>
            </template>
          </i18n-t>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">config.yml</span>
              <CopyButton :value="approval.plan || ''" />
            </div>
            <pre class="max-h-[420px] relative overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ approval.plan }}</pre>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">{{ $t('networking.shared.planTextSha256') }}</span>
            <code class="break-all font-mono">{{ planDigest }}</code>
            <CopyButton :value="planDigest" />
          </div>

          <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{{ $t('networking.tunnels.approvalLabel', { id: shortId(approval.id, 12) }) }}</Badge>
            <Badge variant="warning">{{ approval.status }}</Badge>
            <span v-if="approval.created_at">{{ formatDateTime(approval.created_at) }}</span>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.close') }}</Button>
          </DialogClose>
          <Button as-child>
            <RouterLink to="/approvals">{{ $t('networking.shared.goToApprovals') }}</RouterLink>
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
