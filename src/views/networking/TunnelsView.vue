<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Cable,
  ChevronDown,
  ChevronRight,
  FileCode2,
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

const TUNNEL_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("tunnel:admin"));

// BARE ARRAY endpoint — do NOT unwrap.
const tunnelsQuery = useAsyncData(() => api.tunnels.list(), { pollInterval: 15000 });
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const tunnels = computed(() => tunnelsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedTunnels = computed(() =>
  [...tunnels.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

const expanded = ref<Record<string, boolean>>({});
function toggleExpand(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
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

// ── Plan → approval ─────────────────────────────────────────────────────────
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
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.tunnels.title')"
      :description="$t('networking.tunnels.description')"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="tunnelsQuery.refreshing.value"
          @click="tunnelsQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', tunnelsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.tunnels.newTunnel') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Cable class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('networking.tunnels.tunnels') }}
        </CardTitle>
        <CardDescription>
          {{ tunnels.length === 1 ? $t('networking.tunnels.tunnelCountOne', { count: tunnels.length }) : $t('networking.tunnels.tunnelCount', { count: tunnels.length }) }} ·
          {{ $t('networking.tunnels.credentialsNote') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="tunnelsQuery.loading.value"
          :error="tunnelsQuery.error.value"
          :has-data="tunnelsQuery.data.value !== undefined"
          :is-empty="tunnels.length === 0"
          :empty-title="$t('networking.tunnels.emptyTitle')"
          :empty-description="$t('networking.tunnels.emptyDescription')"
          @retry="tunnelsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.tunnels.colName') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.tunnels.colNode') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.tunnels.colTunnelId') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.tunnels.colCredentialsFile') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('networking.tunnels.colIngress') }}</th>
                  <th scope="col" class="py-2 pl-4 text-right font-medium">{{ $t('networking.tunnels.colActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="tunnel in sortedTunnels" :key="tunnel.id">
                  <tr class="border-b border-border hover:bg-muted/40">
                    <td class="py-3 pr-4">
                      <div class="font-medium">{{ tunnel.name || tunnel.id }}</div>
                      <div class="font-mono text-xs text-muted-foreground">{{ shortId(tunnel.id, 16) }}</div>
                    </td>
                    <td class="py-3 pr-4">{{ nodeName(tunnel.node_id) }}</td>
                    <td class="py-3 pr-4">
                      <div class="flex items-center gap-1">
                        <code class="font-mono text-xs">{{ shortId(tunnel.tunnel_id, 18) }}</code>
                        <CopyButton :value="tunnel.tunnel_id" />
                      </div>
                    </td>
                    <td class="py-3 pr-4 font-mono text-xs text-muted-foreground">
                      {{ tunnel.credentials_file || "—" }}
                    </td>
                    <td class="py-3 pr-4">
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs hover:bg-muted/60"
                        @click="toggleExpand(tunnel.id)"
                      >
                        <ChevronDown v-if="expanded[tunnel.id]" class="size-3.5" aria-hidden="true" />
                        <ChevronRight v-else class="size-3.5" aria-hidden="true" />
                        {{ tunnel.ingress.length === 1 ? $t('networking.tunnels.rulesCountOne', { count: tunnel.ingress.length }) : $t('networking.tunnels.rulesCount', { count: tunnel.ingress.length }) }}
                      </button>
                    </td>
                    <td class="py-3 pl-4">
                      <div class="flex justify-end gap-1">
                        <Button
                          v-if="canAdmin"
                          variant="ghost"
                          size="sm"
                          :disabled="planning === tunnel.id"
                          @click="openPlan(tunnel)"
                        >
                          <RefreshCw v-if="planning === tunnel.id" class="size-4 animate-spin" aria-hidden="true" />
                          <FileCode2 v-else class="size-4" aria-hidden="true" />
                          {{ $t('networking.shared.plan') }}
                        </Button>
                        <Button
                          v-if="canAdmin"
                          variant="ghost"
                          size="icon-sm"
                          :aria-label="$t('common.actions.delete')"
                          @click="deleteTarget = tunnel"
                        >
                          <Trash2 class="size-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  <tr v-if="expanded[tunnel.id]" class="border-b border-border bg-muted/20">
                    <td colspan="6" class="px-4 py-3">
                      <div class="space-y-1">
                        <div
                          v-for="(rule, index) in tunnel.ingress"
                          :key="index"
                          class="flex flex-wrap items-center gap-2 font-mono text-xs"
                        >
                          <span class="text-foreground">{{ rule.hostname }}</span>
                          <span class="text-muted-foreground">→</span>
                          <span class="text-foreground">{{ rule.service }}</span>
                          <Badge v-if="rule.path" variant="outline">{{ rule.path }}</Badge>
                        </div>
                      </div>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <!-- Create dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.tunnels.newTunnelTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.tunnels.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="tun-name">{{ $t('networking.tunnels.name') }}</Label>
              <Input id="tun-name" v-model="form.name" required placeholder="edge-tunnel" />
            </div>
            <div class="grid gap-2">
              <Label for="tun-node">{{ $t('networking.tunnels.nodeLabel') }}</Label>
              <Select v-model="form.node_id">
                <SelectTrigger id="tun-node">
                  <SelectValue :placeholder="$t('networking.tunnels.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
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
                class="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_120px_auto]"
              >
                <Input v-model="rule.hostname" :placeholder="$t('networking.tunnels.hostnamePlaceholder')" />
                <Input v-model="rule.service" :placeholder="$t('networking.tunnels.servicePlaceholder')" />
                <Input v-model="rule.path" :placeholder="$t('networking.tunnels.pathPlaceholder')" />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="$t('networking.tunnels.removeRule')"
                  :disabled="form.ingress.length === 1"
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
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.tunnels.deleteTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.tunnels.deleteDescription', { name: deleteTarget?.name || deleteTarget?.id }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

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
            <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ approval.plan }}</pre>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">sha256</span>
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
          <RouterLink to="/approvals">
            <Button type="button">{{ $t('networking.shared.goToApprovals') }}</Button>
          </RouterLink>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
