<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import {
  ExternalLink,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type NFTInputsUpsertBody,
  type NFTInputsView,
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
const canPlan = computed(() => auth.can("network:plan"));

const inputsQuery = useAsyncData(() => api.nft.inputs().then((r) => unwrap(r, "inputs")), {
  pollInterval: 15000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});

const rows = computed(() => inputsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedRows = computed(() =>
  [...rows.value].sort((a, b) =>
    (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id),
  ),
);

function nodeLabel(row: NFTInputsView): string {
  return row.node_name || row.node_id;
}

// ── Create / edit dialog state ────────────────────────────────────────────
interface GuardForm {
  node_id: string;
  interface_name: string;
  wireguard_cidr: string;
  public_tcp: string;
  public_udp: string;
  wireguard_tcp: string;
  wireguard_udp: string;
}

const dialogOpen = ref(false);
const editingId = ref<string | undefined>(undefined);
const saving = ref(false);
const form = reactive<GuardForm>(emptyForm());

function emptyForm(): GuardForm {
  return {
    node_id: "",
    interface_name: "eth0",
    wireguard_cidr: "10.66.0.0/24",
    public_tcp: "",
    public_udp: "",
    wireguard_tcp: "",
    wireguard_udp: "",
  };
}

function joinPorts(ports?: number[]): string {
  return (ports ?? []).join(", ");
}

/** Parse a comma-separated port list into a sorted, deduped number[]. */
function parsePorts(input: string): number[] {
  const set = new Set<number>();
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) set.add(value);
  }
  return [...set].sort((a, b) => a - b);
}

function openCreate() {
  editingId.value = undefined;
  Object.assign(form, emptyForm());
  dialogOpen.value = true;
}

function openEdit(row: NFTInputsView) {
  editingId.value = row.node_id;
  Object.assign(form, {
    node_id: row.node_id,
    interface_name: row.interface_name || "eth0",
    wireguard_cidr: row.wireguard_cidr || "10.66.0.0/24",
    public_tcp: joinPorts(row.public_tcp),
    public_udp: joinPorts(row.public_udp),
    wireguard_tcp: joinPorts(row.wireguard_tcp),
    wireguard_udp: joinPorts(row.wireguard_udp),
  } satisfies GuardForm);
  dialogOpen.value = true;
}

function buildBody(): NFTInputsUpsertBody {
  return {
    node_id: form.node_id,
    interface_name: form.interface_name.trim() || "eth0",
    wireguard_cidr: form.wireguard_cidr.trim() || "10.66.0.0/24",
    public_tcp: parsePorts(form.public_tcp),
    public_udp: parsePorts(form.public_udp),
    wireguard_tcp: parsePorts(form.wireguard_tcp),
    wireguard_udp: parsePorts(form.wireguard_udp),
  };
}

const canSubmit = computed(() => !!form.node_id && canPlan.value);

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await api.nft.upsertInputs(buildBody());
    toast.success(editingId.value ? "Guard inputs updated" : "Guard inputs created");
    dialogOpen.value = false;
    inputsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to save guard inputs");
  } finally {
    saving.value = false;
  }
}

// ── Delete confirm ────────────────────────────────────────────────────────
const deleteTarget = ref<NFTInputsView | undefined>(undefined);
const deleting = ref(false);

function requestDelete(row: NFTInputsView) {
  deleteTarget.value = row;
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.nft.deleteInputs(deleteTarget.value.node_id);
    toast.success("Guard inputs deleted");
    deleteTarget.value = undefined;
    inputsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to delete guard inputs");
  } finally {
    deleting.value = false;
  }
}

// ── Plan dialog ───────────────────────────────────────────────────────────
const planning = ref<string | undefined>(undefined);
const planApproval = ref<ApprovalView | undefined>(undefined);
const planSha = ref("");

