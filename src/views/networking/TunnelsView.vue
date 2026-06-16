<script setup lang="ts">
import { computed, reactive, ref } from "vue";
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
    toast.success("Tunnel created");
    formOpen.value = false;
    tunnelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Create failed");
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
    toast.success("Tunnel deleted");
    deleteTarget.value = undefined;
    tunnelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Delete failed");
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
    toast.success("Plan created — review in Approvals");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Plan failed");
  } finally {
    planning.value = undefined;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Tunnels"
      description="Cloudflare Tunnels (cloudflared) — map public hostnames to node-local services"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="tunnelsQuery.refreshing.value"
          @click="tunnelsQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', tunnelsQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" />
          New tunnel
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Cable class="size-4 text-muted-foreground" />
          Tunnels
        </CardTitle>
        <CardDescription>
          {{ tunnels.length }} {{ tunnels.length === 1 ? "tunnel" : "tunnels" }} ·
          credentials are node-local and never stored by the server
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="tunnelsQuery.loading.value"
          :error="tunnelsQuery.error.value"
          :is-empty="tunnels.length === 0"
          empty-title="No tunnels configured"
          empty-description="Create a cloudflared tunnel to expose node-local services."
          @retry="tunnelsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th class="py-2 pr-4 font-medium">Name</th>
                  <th class="py-2 pr-4 font-medium">Node</th>
                  <th class="py-2 pr-4 font-medium">Tunnel ID</th>
                  <th class="py-2 pr-4 font-medium">Credentials file</th>
                  <th class="py-2 pr-4 font-medium">Ingress</th>
                  <th class="py-2 pl-4 text-right font-medium">Actions</th>
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
                        <ChevronDown v-if="expanded[tunnel.id]" class="size-3.5" />
                        <ChevronRight v-else class="size-3.5" />
                        {{ tunnel.ingress.length }} {{ tunnel.ingress.length === 1 ? "rule" : "rules" }}
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
                          <RefreshCw v-if="planning === tunnel.id" class="size-4 animate-spin" />
                          <FileCode2 v-else class="size-4" />
                          Plan
                        </Button>
                        <Button
                          v-if="canAdmin"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Delete"
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
          <DialogTitle>New tunnel</DialogTitle>
          <DialogDescription>
            Describe a cloudflared tunnel. Credentials live node-local — the server only stores topology.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="tun-name">Name</Label>
              <Input id="tun-name" v-model="form.name" required placeholder="edge-tunnel" />
            </div>
            <div class="grid gap-2">
              <Label for="tun-node">Node</Label>
              <Select v-model="form.node_id">
                <SelectTrigger id="tun-node">
                  <SelectValue placeholder="Select a node" />
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
            <Label for="tun-id">Tunnel ID</Label>
            <Input
              id="tun-id"
              v-model="form.tunnel_id"
              required
              placeholder="cloudflare tunnel UUID or name"
              :class="cn(form.tunnel_id && !tunnelIdValid && 'border-destructive')"
            />
            <p v-if="form.tunnel_id && !tunnelIdValid" class="text-xs text-destructive">
              Must match ^[A-Za-z0-9._-]{1,128}$
            </p>
          </div>

          <div class="grid gap-2">
            <Label for="tun-creds">Credentials file</Label>
            <Input id="tun-creds" v-model="form.credentials_file" :placeholder="credentialsPlaceholder" />
            <p class="text-xs text-muted-foreground">
              Path on the node. Leave blank to default to
              <code class="font-mono">{{ credentialsPlaceholder }}</code>.
            </p>
          </div>

          <div class="grid gap-2">
            <div class="flex items-center justify-between">
              <Label>Ingress rules</Label>
              <Button type="button" variant="outline" size="sm" @click="addRow">
                <Plus class="size-4" />
                Add rule
              </Button>
            </div>
            <div class="space-y-2">
              <div
                v-for="(rule, index) in form.ingress"
                :key="index"
                class="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_120px_auto]"
              >
                <Input v-model="rule.hostname" placeholder="app.example.com" />
                <Input v-model="rule.service" placeholder="http://localhost:8088" />
                <Input v-model="rule.path" placeholder="path (opt)" />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove rule"
                  :disabled="form.ingress.length === 1"
                  @click="removeRow(index)"
                >
                  <X class="size-4" />
                </Button>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              Service examples: <code class="font-mono">http://localhost:8088</code>,
              <code class="font-mono">ssh://localhost:22</code>, or
              <code class="font-mono">http_status:404</code>. A catch-all 404 is appended automatically.
            </p>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" />
              <Plus v-else class="size-4" />
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete tunnel?</DialogTitle>
          <DialogDescription>
            Remove "{{ deleteTarget?.name || deleteTarget?.id }}". This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">Cancel</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" />
            <Trash2 v-else class="size-4" />
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Plan dialog (creates a pending Approval) -->
    <Dialog v-model:open="planOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <FileCode2 class="size-5 text-muted-foreground" />
            Tunnel config plan
          </DialogTitle>
          <DialogDescription v-if="approval">
            {{ approval.plugin }} / {{ approval.action }} on {{ nodeName(approval.node_id) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="approval" class="space-y-4">
          <div class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
            Plan created. Review and approve under
            <span class="font-medium text-foreground">Operations → Approvals</span> before the node applies it.
            The rendered <code class="font-mono">config.yml</code> references the credentials file path only —
            no credential material is embedded.
          </div>

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
            <Badge variant="outline">approval {{ shortId(approval.id, 12) }}</Badge>
            <Badge variant="warning">{{ approval.status }}</Badge>
            <span v-if="approval.created_at">{{ formatDateTime(approval.created_at) }}</span>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">Close</Button>
          </DialogClose>
          <RouterLink to="/approvals">
            <Button type="button">Go to Approvals</Button>
          </RouterLink>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
