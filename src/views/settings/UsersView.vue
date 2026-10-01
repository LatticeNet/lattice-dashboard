<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Pencil, Plus, RefreshCw, ShieldCheck, Trash2, UserCog } from "lucide-vue-next";
import {
  api,
  unwrap,
  type UserCreateRequest,
  type UserUpdateRequest,
  type UserView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import ScopePicker from "@/components/settings/ScopePicker.vue";
import { SCOPE_CATALOG } from "@/lib/scopes";

import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { useProof } from "@/composables/useProof";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("user:admin"));
const isSuperuser = computed(() => auth.scopes.includes("*"));

// Scopes this admin may grant: the full catalog when superuser, else only those
// they hold (the server enforces the same subset rule and is authoritative).
const grantableScopes = computed(() =>
  isSuperuser.value ? [...SCOPE_CATALOG] : SCOPE_CATALOG.filter((scope) => auth.canGrant(scope)),
);

// Operator-only data changes only when an operator changes it, here or in
// another tab; it is read once and on Refresh, never polled (design 23,
// section 3.10).
const usersQuery = useAsyncData((signal) => api.users.list({ signal }).then((r) => unwrap(r, "users")));
const users = computed(() => usersQuery.data.value ?? []);
const sortedUsers = computed(() =>
  [...users.value].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")),
);

// ── Create / Edit dialog ─────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const submitAttempted = ref(false);
const editing = ref<UserView | undefined>();

const form = reactive({
  username: "",
  fullAdmin: false,
  scopes: [] as string[],
  // Comma-separated node ids, matching the token form so the two places that
  // confine a principal ask for it the same way. Empty means every node.
  serverAllowlist: "",
  password: "",
});

function resetForm() {
  form.username = "";
  form.fullAdmin = false;
  form.scopes = [];
  form.serverAllowlist = "";
  form.password = "";
  submitAttempted.value = false;
}

function openCreate() {
  if (!canAdmin.value) return;
  editing.value = undefined;
  resetForm();
  formOpen.value = true;
}

function openEdit(user: UserView) {
  if (!canAdmin.value) return;
  editing.value = user;
  form.username = user.username;
  form.fullAdmin = user.scopes.includes("*");
  form.scopes = user.scopes.filter((s) => s !== "*");
  form.serverAllowlist = (user.server_allowlist ?? []).join(", ");
  form.password = "";
  submitAttempted.value = false;
  formOpen.value = true;
}

const effectiveScopes = computed(() => (form.fullAdmin ? ["*"] : [...form.scopes]));

const effectiveAllowlist = computed(() =>
  form.serverAllowlist
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);
const usernameError = computed(() =>
  submitAttempted.value && !editing.value && !form.username.trim()
    ? t("settings.users.form.usernameRequired")
    : undefined,
);
const scopesError = computed(() =>
  submitAttempted.value && effectiveScopes.value.length === 0
    ? t("settings.users.form.scopesRequired")
    : undefined,
);
const canSubmit = computed(
  () => (editing.value || !!form.username.trim()) && effectiveScopes.value.length > 0,
);

async function submitForm() {
  submitAttempted.value = true;
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    if (editing.value) {
      // Always sent when editing, including as [], because the dialog shows the
      // current confinement and clearing the field is how you widen the account.
      const req: UserUpdateRequest = {
        id: editing.value.id,
        scopes: effectiveScopes.value,
        server_allowlist: effectiveAllowlist.value,
      };
      if (form.password.trim()) req.password = form.password;
      await api.users.update(req);
      toast.success(t("settings.users.toast.updated"));
    } else {
      const req: UserCreateRequest = {
        username: form.username.trim(),
        scopes: effectiveScopes.value,
      };
      if (effectiveAllowlist.value.length) req.server_allowlist = effectiveAllowlist.value;
      if (form.password.trim()) req.password = form.password;
      await api.users.create(req);
      toast.success(t("settings.users.toast.created"));
    }
    formOpen.value = false;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("settings.users.toast.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<UserView | undefined>();
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.users.delete(deleteTarget.value.id);
    toast.success(t("settings.users.toast.deleted"));
    deleteTarget.value = undefined;
    usersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("settings.users.toast.deleteFailed"));
  } finally {
    deleting.value = false;
  }
}

