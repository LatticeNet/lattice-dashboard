<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Database,
  Gauge,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
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
import StatCard from "@/components/common/StatCard.vue";
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
const { t } = useI18n();

const usersQuery = useAsyncData(
  () => api.proxy.users().then((r) => unwrap(r, "users")),
  { pollInterval: 12000 },
);

const userSearch = ref("");
const statusFilter = ref<ProxyUserStatus | "all">("all");
const users = computed(() => usersQuery.data.value ?? []);
const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = computed(() => t("proxy.users.adminReason"));

const GiB = 1024 * 1024 * 1024;

const sortedUsers = computed(() =>
  [...users.value].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

const visibleUsers = computed(() => {
  const needle = userSearch.value.trim().toLowerCase();
  return sortedUsers.value.filter((user) => {
    if (statusFilter.value !== "all" && user.status !== statusFilter.value) return false;
    if (!needle) return true;
    return [user.name, user.id, user.status, ...(user.inbound_ids ?? [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
});

const activeUserCount = computed(() => users.value.filter((user) => user.status === "active").length);
const attentionUserCount = computed(() =>
  users.value.filter((user) => user.status === "expired" || user.status === "over_quota").length,
);
const tokenReadyCount = computed(() => users.value.filter((user) => user.has_sub_token).length);
const totalUsedBytes = computed(() =>
  users.value.reduce((sum, user) => sum + (user.used_bytes || 0), 0),
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
  return isUnlimited(user) ? t("proxy.users.unlimited") : formatBytes(user.traffic_limit_bytes);
}

function inboundScope(user: ProxyUserView): string {
  const ids = user.inbound_ids ?? [];
  return ids.length === 0
    ? t("common.misc.all")
    : t("proxy.users.scopeInbounds", { count: ids.length }, ids.length);
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
    toast.success(editingId.value ? t("proxy.users.toastUpdated") : t("proxy.users.toastCreated"));
    dialogOpen.value = false;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.users.toastSaveFailed"));
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
    toast.error(error instanceof Error ? error.message : t("proxy.users.toastRotateFailed"));
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
    toast.success(t("proxy.users.toastDeleted"));
    deleteOpen.value = false;
    deleteTarget.value = undefined;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.users.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.users.title')"
      :description="$t('proxy.users.description')"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="usersQuery.refreshing.value"
          @click="usersQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', usersQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('proxy.users.newUser') }}
        </Button>
        <Button v-else size="sm" disabled :title="adminReason">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('proxy.users.newUser') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('proxy.users.kpiTotal')" :value="users.length" :icon="Users" :hint="$t('proxy.users.kpiTokenReady', { count: tokenReadyCount })" />
      <StatCard :label="$t('proxy.users.kpiActive')" :value="activeUserCount" :icon="Gauge" tone="success" />
      <StatCard :label="$t('proxy.users.kpiAttention')" :value="attentionUserCount" :icon="TriangleAlert" :tone="attentionUserCount > 0 ? 'warning' : 'default'" />
      <StatCard :label="$t('proxy.users.kpiTraffic')" :value="formatBytes(totalUsedBytes)" :icon="Database" />
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Users class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('proxy.users.subscribers') }}
        </CardTitle>
        <CardDescription>
          {{ $t('proxy.users.subscribersDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="mb-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_180px]">
          <div class="relative">
            <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <Input v-model="userSearch" class="pl-8" :placeholder="$t('proxy.users.searchPlaceholder')" />
          </div>
          <select
            v-model="statusFilter"
            class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            <option value="all">{{ $t('proxy.users.filterAll') }}</option>
            <option value="active">{{ $t('common.status.active') }}</option>
            <option value="disabled">{{ $t('common.status.disabled') }}</option>
            <option value="expired">{{ $t('common.status.expired') }}</option>
            <option value="over_quota">{{ $t('common.status.overQuota') }}</option>
          </select>
          <div class="flex items-center justify-end text-xs text-muted-foreground">
            {{ $t('proxy.users.visibleCount', { visible: visibleUsers.length, total: users.length }) }}
          </div>
        </div>

        <DataState
          :loading="usersQuery.loading.value"
          :error="usersQuery.error.value"
          :is-empty="visibleUsers.length === 0"
          :empty-title="users.length === 0 ? $t('proxy.users.emptyTitle') : $t('proxy.users.noMatchesTitle')"
          :empty-description="users.length === 0 ? $t('proxy.users.emptyDescription') : $t('proxy.users.noMatchesDescription')"
          @retry="usersQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.users.colName') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.users.colStatus') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.users.colUsage') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.users.colExpires') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.users.colInboundScope') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.users.colSubToken') }}</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('proxy.users.colActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="user in visibleUsers"
                  :key="user.id"
                  class="border-b border-border hover:bg-muted/40"
                  :class="user.status === 'over_quota' && 'bg-destructive/5'"
                >
                  <td class="px-3 py-3">
                    <div class="font-medium">{{ user.name || shortId(user.id) }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(user.id, 16) }}</div>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="statusVariant(user.status)">{{ $t('common.status.' + (user.status === 'over_quota' ? 'overQuota' : user.status)) }}</Badge>
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
                      <div v-else class="text-xs text-muted-foreground">{{ $t('proxy.users.noQuotaLimit') }}</div>
                    </div>
                  </td>
                  <td class="px-3 py-3 text-xs">
                    <template v-if="user.expires_at">
                      <div>{{ formatDateTime(user.expires_at) }}</div>
                      <div class="text-muted-foreground">{{ formatRelativeTime(user.expires_at) }}</div>
                    </template>
                    <span v-else class="text-muted-foreground">{{ $t('common.misc.never') }}</span>
                  </td>
                  <td class="px-3 py-3 text-xs text-muted-foreground">
                    {{ inboundScope(user) }}
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="user.has_sub_token ? 'success' : 'secondary'" class="gap-1">
                      <Lock class="size-3" aria-hidden="true" />
                      {{ user.has_sub_token ? $t('common.status.set') : $t('common.misc.none') }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin || rotating === user.id"
                        :title="canAdmin ? $t('proxy.users.rotateToken') : adminReason"
                        :aria-label="$t('common.actions.rotate')"
                        @click="rotate(user)"
                      >
                        <RefreshCw v-if="rotating === user.id" class="size-4 animate-spin" />
                        <RotateCw v-else class="size-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin"
                        :title="canAdmin ? $t('proxy.users.editUser') : adminReason"
                        :aria-label="$t('common.actions.edit')"
                        @click="openEdit(user)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin"
                        :title="canAdmin ? $t('proxy.users.deleteUser') : adminReason"
                        :aria-label="$t('common.actions.delete')"
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
          <DialogTitle>{{ isEditing ? $t('proxy.users.dialogTitleEdit') : $t('proxy.users.dialogTitleNew') }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.users.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-2">
            <Label for="user-name">{{ $t('proxy.users.fieldName') }}</Label>
            <Input id="user-name" v-model="form.name" required :placeholder="$t('proxy.users.fieldNamePlaceholder')" />
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
            {{ $t('proxy.users.enabled') }}
          </label>

          <div class="grid gap-2">
            <Label for="user-inbounds">{{ $t('proxy.users.fieldInboundIds') }}</Label>
            <Input
              id="user-inbounds"
              v-model="form.inbound_ids"
              :placeholder="$t('proxy.users.fieldInboundIdsPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">
              {{ $t('proxy.users.inboundIdsHint') }}
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="user-quota">{{ $t('proxy.users.fieldTrafficLimit') }}</Label>
              <Input
                id="user-quota"
                v-model="form.traffic_limit_gb"
                type="number"
                min="0"
                step="0.1"
                :placeholder="$t('proxy.users.fieldTrafficLimitPlaceholder')"
              />
            </div>
            <div class="grid gap-2">
              <Label for="user-expires">{{ $t('proxy.users.fieldExpiresAt') }}</Label>
              <Input id="user-expires" v-model="form.expires_at" type="datetime-local" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="user-uuid">{{ $t('proxy.users.fieldUuid') }}</Label>
              <Input
                id="user-uuid"
                v-model="form.uuid"
                autocomplete="off"
                :placeholder="$t('proxy.users.autoGenerateKeep')"
              />
            </div>
            <div class="grid gap-2">
              <Label for="user-password">{{ $t('proxy.users.fieldPassword') }}</Label>
              <Input
                id="user-password"
                v-model="form.password"
                type="password"
                autocomplete="off"
                :placeholder="$t('proxy.users.autoGenerateKeep')"
              />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="user-subtoken">{{ $t('proxy.users.fieldSubToken') }}</Label>
            <Input
              id="user-subtoken"
              v-model="form.sub_token"
              autocomplete="off"
              :placeholder="$t('proxy.users.fieldSubTokenPlaceholder')"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!formValid || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <UserPlus v-else class="size-4" aria-hidden="true" />
              {{ isEditing ? $t('common.actions.saveChanges') : $t('proxy.users.createUser') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Rotate token: one-time reveal -->
    <Dialog :open="rotateOpen" @update:open="closeReveal">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ $t('proxy.users.revealTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.users.revealDescription', { name: revealed?.user.name || revealed?.user.id }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="revealed" class="space-y-4">
          <div class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{{ $t('proxy.users.revealWarning') }}</span>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('proxy.users.subscriptionUrl') }}</span>
              <CopyButton :value="revealed.subscription_url" :label="$t('common.actions.copy')" />
            </div>
            <code class="block break-all p-3 font-mono text-xs">{{ revealed.subscription_url }}</code>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('proxy.users.clientFormatUrls') }}</p>
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
            <span class="font-medium">{{ $t('proxy.users.tokenSha256') }}</span>
            <code class="break-all font-mono">{{ revealed.token_sha256 }}</code>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="closeReveal(false)">{{ $t('common.actions.done') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete dialog -->
    <Dialog v-model:open="deleteOpen">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('proxy.users.deleteTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.users.deleteConfirm', { name: deleteTarget?.name || deleteTarget?.id }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" @click="deleteOpen = false">{{ $t('common.actions.cancel') }}</Button>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
