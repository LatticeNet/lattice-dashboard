<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const auth = useAuthStore();

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
    toast.success(editingId.value ? "Profile updated" : "Profile created");
    formOpen.value = false;
    resetForm();
    profilesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Profile save failed");
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
    toast.success("Profile deleted");
    deleteTarget.value = undefined;
    profilesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Profile delete failed");
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
    toast.success("Plan created — review in Approvals");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Plan failed");
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

function refreshAll() {
  profilesQuery.refresh();
  nodesQuery.refresh();
  inboundsQuery.refresh();
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Node Profiles"
      description="Per-node proxy deployment profiles, drift signals, and plan → approve"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="profilesQuery.refreshing.value"
          @click="refreshAll"
        >
          <RefreshCw :class="cn('size-4', profilesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          New profile
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Profiles</p>
            <p class="text-2xl font-semibold tabular">{{ profiles.length }}</p>
          </div>
          <ServerCog class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Applied</p>
            <p class="text-2xl font-semibold tabular text-success">{{ appliedCount }}</p>
          </div>
          <Cpu class="size-5 text-success" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Config drift</p>
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
        <CardTitle>Deployment Profiles</CardTitle>
        <CardDescription>
          Each profile binds a node to a core and a set of inbounds. Mutations flow through
          plan → approve → apply.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="profilesQuery.loading.value"
          :error="profilesQuery.error.value"
          :is-empty="profiles.length === 0"
          empty-title="No node profiles"
          empty-description="Create a profile to deploy a proxy core to a node."
          @retry="profilesQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="px-3 py-2 font-medium">Node</th>
                  <th scope="col" class="px-3 py-2 font-medium">Core</th>
                  <th scope="col" class="px-3 py-2 font-medium">Inbounds</th>
                  <th scope="col" class="px-3 py-2 font-medium">Hostname</th>
                  <th scope="col" class="px-3 py-2 font-medium">Applied config</th>
                  <th scope="col" class="px-3 py-2 font-medium">Drift</th>
                  <th scope="col" class="px-3 py-2 font-medium">Collector</th>
                  <th scope="col" class="px-3 py-2 font-medium">Last apply</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="profile in sortedProfiles"
                  :key="profile.id"
                  class="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td class="px-3 py-3">
                    <div class="min-w-0">
                      <p class="truncate font-medium">{{ profile.node_name || profile.node_id }}</p>
                      <p class="font-mono text-xs text-muted-foreground">{{ shortId(profile.node_id, 16) }}</p>
                    </div>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="coreVariant(profile.core)">{{ profile.core }}</Badge>
                  </td>
                  <td class="px-3 py-3">
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <span class="tabular cursor-default">{{ profile.inbound_ids.length }}</span>
                      </TooltipTrigger>
                      <TooltipContent v-if="profile.inbound_ids.length" class="max-w-xs">
                        <span class="break-words">
                          {{ profile.inbound_ids.map(inboundName).join(", ") }}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  </td>
                  <td class="px-3 py-3">
                    <span v-if="profile.hostname" class="font-mono text-xs">{{ profile.hostname }}</span>
                    <span v-else class="text-xs text-muted-foreground">—</span>
                  </td>
                  <td class="px-3 py-3">
                    <div v-if="profile.applied_sha256" class="flex items-center gap-1">
                      <code class="font-mono text-xs">{{ shortId(profile.applied_sha256, 12) }}</code>
                      <CopyButton :value="profile.applied_sha256" />
                    </div>
                    <span v-else class="text-xs text-muted-foreground">not applied</span>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex flex-col gap-1">
                      <Tooltip v-if="profile.config_stale">
                        <TooltipTrigger as-child>
                          <span class="w-fit cursor-default">
                            <Badge variant="warning">
                              <AlertTriangle class="size-3" aria-hidden="true" />
                              drift
                            </Badge>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent class="max-w-xs">
                          <span class="break-words">
                            {{ profile.drift_reason || "Rendered config differs from applied config." }}
                          </span>
                        </TooltipContent>
                      </Tooltip>
                      <span v-else class="text-xs text-muted-foreground">in sync</span>
                      <span
                        v-if="profile.ineligible_users && profile.ineligible_users > 0"
                        class="text-xs text-warning"
                      >
                        {{ profile.ineligible_users }} ineligible user{{ profile.ineligible_users === 1 ? "" : "s" }}
                      </span>
                    </div>
                  </td>
                  <td class="px-3 py-3">
                    <Tooltip v-if="profile.usage_collector_status === 'error'">
                      <TooltipTrigger as-child>
                        <span class="w-fit cursor-default">
                          <Badge variant="destructive">error</Badge>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent class="max-w-xs">
                        <span class="break-words">
                          {{ profile.usage_collector_last_error || "Usage collector reported an error." }}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                    <Badge v-else-if="profile.usage_collector_status === 'ok'" variant="success">ok</Badge>
                    <span v-else class="text-xs text-muted-foreground">—</span>
                  </td>
                  <td class="px-3 py-3">
                    <div class="min-w-0">
                      <p class="text-xs text-muted-foreground">
                        {{ profile.last_apply_at ? formatRelativeTime(profile.last_apply_at) : "never" }}
                      </p>
                      <Tooltip v-if="profile.last_error">
                        <TooltipTrigger as-child>
                          <span class="cursor-default text-xs text-destructive">last error</span>
                        </TooltipTrigger>
                        <TooltipContent class="max-w-xs">
                          <span class="break-words">{{ profile.last_error }}</span>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canPlan"
                        variant="outline"
                        size="sm"
                        :disabled="planning === profile.node_id"
                        @click="planNode(profile)"
                      >
                        <RefreshCw v-if="planning === profile.node_id" class="size-4 animate-spin" aria-hidden="true" />
                        <ArrowRight v-else class="size-4" aria-hidden="true" />
                        Plan
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit profile"
                        @click="openEdit(profile)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete profile"
                        @click="deleteTarget = profile"
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
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? "Edit node profile" : "New node profile" }}</DialogTitle>
          <DialogDescription>
            Bind a node to a proxy core and its inbounds. All inbounds must share the selected core.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="grid gap-2">
            <Label>Node</Label>
            <Select v-model="form.node_id" :disabled="!!editingId">
              <SelectTrigger>
                <SelectValue placeholder="Select a node" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name || node.id }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="editingId" class="text-xs text-muted-foreground">
              Node cannot be changed on an existing profile.
            </p>
          </div>

          <div class="grid gap-2">
            <Label>Core</Label>
            <Select v-model="form.core">
              <SelectTrigger>
                <SelectValue placeholder="Select a core" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sing-box">sing-box</SelectItem>
                <SelectItem value="xray">xray</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="grid gap-2">
            <Label>Inbounds</Label>
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
                  {{ inb.enabled ? "enabled" : "disabled" }}
                </Badge>
              </label>
            </div>
            <p v-else class="rounded-md border border-border p-3 text-xs text-muted-foreground">
              No inbounds use the "{{ form.core }}" core. Create a matching inbound first.
            </p>
            <p class="text-xs text-muted-foreground">
              {{ form.inbound_ids.length }} selected
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="profile-hostname">Hostname</Label>
              <Input id="profile-hostname" v-model="form.hostname" placeholder="optional" />
            </div>
            <div class="grid gap-2">
              <Label for="profile-listen">Listen IP</Label>
              <Input id="profile-listen" v-model="form.listen_ip" placeholder="optional" />
            </div>
            <div class="grid gap-2">
              <Label for="profile-config-path">Config path</Label>
              <Input id="profile-config-path" v-model="form.config_path" placeholder="optional, absolute" />
            </div>
            <div class="grid gap-2">
              <Label for="profile-stats-api">Stats API</Label>
              <Input id="profile-stats-api" v-model="form.stats_api" placeholder="host:port" />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" :disabled="saving" @click="formOpen = false">Cancel</Button>
          <Button :disabled="!canSubmit" @click="submitForm">
            <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
            <Plus v-else class="size-4" aria-hidden="true" />
            {{ editingId ? "Save changes" : "Create profile" }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm -->
    <Dialog :open="!!deleteTarget" @update:open="(o) => { if (!o) deleteTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete profile?</DialogTitle>
          <DialogDescription>
            This removes the profile for
            <span class="font-medium">{{ deleteTarget?.node_name || deleteTarget?.node_id }}</span>.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" :disabled="deleting" @click="deleteTarget = undefined">Cancel</Button>
          <Button variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            Delete
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Plan review -->
    <Dialog :open="planOpen" @update:open="closePlan">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plan created</DialogTitle>
          <DialogDescription>
            Review &amp; apply this plan under Operations → Approvals.
          </DialogDescription>
        </DialogHeader>

        <div v-if="planApproval" class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="warning">{{ planApproval.status }}</Badge>
            <Badge variant="outline">id {{ shortId(planApproval.id, 12) }}</Badge>
            <Badge variant="secondary">{{ planApproval.node_id || "global" }}</Badge>
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
            <code class="break-all font-mono">{{ planDigest }}</code>
            <CopyButton :value="planDigest" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="closePlan(false)">Close</Button>
          <RouterLink to="/approvals">
            <Button>
              Review in Approvals
              <ArrowRight class="size-4" aria-hidden="true" />
            </Button>
          </RouterLink>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