const columns = computed<DataTableColumn<UserView>[]>(() => [
  {
    key: "username",
    label: t("settings.users.list.username"),
    sortable: true,
    searchable: true,
    value: (row) => row.username,
  },
  {
    key: "scopes",
    label: t("settings.users.list.scopes"),
    searchable: true,
    filterAliases: ["scope", "permission", "rbac"],
    value: (row) => (row.scopes.includes("*") ? ["full-admin", "admin", "*"] : row.scopes).join(" "),
  },
  {
    key: "server_allowlist",
    label: t("settings.users.list.serverAllowlist"),
    searchable: true,
    filterAliases: ["allowlist", "nodes", "confined", "scope"],
    // Searchable as "all-nodes" too, so an operator can find the accounts that
    // are not confined, which is the question worth asking of this column.
    value: (row) =>
      row.server_allowlist?.length ? row.server_allowlist.join(" ") : "all-nodes",
  },
  {
    key: "login",
    label: t("settings.users.list.login"),
    searchable: true,
    filterAliases: ["auth", "method"],
    sortable: true,
    value: (row) => [row.has_password ? "password" : "sso-only", row.totp_enabled ? "2fa" : ""].filter(Boolean).join(" "),
  },
  {
    key: "created_at",
    label: t("settings.users.list.created"),
    sortable: true,
    align: "right",
    class: "tabular",
  },
  { key: "actions", label: t("settings.users.list.actions"), align: "right" },
]);

/* The proof line (design 23, section 3.1): read once, so no age promise. */
const proof = useProof(usersQuery);
const proofSegments = computed<ProofSegment[]>(() => {
  const n = users.value.length;
  const parts: ProofSegment[] = [{ key: "users", text: t("settings.access.proof.users", { n }, n) }];
  if (n) {
    const admins = users.value.filter((user) => user.scopes.includes("*")).length;
    const totp = users.value.filter((user) => user.totp_enabled).length;
    parts.push({ key: "admins", text: t("settings.access.proof.admins", { n: admins }) });
    parts.push({ key: "totp", text: t("settings.access.proof.totp", { n: totp, total: n }) });
  }
  return parts;
});

function menuFor(user: UserView): RowMenuItem[] {
  return [
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, hidden: !canAdmin.value, run: () => openEdit(user) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = user) },
  ];
}
</script>

