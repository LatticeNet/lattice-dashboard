<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
} from "lucide-vue-next";
import {
  api,
  type TokenCreateRequest,
  type TokenCreateResponse,
  type TokenView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
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
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Full known RBAC scope catalog (server is authoritative; it rejects any scope
 * not ⊆ the caller's own). Used as the option set when the caller is a `*`
 * superuser; otherwise we intersect with the caller's held scopes.
 */
const SCOPE_CATALOG = [
  "audit:read",
  "ddns:admin",
  "dns:admin",
  "exec:anything",
  "geo:admin",
  "geo:read",
  "inventory:admin",
  "inventory:read",
  "kv:admin",
  "kv:read",
  "kv:write",
  "log:admin",
  "log:read",
  "monitor:admin",
  "monitor:read",
  "netpolicy:admin",
  "netpolicy:read",
  "network:apply",
  "network:plan",
  "node:admin",
  "node:read",
  "notify:send",
  "oidc:admin",
  "plugin:admin",
  "plugin:verify",
  "proxy:admin",
  "proxy:read",
  "static:admin",
  "static:read",
  "static:write",
  "task:read",
  "task:run",
  "token:admin",
  "tunnel:admin",
  "worker:deploy",
] as const;

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("token:admin"));

// BARE ARRAY endpoint — do NOT unwrap.
const tokensQuery = useAsyncData(() => api.tokens.list(), { pollInterval: 15000 });
const tokens = computed(() => tokensQuery.data.value ?? []);

// A token is revoked only if revoked_at is a REAL timestamp. Go's `omitempty`
// does not omit a zero time.Time, so active tokens serialize the zero time
// ("0001-01-01T00:00:00Z") instead of omitting the field — treating that as
// truthy would wrongly mark every active token as revoked.
function isRevoked(token: TokenView): boolean {
  const r = token.revoked_at;
  return !!r && !r.startsWith("0001-01-01") && !r.startsWith("0001");
}

const sortedTokens = computed(() =>
  [...tokens.value].sort((a, b) => {
    const aRevoked = isRevoked(a);
    const bRevoked = isRevoked(b);
    if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
    return (b.created_at || "").localeCompare(a.created_at || "");
  }),
);

const callerScopes = computed(() => auth.scopes);
const isSuperuser = computed(() => callerScopes.value.includes("*"));

/**
 * The scopes this caller may grant: the full catalog when superuser, otherwise
 * the catalog intersected with what the caller holds (honoring `prefix:*`).
 */
const grantableScopes = computed(() => {
  if (isSuperuser.value) return [...SCOPE_CATALOG];
  return SCOPE_CATALOG.filter((scope) => auth.can(scope));
});

const grantableAllowlist = computed(() => callerScopes.value); // shown as reference only

// ── Create dialog ────────────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
// Surfaces inline per-field errors only after a submit attempt.
const submitAttempted = ref(false);

const form = reactive({
  name: "",
  scopes: [] as string[],
  server_allowlist: "",
});

function resetForm() {
  form.name = "";
  form.scopes = [];
  form.server_allowlist = "";
  submitAttempted.value = false;
}

/**
 * The create dialog hosts a real scope-selection matrix; treat any started
 * input as unsaved work and gate an accidental dismiss behind a confirm.
 */
const isDirty = computed(
  () =>
    !!form.name.trim() ||
    form.scopes.length > 0 ||
    !!form.server_allowlist.trim(),
);
const discardOpen = ref(false);

function openCreate() {
  if (!canAdmin.value) return;
  resetForm();
  formOpen.value = true;
}

/** Intercept dialog dismiss attempts; confirm before discarding unsaved work. */
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

function toggleScope(scope: string) {
  const index = form.scopes.indexOf(scope);
  if (index >= 0) form.scopes.splice(index, 1);
  else form.scopes.push(scope);
}

const nameError = computed(() =>
  submitAttempted.value && !form.name.trim()
    ? t("settings.tokens.form.nameRequired")
    : undefined,
);
const scopesError = computed(() =>
  submitAttempted.value && form.scopes.length === 0
    ? t("settings.tokens.form.scopesRequired")
    : undefined,
);

const canSubmit = computed(() => !!form.name.trim() && form.scopes.length > 0);

// ── One-time reveal ──────────────────────────────────────────────────────────
const revealed = ref<TokenCreateResponse | undefined>();

async function submitForm() {
  submitAttempted.value = true;
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const allowlist = form.server_allowlist
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const req: TokenCreateRequest = {
      name: form.name.trim(),
      scopes: [...form.scopes],
    };
    if (allowlist.length) req.server_allowlist = allowlist;

    const created = await api.tokens.create(req);
    formOpen.value = false;
    revealed.value = created; // one-time reveal — never re-fetched.
    toast.success(t("settings.tokens.toast.created"));
    tokensQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("settings.tokens.toast.createFailed"));
  } finally {
    saving.value = false;
  }
}

function closeReveal() {
  revealed.value = undefined;
}

// ── Revoke confirmation ──────────────────────────────────────────────────────
const revokeTarget = ref<TokenView | undefined>();
const revoking = ref(false);

