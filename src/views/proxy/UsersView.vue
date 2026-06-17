<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { toast } from "vue-sonner";
import {
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  TriangleAlert,
  UserPlus,
  Users,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ProxyUserUpsertRequest,
  type ProxyUserStatus,
  type ProxyUserView,
  type RotateSubTokenResponse,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
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
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const auth = useAuthStore();

const usersQuery = useAsyncData(
  () => api.proxy.users().then((r) => unwrap(r, "users")),
  { pollInterval: 12000 },
);

const users = computed(() => usersQuery.data.value ?? []);
const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = "proxy:admin scope is required to manage users.";

const GiB = 1024 * 1024 * 1024;

const sortedUsers = computed(() =>
  [...users.value].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

function statusVariant(status: ProxyUserStatus): "success" | "warning" | "secondary" | "destructive" {
  if (status === "active") return "success";
  if (status === "expired" || status === "over_quota") return "warning";
  if (status === "disabled") return "secondary";
  return "secondary";
}

function usagePercent(user: ProxyUserView): number {
  const limit = user.traffic_limit_bytes ?? 0;
  if (limit <= 0) return 0;
  return Math.min(100, Math.max(0, (user.used_bytes / limit) * 100));
}

function isUnlimited(user: ProxyUserView): boolean {
  return !user.traffic_limit_bytes || user.traffic_limit_bytes <= 0;
}

function limitLabel(user: ProxyUserView): string {
  return isUnlimited(user) ? "unlimited" : formatBytes(user.traffic_limit_bytes);
}

function inboundScope(user: ProxyUserView): string {
  const ids = user.inbound_ids ?? [];
  return ids.length === 0 ? "all" : `${ids.length} inbound${ids.length === 1 ? "" : "s"}`;
}

// ---- Create / Edit dialog ----
interface FormState {
  id: string;
  name: string;
  enabled: boolean;
  inbound_ids: string;
  traffic_limit_gb: string;
  expires_at: string;
  uuid: string;
  password: string;
  sub_token: string;
}

const dialogOpen = ref(false);
const editingId = ref<string | undefined>();
const saving = ref(false);
const form = reactive<FormState>(blankForm());

function blankForm(): FormState {
  return {
    id: "",
    name: "",
    enabled: true,
    inbound_ids: "",
    traffic_limit_gb: "",
    expires_at: "",
    uuid: "",
    password: "",
    sub_token: "",
  };
}

const isEditing = computed(() => !!editingId.value);

function toDatetimeLocal(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openCreate() {
  if (!canAdmin.value) return;
  editingId.value = undefined;
  Object.assign(form, blankForm());
  dialogOpen.value = true;
}

function openEdit(user: ProxyUserView) {
  if (!canAdmin.value) return;
  editingId.value = user.id;
  Object.assign(form, {
    id: user.id,
    name: user.name,
    enabled: user.enabled,
    inbound_ids: (user.inbound_ids ?? []).join(", "),
    traffic_limit_gb:
      user.traffic_limit_bytes && user.traffic_limit_bytes > 0
        ? String(user.traffic_limit_bytes / GiB)
        : "0",
    expires_at: toDatetimeLocal(user.expires_at),
    uuid: "",
    password: "",
    sub_token: "",
  } satisfies FormState);
  dialogOpen.value = true;
}

const formValid = computed(() => form.name.trim().length > 0);

function splitList(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function submitForm() {
  if (!formValid.value || saving.value) return;

  const req: ProxyUserUpsertRequest = {
    name: form.name.trim(),
    enabled: form.enabled,
  };
  if (editingId.value) req.id = editingId.value;

  // empty list => applies to ALL inbounds (server semantics)
  req.inbound_ids = splitList(form.inbound_ids);

  const gb = Number(form.traffic_limit_gb);
  if (form.traffic_limit_gb.trim() !== "" && Number.isFinite(gb) && gb >= 0) {
    req.traffic_limit_bytes = Math.round(gb * GiB);
  }

  if (form.expires_at.trim()) {
    const d = new Date(form.expires_at);
    if (!Number.isNaN(d.getTime())) req.expires_at = d.toISOString();
  }

  if (form.uuid.trim()) req.uuid = form.uuid.trim();
  if (form.password.trim()) req.password = form.password.trim();
  if (form.sub_token.trim()) req.sub_token = form.sub_token.trim();

  saving.value = true;
  try {
    await api.proxy.upsertUser(req);
    toast.success(editingId.value ? "User updated" : "User created");
    dialogOpen.value = false;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to save user");
  } finally {
    saving.value = false;
  }
}

// ---- Rotate sub-token (one-time reveal) ----
const rotateOpen = ref(false);
const rotating = ref<string | undefined>();
const revealed = ref<RotateSubTokenResponse | undefined>();

function subFormats(baseUrl: string): { label: string; url: string }[] {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return [
    { label: "default (base64)", url: baseUrl },
    { label: "plain", url: `${baseUrl}${sep}format=plain` },
    { label: "sing-box", url: `${baseUrl}${sep}format=sing-box` },
    { label: "clash", url: `${baseUrl}${sep}format=clash` },
  ];
}

const revealedFormats = computed(() =>
  revealed.value ? subFormats(revealed.value.subscription_url) : [],
);

async function rotate(user: ProxyUserView) {
  if (!canAdmin.value || rotating.value) return;
  rotating.value = user.id;
  try {
    const result = await api.proxy.rotateSubToken(user.id);
    revealed.value = result;
    rotateOpen.value = true;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to rotate token");
  } finally {
    rotating.value = undefined;
  }
}

function closeReveal(open: boolean) {
  rotateOpen.value = open;
  if (!open) revealed.value = undefined;
}

// ---- Delete dialog ----
const deleteTarget = ref<ProxyUserView | undefined>();
const deleteOpen = ref(false);
const deleting = ref(false);

function askDelete(user: ProxyUserView) {
  if (!canAdmin.value) return;
  deleteTarget.value = user;
  deleteOpen.value = true;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target || deleting.value) return;
  deleting.value = true;
  try {
    await api.proxy.deleteUser(target.id);
    toast.success("User deleted");
    deleteOpen.value = false;
    deleteTarget.value = undefined;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to delete user");
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Proxy Users"
      description="Subscriber identities, quota, expiry, and subscription tokens"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="usersQuery.refreshing.value"
          @click="usersQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', usersQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          New user
        </Button>
        <Button v-else size="sm" disabled :title="adminReason">
          <Plus class="size-4" aria-hidden="true" />
          New user
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Users class="size-4 text-muted-foreground" aria-hidden="true" />
          Subscribers
        </CardTitle>
        <CardDescription>
          Secrets (uuid, password, sub-token) are write-only and never returned by reads.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="usersQuery.loading.value"
          :error="usersQuery.error.value"
          :is-empty="users.length === 0"
          empty-title="No proxy users"
          empty-description="Create a subscriber identity to issue a subscription token."
          @retry="usersQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" class="px-3 py-2 text-left font-medium">Name</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">Status</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">Usage</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">Expires</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">Inbound scope</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">Sub-token</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="user in sortedUsers"
                  :key="user.id"
                  class="border-b border-border hover:bg-muted/40"
                >
                  <td class="px-3 py-3">
                    <div class="font-medium">{{ user.name || shortId(user.id) }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(user.id, 16) }}</div>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="statusVariant(user.status)">{{ user.status }}</Badge>
                  </td>
                  <td class="px-3 py-3">
                    <div class="min-w-[160px] space-y-1">
                      <div class="flex items-center justify-between gap-2 text-xs">
                        <span class="font-mono tabular">{{ formatBytes(user.used_bytes) }}</span>
                        <span class="text-muted-foreground">/ {{ limitLabel(user) }}</span>
                      </div>
                      <Progress
                        v-if="!isUnlimited(user)"
                        :model-value="usagePercent(user)"
                        :indicator-class="usagePercent(user) >= 100 ? 'bg-warning' : undefined"
                      />
                      <div v-else class="text-xs text-muted-foreground">no quota limit</div>
                    </div>
                  </td>
                  <td class="px-3 py-3 text-xs">
                    <template v-if="user.expires_at">
                      <div>{{ formatDateTime(user.expires_at) }}</div>
                      <div class="text-muted-foreground">{{ formatRelativeTime(user.expires_at) }}</div>
                    </template>
                    <span v-else class="text-muted-foreground">never</span>
                  </td>
                  <td class="px-3 py-3 text-xs text-muted-foreground">
                    {{ inboundScope(user) }}
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="user.has_sub_token ? 'success' : 'secondary'" class="gap-1">
                      <Lock class="size-3" aria-hidden="true" />
                      {{ user.has_sub_token ? "set" : "none" }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin || rotating === user.id"
                        :title="canAdmin ? 'Rotate subscription token' : adminReason"
                        aria-label="Rotate"
                        @click="rotate(user)"
                      >
                        <RefreshCw v-if="rotating === user.id" class="size-4 animate-spin" />
                        <RotateCw v-else class="size-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin"
                        :title="canAdmin ? 'Edit user' : adminReason"
                        aria-label="Edit"
                        @click="openEdit(user)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin"
                        :title="canAdmin ? 'Delete user' : adminReason"
                        aria-label="Delete"
                        @click="askDelete(user)"
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

    <!-- Create / Edit dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ isEditing ? "Edit user" : "New user" }}</DialogTitle>
          <DialogDescription>
            Subscriber identity and quota. Secret fields are write-only — leave blank to keep / auto-generate.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-2">
            <Label for="user-name">Name *</Label>
            <Input id="user-name" v-model="form.name" required placeholder="alice" />
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
            Enabled
          </label>

          <div class="grid gap-2">
            <Label for="user-inbounds">Inbound IDs</Label>
            <Input
              id="user-inbounds"
              v-model="form.inbound_ids"
              placeholder="comma separated ids — leave empty for ALL inbounds"
            />
            <p class="text-xs text-muted-foreground">
              Empty means the user applies to every inbound. Provide ids to restrict scope.
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="user-quota">Traffic limit (GB)</Label>
              <Input
                id="user-quota"
                v-model="form.traffic_limit_gb"
                type="number"
                min="0"
                step="0.1"
                placeholder="0 = unlimited"
              />
            </div>
            <div class="grid gap-2">
              <Label for="user-expires">Expires at</Label>
              <Input id="user-expires" v-model="form.expires_at" type="datetime-local" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="user-uuid">UUID</Label>
              <Input
                id="user-uuid"
                v-model="form.uuid"
                autocomplete="off"
                placeholder="auto-generate / keep"
              />
            </div>
            <div class="grid gap-2">
              <Label for="user-password">Password</Label>
              <Input
                id="user-password"
                v-model="form.password"
                type="password"
                autocomplete="off"
                placeholder="auto-generate / keep"
              />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="user-subtoken">Subscription token</Label>
            <Input
              id="user-subtoken"
              v-model="form.sub_token"
              autocomplete="off"
              placeholder="auto-generate / keep — use Rotate to reveal a usable URL"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!formValid || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <UserPlus v-else class="size-4" aria-hidden="true" />
              {{ isEditing ? "Save changes" : "Create user" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Rotate token: one-time reveal -->
    <Dialog :open="rotateOpen" @update:open="closeReveal">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Subscription URL</DialogTitle>
          <DialogDescription>
            {{ revealed?.user.name || revealed?.user.id }} — copy now, the token is shown once.
          </DialogDescription>
        </DialogHeader>

        <div v-if="revealed" class="space-y-4">
          <div class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>Copy now — the token is shown once. Rotating again invalidates this URL.</span>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">Subscription URL</span>
              <CopyButton :value="revealed.subscription_url" label="Copy" />
            </div>
            <code class="block break-all p-3 font-mono text-xs">{{ revealed.subscription_url }}</code>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">Client format URLs</p>
            <div
              v-for="fmt in revealedFormats"
              :key="fmt.label"
              class="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
            >
              <div class="min-w-0">
                <p class="text-xs font-medium">{{ fmt.label }}</p>
                <code class="block break-all font-mono text-xs text-muted-foreground">{{ fmt.url }}</code>
              </div>
              <CopyButton :value="fmt.url" />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span class="font-medium">token sha256</span>
            <code class="break-all font-mono">{{ revealed.token_sha256 }}</code>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="closeReveal(false)">Done</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete dialog -->
    <Dialog v-model:open="deleteOpen">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete user</DialogTitle>
          <DialogDescription>
            Delete "{{ deleteTarget?.name || deleteTarget?.id }}"? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" @click="deleteOpen = false">Cancel</Button>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            Delete
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