async function plan(row: NFTInputsView) {
  if (!canPlan.value) return;
  planning.value = row.node_id;
  try {
    const body: NFTInputsUpsertBody = {
      node_id: row.node_id,
      interface_name: row.interface_name,
      wireguard_cidr: row.wireguard_cidr,
      public_tcp: row.public_tcp ?? [],
      public_udp: row.public_udp ?? [],
      wireguard_tcp: row.wireguard_tcp ?? [],
      wireguard_udp: row.wireguard_udp ?? [],
    };
    const approval = await api.nft.plan(body);
    planApproval.value = approval;
    planSha.value = await sha256Hex(approval.plan || "");
    toast.success("Plan created — review in Approvals");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Plan failed");
  } finally {
    planning.value = undefined;
  }
}

function closePlan(open: boolean) {
  if (!open) {
    planApproval.value = undefined;
    planSha.value = "";
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Network Guard"
      description="Server-owned nftables baseline input set per node (lattice_guard, policy drop)"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="inputsQuery.refreshing.value"
          @click="inputsQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', inputsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
        <Button
          v-if="canPlan"
          size="sm"
          @click="openCreate"
        >
          <Plus class="size-4" aria-hidden="true" />
          New inputs
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Shield class="size-4 text-muted-foreground" aria-hidden="true" />
          Baseline firewall inputs
        </CardTitle>
        <CardDescription>
          Allowed public and WireGuard ports composed into the single guard input chain.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="inputsQuery.loading.value"
          :error="inputsQuery.error.value"
          :is-empty="rows.length === 0"
          empty-title="No guard inputs configured"
          empty-description="Create a baseline input set for a node to open its public or mesh ports."
          @retry="inputsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="py-2 pr-3 font-medium">Node</th>
                  <th scope="col" class="py-2 pr-3 font-medium">Interface</th>
                  <th scope="col" class="py-2 pr-3 font-medium">WireGuard CIDR</th>
                  <th scope="col" class="py-2 pr-3 font-medium">Public ports</th>
                  <th scope="col" class="py-2 pr-3 font-medium">WireGuard ports</th>
                  <th scope="col" class="py-2 pr-3 font-medium">Updated</th>
                  <th scope="col" class="py-2 pl-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in sortedRows"
                  :key="row.node_id"
                  class="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td class="py-3 pr-3">
                    <div class="font-medium">{{ nodeLabel(row) }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 16) }}</div>
                  </td>
                  <td class="py-3 pr-3 font-mono text-xs">{{ row.interface_name }}</td>
                  <td class="py-3 pr-3 font-mono text-xs">{{ row.wireguard_cidr }}</td>
                  <td class="py-3 pr-3">
                    <div class="flex flex-col gap-1">
                      <div class="flex flex-wrap items-center gap-1">
                        <span class="text-xs text-muted-foreground">tcp</span>
                        <template v-if="row.public_tcp?.length">
                          <Badge v-for="p in row.public_tcp" :key="`pt-${p}`" variant="outline">{{ p }}</Badge>
                        </template>
                        <span v-else class="text-xs text-muted-foreground">—</span>
                      </div>
                      <div class="flex flex-wrap items-center gap-1">
                        <span class="text-xs text-muted-foreground">udp</span>
                        <template v-if="row.public_udp?.length">
                          <Badge v-for="p in row.public_udp" :key="`pu-${p}`" variant="outline">{{ p }}</Badge>
                        </template>
                        <span v-else class="text-xs text-muted-foreground">—</span>
                      </div>
                    </div>
                  </td>
                  <td class="py-3 pr-3">
                    <div class="flex flex-col gap-1">
                      <div class="flex flex-wrap items-center gap-1">
                        <span class="text-xs text-muted-foreground">tcp</span>
                        <template v-if="row.wireguard_tcp?.length">
                          <Badge v-for="p in row.wireguard_tcp" :key="`wt-${p}`" variant="secondary">{{ p }}</Badge>
                        </template>
                        <span v-else class="text-xs text-muted-foreground">—</span>
                      </div>
                      <div class="flex flex-wrap items-center gap-1">
                        <span class="text-xs text-muted-foreground">udp</span>
                        <template v-if="row.wireguard_udp?.length">
                          <Badge v-for="p in row.wireguard_udp" :key="`wu-${p}`" variant="secondary">{{ p }}</Badge>
                        </template>
                        <span v-else class="text-xs text-muted-foreground">—</span>
                      </div>
                    </div>
                  </td>
                  <td class="py-3 pr-3 text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</td>
                  <td class="py-3 pl-3">
                    <div class="flex items-center justify-end gap-1">
                      <Button
                        v-if="canPlan"
                        variant="outline"
                        size="sm"
                        :disabled="planning === row.node_id"
                        @click="plan(row)"
                      >
                        <RefreshCw v-if="planning === row.node_id" class="size-4 animate-spin" aria-hidden="true" />
                        <Play v-else class="size-4" aria-hidden="true" />
                        Plan
                      </Button>
                      <Button
                        v-if="canPlan"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit"
                        @click="openEdit(row)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canPlan"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        @click="requestDelete(row)"
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
    <Dialog v-model:open="dialogOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? "Edit guard inputs" : "New guard inputs" }}</DialogTitle>
          <DialogDescription>
            Ports are comma-separated (1–65535). Server normalizes, dedupes, and sorts them.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submit">
          <div class="grid gap-2">
            <Label for="guard-node">Node</Label>
            <Select v-model="form.node_id" :disabled="!!editingId">
              <SelectTrigger id="guard-node" class="w-full">
                <SelectValue placeholder="Select a node" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name || node.id }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="guard-iface">Interface name</Label>
              <Input id="guard-iface" v-model="form.interface_name" placeholder="eth0" />
            </div>
            <div class="grid gap-2">
              <Label for="guard-cidr">WireGuard CIDR</Label>
              <Input id="guard-cidr" v-model="form.wireguard_cidr" placeholder="10.66.0.0/24" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="guard-public-tcp">Public TCP ports</Label>
              <Input id="guard-public-tcp" v-model="form.public_tcp" placeholder="80, 443" />
            </div>
            <div class="grid gap-2">
              <Label for="guard-public-udp">Public UDP ports</Label>
              <Input id="guard-public-udp" v-model="form.public_udp" placeholder="51820" />
            </div>
            <div class="grid gap-2">
              <Label for="guard-wg-tcp">WireGuard TCP ports</Label>
              <Input id="guard-wg-tcp" v-model="form.wireguard_tcp" placeholder="22" />
            </div>
            <div class="grid gap-2">
              <Label for="guard-wg-udp">WireGuard UDP ports</Label>
              <Input id="guard-wg-udp" v-model="form.wireguard_udp" placeholder="53" />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ editingId ? "Save changes" : "Create inputs" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm dialog -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete guard inputs</DialogTitle>
          <DialogDescription>
            Delete the baseline input set for
            <span class="font-medium">{{ deleteTarget ? nodeLabel(deleteTarget) : "" }}</span>?
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" @click="deleteTarget = undefined">Cancel</Button>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            Delete
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Plan review dialog -->
    <Dialog :open="!!planApproval" @update:open="closePlan">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plan created</DialogTitle>
          <DialogDescription>
            Review &amp; approve under Operations → Approvals. Nothing is applied until approved.
          </DialogDescription>
        </DialogHeader>
        <div v-if="planApproval" class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="warning">{{ planApproval.status }}</Badge>
            <Badge variant="outline">{{ planApproval.plugin }} · {{ planApproval.action }}</Badge>
            <Badge variant="secondary">id {{ shortId(planApproval.id, 12) }}</Badge>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">Plan</span>
              <CopyButton :value="planApproval.plan || ''" />
            </div>
            <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ planApproval.plan }}</pre>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">sha256</span>
            <code class="break-all font-mono">{{ planSha }}</code>
            <CopyButton :value="planSha" />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="closePlan(false)">Close</Button>
          <Button as-child>
            <RouterLink to="/approvals">
              <ExternalLink class="size-4" aria-hidden="true" />
              Go to Approvals
            </RouterLink>
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