async function confirmRevoke() {
  if (!revokeTarget.value) return;
  revoking.value = true;
  try {
    await api.tokens.revoke(revokeTarget.value.id);
    toast.success(t("settings.tokens.toast.revoked"));
    revokeTarget.value = undefined;
    tokensQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("settings.tokens.toast.revokeFailed"));
  } finally {
    revoking.value = false;
  }
}

const activeCount = computed(() => tokens.value.filter((token) => !isRevoked(token)).length);

// Token status → shared visual treatment (active=online green, revoked=offline red).
function tokenMeta(token: TokenView) {
  return statusMeta(isRevoked(token) ? "offline" : "online");
}

// DataTable columns. Cells are rendered via #cell-<key> slots so every existing
// column (name+id, actor, scope badges, allowlist, created, status, actions) and
// the revoke action are preserved.
const columns = computed<DataTableColumn<TokenView>[]>(() => [
  {
    key: "name",
    label: t("settings.tokens.list.name"),
    sortable: true,
    searchable: true,
    value: (row) => row.name || row.id,
  },
  {
    key: "actor",
    label: t("settings.tokens.list.actor"),
    searchable: true,
    value: (row) => row.actor_id,
  },
  { key: "scopes", label: t("settings.tokens.list.scopes") },
  { key: "server_allowlist", label: t("settings.tokens.list.serverAllowlist") },
  {
    key: "created_at",
    label: t("settings.tokens.list.created"),
    sortable: true,
    align: "right",
  },
  {
    key: "status",
    label: t("settings.tokens.list.status"),
    sortable: true,
    value: (row) => (isRevoked(row) ? 1 : 0),
  },
  { key: "actions", label: t("settings.tokens.list.actions"), align: "right" },
]);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('settings.tokens.title')"
      :description="$t('settings.tokens.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="tokensQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="tokensQuery.refreshing.value"
          @click="tokensQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', tokensQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t("common.actions.refresh") }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t("settings.tokens.newToken") }}
        </Button>
      </template>
    </PageHeader>

    <Card class="border-primary/30 bg-primary/5">
      <CardContent class="flex items-start gap-3 p-4">
        <ShieldCheck class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div class="space-y-1 text-sm">
          <p class="font-medium">{{ $t("settings.tokens.explainer.title") }}</p>
          <p class="text-muted-foreground">
            {{ $t("settings.tokens.explainer.body") }}
          </p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t("settings.tokens.list.title") }}
        </CardTitle>
        <CardDescription>
          {{ $t("settings.tokens.list.count", { active: activeCount, total: tokens.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="sortedTokens"
          :row-key="(token) => token.id"
          :loading="tokensQuery.loading.value"
          :error="tokensQuery.error.value"
          :has-data="tokensQuery.data.value !== undefined"
          searchable
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('settings.tokens.list.emptyTitle')"
          :empty-description="$t('settings.tokens.list.emptyDescription')"
          @retry="tokensQuery.refresh"
        >
          <template #cell-name="{ row }">
            <div class="font-medium">{{ row.name || row.id }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
          </template>

          <template #cell-actor="{ row }">
            <span class="break-all font-mono text-xs text-muted-foreground">{{ row.actor_id }}</span>
          </template>

          <template #cell-scopes="{ row }">
            <div class="flex flex-wrap gap-1 md:max-w-[260px]">
              <Badge v-for="scope in row.scopes" :key="scope" variant="outline" class="font-mono">
                {{ scope }}
              </Badge>
            </div>
          </template>

          <template #cell-server_allowlist="{ row }">
            <div v-if="row.server_allowlist.length" class="flex flex-wrap gap-1 md:max-w-[200px]">
              <Badge
                v-for="node in row.server_allowlist"
                :key="node"
                variant="secondary"
                class="font-mono"
              >
                {{ node }}
              </Badge>
            </div>
            <Badge v-else variant="info">{{ $t("common.misc.all") }}</Badge>
          </template>

          <template #cell-created_at="{ row }">
            <span class="text-xs text-muted-foreground">
              {{ row.created_at ? formatDateTime(row.created_at) : "—" }}
            </span>
          </template>

          <template #cell-status="{ row }">
            <Badge :variant="tokenMeta(row).badgeVariant">
              {{ isRevoked(row) ? $t("common.status.revoked") : $t("common.status.active") }}
            </Badge>
          </template>

          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-1">
              <Button
                v-if="canAdmin && !isRevoked(row)"
                variant="ghost"
                size="sm"
                @click="revokeTarget = row"
              >
                <ShieldOff class="size-4 text-destructive" aria-hidden="true" />
                {{ $t("settings.tokens.list.revoke") }}
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <!-- Create dialog -->
    <Dialog :open="formOpen" @update:open="onFormOpenChange">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t("settings.tokens.form.title") }}</DialogTitle>
          <DialogDescription>
            {{ $t("settings.tokens.form.description") }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-2">
            <Label for="token-name">{{ $t("settings.tokens.form.name") }}</Label>
            <Input
              id="token-name"
              v-model="form.name"
              required
              placeholder="ci-deploy-bot"
              :aria-invalid="!!nameError"
              :class="cn(nameError && 'border-destructive')"
            />
            <p v-if="nameError" class="text-xs text-destructive">{{ nameError }}</p>
          </div>

          <div class="grid gap-2">
            <div class="flex items-center justify-between">
              <Label>{{ $t("settings.tokens.form.scopes") }}</Label>
              <span class="text-xs text-muted-foreground">{{ $t("settings.tokens.form.selected", { count: form.scopes.length }) }}</span>
            </div>
            <p class="text-xs text-muted-foreground">
              <template v-if="isSuperuser">
                <i18n-t keypath="settings.tokens.form.superuserHint" scope="global">
                  <template #star><code class="font-mono">*</code></template>
                </i18n-t>
              </template>
              <template v-else>
                {{ $t("settings.tokens.form.scopedHint") }}
              </template>
            </p>
            <div
              :class="
                cn(
                  'grid max-h-72 grid-cols-1 gap-1.5 overflow-auto rounded-md border border-border p-2 sm:grid-cols-2',
                  scopesError && 'border-destructive',
                )
              "
            >
              <label
                v-for="scope in grantableScopes"
                :key="scope"
                class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  class="size-4 accent-primary"
                  :checked="form.scopes.includes(scope)"
                  @change="toggleScope(scope)"
                />
                <span class="font-mono text-xs">{{ scope }}</span>
              </label>
              <p
                v-if="grantableScopes.length === 0"
                class="col-span-full px-2 py-1.5 text-xs text-muted-foreground"
              >
                {{ $t("settings.tokens.form.noGrantableScopes") }}
              </p>
            </div>
            <p v-if="scopesError" class="text-xs text-destructive">{{ scopesError }}</p>
          </div>

          <div class="grid gap-2">
            <Label for="token-allowlist">{{ $t("settings.tokens.form.serverAllowlist") }}</Label>
            <Input id="token-allowlist" v-model="form.server_allowlist" placeholder="node_a1b2, node_c3d4" />
            <p class="text-xs text-muted-foreground">
              {{ $t("settings.tokens.form.serverAllowlistHint") }}
            </p>
            <p v-if="!isSuperuser && grantableAllowlist.length" class="text-xs text-muted-foreground">
              {{ $t("settings.tokens.form.yourScopes") }}
              <code class="font-mono">{{ grantableAllowlist.slice(0, 6).join(", ") }}</code>
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" :disabled="saving" @click="onFormOpenChange(false)">
              {{ $t("common.actions.cancel") }}
            </Button>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t("settings.tokens.form.submit") }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Discard unsaved-changes guard for the create dialog -->
    <ConfirmDialog
      :open="discardOpen"
      :title="$t('settings.tokens.discardTitle')"
      :description="$t('settings.tokens.discardDescription')"
      :confirm-label="$t('settings.tokens.discardConfirm')"
      :cancel-label="$t('common.actions.cancel')"
      @update:open="(v) => { if (!v) discardOpen = false; }"
      @confirm="confirmDiscard"
    />

    <!-- One-time reveal -->
    <Dialog :open="!!revealed" @update:open="(v) => { if (!v) closeReveal(); }">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <TriangleAlert class="size-5 text-warning" aria-hidden="true" />
            {{ $t("settings.tokens.reveal.title") }}
          </DialogTitle>
          <DialogDescription>
            {{ $t("settings.tokens.reveal.description") }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-4">
            <div class="flex items-center justify-between gap-3">
              <Label>{{ $t("settings.tokens.reveal.tokenLabel", { format: "<id>.<secret>" }) }}</Label>
              <CopyButton v-if="revealed" :value="revealed.token" :label="$t('common.actions.copy')" />
            </div>
            <code class="block break-all font-mono text-xs text-foreground">
              {{ revealed?.token }}
            </code>
            <p class="text-xs text-muted-foreground">
              {{ $t("settings.tokens.reveal.copyOnce") }}
            </p>
          </div>

          <Separator />

          <div class="grid gap-3 text-sm">
            <div class="grid gap-1">
              <span class="text-xs font-medium uppercase text-muted-foreground">{{ $t("settings.tokens.reveal.name") }}</span>
              <span>{{ revealed?.view.name }}</span>
            </div>
            <div class="grid gap-1">
              <span class="text-xs font-medium uppercase text-muted-foreground">{{ $t("settings.tokens.reveal.scopes") }}</span>
              <div class="flex flex-wrap gap-1">
                <Badge
                  v-for="scope in revealed?.view.scopes ?? []"
                  :key="scope"
                  variant="outline"
                  class="font-mono"
                >
                  {{ scope }}
                </Badge>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" @click="closeReveal">{{ $t("common.actions.done") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Revoke confirmation -->
    <ConfirmDialog
      :open="!!revokeTarget"
      :title="$t('settings.tokens.revokeTitle')"
      :description="$t('settings.tokens.revokeDescription', { name: revokeTarget?.name || revokeTarget?.id })"
      :confirm-label="$t('settings.tokens.list.revoke')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="revoking"
      @update:open="(v) => { if (!v) revokeTarget = undefined; }"
      @confirm="confirmRevoke"
    />
  </div>
</template>