<template>
  <!-- One layer of the Access page (design 23, section 4.6): the page owns the heading and the tab row. -->
  <section class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="min-w-0 space-y-1">
        <p class="text-sm text-muted-foreground">{{ $t('settings.users.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="usersQuery.refresh" />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" :disabled="usersQuery.refreshing.value" @click="usersQuery.refresh">
          <RefreshCw :class="cn('size-4', usersQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin && users.length" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('settings.users.newUser') }}
        </Button>
      </div>
    </div>

    <DataTable
      state-key="users"
      :columns="columns"
      :rows="sortedUsers"
      :row-key="(user) => user.id"
      :loading="usersQuery.loading.value"
      :error="usersQuery.error.value"
      :has-data="usersQuery.data.value !== undefined"
      :searchable="users.length > 6"
      :expression-filter="false"
      :search-placeholder="$t('common.actions.search')"
      :empty-title="$t('settings.users.list.emptyTitle')"
      :empty-description="$t('settings.users.list.emptyDescription')"
      @retry="usersQuery.refresh"
    >
      <template #empty>
        <EmptyState :icon="UserCog" :title="$t('settings.users.list.emptyTitle')" :description="$t('settings.users.list.emptyDescription')">
          <Button v-if="canAdmin" size="sm" @click="openCreate">
            <Plus class="size-4" aria-hidden="true" />
            {{ $t('settings.users.newUser') }}
          </Button>
        </EmptyState>
      </template>

      <template #cell-username="{ row }">
        <div class="font-medium">{{ row.username }}</div>
        <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
      </template>

      <template #cell-scopes="{ row }">
        <Badge v-if="row.scopes.includes('*')" variant="default" class="font-mono">
          {{ $t('settings.users.fullAdmin') }}
        </Badge>
        <div v-else class="flex flex-wrap gap-1 md:max-w-[320px]">
          <Badge v-for="scope in row.scopes" :key="scope" variant="outline" class="font-mono">
            {{ scope }}
          </Badge>
          <span v-if="!row.scopes.length" class="text-xs text-muted-foreground">{{ $t('settings.users.noScopes') }}</span>
        </div>
      </template>

      <template #cell-server_allowlist="{ row }">
        <div v-if="row.server_allowlist?.length" class="flex flex-wrap gap-1 md:max-w-[220px]">
          <Badge v-for="node in row.server_allowlist" :key="node" variant="outline" class="max-w-full">
            <NodeLabel :id="node" />
          </Badge>
        </div>
        <span v-else class="text-xs text-muted-foreground">
          {{ $t('settings.users.list.allNodes') }}
        </span>
      </template>

      <template #cell-login="{ row }">
        <div class="flex flex-wrap gap-1">
          <Badge v-if="row.has_password" variant="secondary">{{ $t('settings.users.list.password') }}</Badge>
          <Badge v-else variant="info">{{ $t('settings.users.list.ssoOnly') }}</Badge>
          <Badge v-if="row.totp_enabled" variant="success">{{ $t('settings.users.list.totp') }}</Badge>
        </div>
      </template>

      <template #cell-created_at="{ row }">
        <span class="tabular text-xs text-muted-foreground">{{ row.created_at ? formatDateTime(row.created_at) : $t('common.misc.none') }}</span>
      </template>

      <template #cell-actions="{ row }">
        <RowMenu v-if="canAdmin" :name="row.username" :items="menuFor(row)" />
      </template>
    </DataTable>

    <!-- Create / edit dialog -->
    <Dialog :open="formOpen" @update:open="(v) => (formOpen = v)">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? $t('settings.users.form.editTitle') : $t('settings.users.form.createTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('settings.users.form.description') }}</DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-2">
            <Label for="user-username">{{ $t('settings.users.form.username') }}</Label>
            <Input
              id="user-username"
              v-model="form.username"
              :disabled="!!editing"
              :title="editing ? $t('settings.users.form.usernameImmutable') : undefined"
              :placeholder="$t('settings.users.form.usernamePlaceholder')"
            />
            <p v-if="usernameError" class="text-xs text-destructive">{{ usernameError }}</p>
            <p v-else-if="editing" class="text-xs text-muted-foreground">{{ $t('settings.users.form.usernameImmutable') }}</p>
            <p v-else class="text-xs text-muted-foreground">{{ $t('settings.users.form.usernameHint') }}</p>
          </div>

          <label
            v-if="isSuperuser"
            class="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
          >
            <Checkbox v-model="form.fullAdmin" />
            <ShieldCheck class="size-4 text-muted-foreground" aria-hidden="true" />
            <span>{{ $t('settings.users.form.fullAdmin') }}</span>
          </label>

          <div v-if="!form.fullAdmin" class="grid gap-2">
            <div class="flex items-center justify-between">
              <Label>{{ $t('settings.users.form.scopes') }}</Label>
              <span class="text-xs text-muted-foreground">{{ $t('settings.users.form.selected', { count: form.scopes.length }) }}</span>
            </div>
            <p class="text-xs text-muted-foreground">{{ $t('settings.users.form.scopesHint') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('settings.scopeMigrationHint') }}</p>
            <ScopePicker
              v-model="form.scopes"
              :grantable="grantableScopes"
              :invalid="!!scopesError"
            />
            <p v-if="scopesError" class="text-xs text-destructive">{{ scopesError }}</p>
          </div>

          <div class="grid gap-2">
            <Label for="user-allowlist">{{ $t('settings.users.form.serverAllowlist') }}</Label>
            <Input
              id="user-allowlist"
              v-model="form.serverAllowlist"
              placeholder="node_a1b2, node_c3d4"
            />
            <p class="text-xs text-muted-foreground">
              {{ $t('settings.users.form.serverAllowlistHint') }}
            </p>
          </div>

          <div class="grid gap-2">
            <Label for="user-password">{{ $t('settings.users.form.password') }}</Label>
            <Input
              id="user-password"
              v-model="form.password"
              type="password"
              autocomplete="new-password"
              :placeholder="editing ? $t('settings.users.form.passwordPlaceholderEdit') : $t('settings.users.form.passwordPlaceholderCreate')"
            />
            <p class="text-xs text-muted-foreground">
              {{ editing ? $t('settings.users.form.passwordHintEdit') : $t('settings.users.form.passwordHintCreate') }}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" :disabled="saving" @click="formOpen = false">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ editing ? $t('common.actions.saveChanges') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('settings.users.deleteTitle')"
      :description="$t('settings.users.deleteDescription', { name: deleteTarget?.username })"
      :impact="deleteTarget ? [
        $t('settings.users.deleteImpact.signIn', { name: deleteTarget.username }),
        $t('settings.users.deleteImpact.tokens'),
        $t('settings.users.deleteImpact.sso'),
      ] : undefined"
      :typed-confirm="deleteTarget?.username"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />
  </section>
</template>
