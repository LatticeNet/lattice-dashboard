<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Fingerprint,
  Lock,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unlock,
  ExternalLink,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type OIDCProviderTestResult,
  type OIDCProviderUpsertRequest,
  type OIDCProviderView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";
import { statusMeta } from "@/lib/status";
import { cn } from "@/lib/utils";

import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { useProof } from "@/composables/useProof";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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

const DEFAULT_SCOPES = "openid,profile,email";
const SSO_GUIDE_URL = "https://latticenet.github.io/guide/sso";

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("oidc:admin"));
const redirectUri = computed(() => `${window.location.origin}/api/auth/oidc/callback`);

// Wrapped object endpoint: unwrap "providers".
// Operator-only data changes only when an operator changes it, here or in
// another tab; it is read once and on Refresh, never polled (design 23,
// section 3.10).
const providersQuery = useAsyncData(
  (signal) => api.oidc.providers({ signal }).then((r) => unwrap(r, "providers")),
);
const providers = computed(() => providersQuery.data.value ?? []);

const sortedProviders = computed(() =>
  [...providers.value].sort((a, b) =>
    (a.display_name || a.issuer).localeCompare(b.display_name || b.issuer),
  ),
);

// ── Create / Edit dialog ─────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const editing = ref<OIDCProviderView | undefined>();

const form = reactive({
  display_name: "",
  issuer: "",
  client_id: "",
  client_secret: "",
  scopes: DEFAULT_SCOPES,
  allowed_domains: "",
  enabled: true,
});

function resetForm() {
  form.display_name = "";
  form.issuer = "";
  form.client_id = "";
  form.client_secret = "";
  form.scopes = DEFAULT_SCOPES;
  form.allowed_domains = "";
  form.enabled = true;
  testResult.value = undefined;
}

function openCreate() {
  if (!canAdmin.value) return;
  editing.value = undefined;
  resetForm();
  formOpen.value = true;
}

function openEdit(provider: OIDCProviderView) {
  if (!canAdmin.value) return;
  editing.value = provider;
  form.display_name = provider.display_name ?? "";
  form.issuer = provider.issuer ?? "";
  form.client_id = provider.client_id ?? "";
  form.client_secret = "";
  form.scopes = (provider.scopes ?? []).join(", ");
  form.allowed_domains = (provider.allowed_domains ?? []).join(", ");
  form.enabled = provider.enabled;
  testResult.value = undefined;
  formOpen.value = true;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const issuerValid = computed(() => form.issuer.trim().startsWith("https://"));

const issuerUnique = computed(() => {
  const normalized = form.issuer.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) return true;
  return !providers.value.some(
    (provider) =>
      provider.id !== editing.value?.id &&
      provider.issuer.replace(/\/+$/, "").toLowerCase() === normalized,
  );
});

const canSubmit = computed(
  () =>
    issuerValid.value &&
    issuerUnique.value &&
    !!form.client_id.trim(),
);

async function submitForm() {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: OIDCProviderUpsertRequest = {
      issuer: form.issuer.trim().replace(/\/+$/, ""),
      client_id: form.client_id.trim(),
      scopes: splitCsv(form.scopes),
      allowed_domains: splitCsv(form.allowed_domains),
      enabled: form.enabled,
    };
    if (editing.value) req.id = editing.value.id;
    if (form.display_name.trim()) req.display_name = form.display_name.trim();
    // Write-only: only send when non-empty (empty preserves the stored secret).
    if (form.client_secret.trim()) req.client_secret = form.client_secret;

    await api.oidc.upsertProvider(req);
    toast.success(editing.value ? t("settings.sso.toast.updated") : t("settings.sso.toast.created"));
    formOpen.value = false;
    providersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("settings.sso.toast.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Test connection (read-only OIDC discovery probe) ─────────────────────────
const testing = ref(false);
const testResult = ref<OIDCProviderTestResult | undefined>();

async function testConnection() {
  if (!issuerValid.value || !canAdmin.value) return;
  testing.value = true;
  testResult.value = undefined;
  try {
    testResult.value = await api.oidc.testProvider(form.issuer.trim().replace(/\/+$/, ""));
  } catch (error) {
    testResult.value = {
      ok: false,
      issuer: form.issuer,
      error: error instanceof Error ? error.message : t("settings.sso.form.testFailed"),
    };
  } finally {
    testing.value = false;
  }
}

// ── Last-provider guard ──────────────────────────────────────────────────────
// Turning off the only enabled provider takes SSO login away from everyone who
// has no local password or passkey, so it confirms before saving.
const enabledProviderCount = computed(() => providers.value.filter((p) => p.enabled).length);
const disablingLastProvider = computed(
  () => !!editing.value && editing.value.enabled && !form.enabled && enabledProviderCount.value <= 1,
);
const disableConfirmOpen = ref(false);

function requestSubmit() {
  if (!canSubmit.value || !canAdmin.value) return;
  if (disablingLastProvider.value) {
    disableConfirmOpen.value = true;
    return;
  }
  void submitForm();
}

function confirmDisableLast() {
  disableConfirmOpen.value = false;
  void submitForm();
}

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<OIDCProviderView | undefined>();
const deleting = ref(false);

/*
 * Who a provider delete can lock out (design 23, section 3.8). An account
 * with no password signs in only through SSO or a passkey. The user list
 * does not say which provider an account came through, so with another
 * enabled provider left the lines say "if"; with none left every such
 * account loses SSO. Read once, never polled, and only with user:admin.
 */
const canReadUsers = computed(() => auth.can("user:admin"));
const usersQuery = useAsyncData((signal) => api.users.list({ signal }).then((r) => unwrap(r, "users")), {
  immediate: canReadUsers.value,
});
const ssoOnlyUsers = computed(() =>
  (usersQuery.data.value ?? []).filter((user) => !user.has_password).map((user) => user.username).sort((a, b) => a.localeCompare(b)),
);
const deleteImpact = computed<{ lines: string[]; typed: boolean }>(() => {
  const target = deleteTarget.value;
  if (!target) return { lines: [], typed: false };
  const name = target.display_name || target.issuer;
  const lines = [t("settings.sso.deleteImpact.keep")];
  if (usersQuery.data.value === undefined) {
    lines.push(canReadUsers.value ? t("settings.sso.deleteImpact.usersUnread") : t("settings.sso.deleteImpact.usersNoAccess"));
    return { lines, typed: true };
  }
  const othersLeft = providers.value.some((provider) => provider.id !== target.id && provider.enabled);
  for (const user of ssoOnlyUsers.value) {
    lines.push(othersLeft ? t("settings.sso.deleteImpact.maybeLocked", { user, name }) : t("settings.sso.deleteImpact.locked", { user }));
  }
  return { lines, typed: ssoOnlyUsers.value.length > 0 };
});

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.oidc.deleteProvider(deleteTarget.value.id);
    toast.success(t("settings.sso.toast.deleted"));
    deleteTarget.value = undefined;
    providersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("settings.sso.toast.deleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// Shared status treatment: enabled→online (success), disabled→unknown (secondary);
// secret set→online (success), missing→degraded (warning).
// Enabled is the normal state, so it stays quiet; a missing secret keeps its warning.
const enabledBadge = (provider: OIDCProviderView): "outline" | "secondary" => (provider.enabled ? "outline" : "secondary");
const secretMeta = (provider: OIDCProviderView) =>
  statusMeta(provider.has_secret ? "online" : "degraded");

// DataTable columns: every existing column and the edit/delete row actions are
// preserved, rendered through #cell-<key> slots.
const columns = computed<DataTableColumn<OIDCProviderView>[]>(() => [
  {
    key: "display_name",
    label: t("settings.sso.list.displayName"),
    sortable: true,
    searchable: true,
    value: (row) => row.display_name || row.issuer,
  },
  {
    key: "issuer",
    label: t("settings.sso.list.issuer"),
    sortable: true,
    searchable: true,
  },
  {
    key: "client_id",
    label: t("settings.sso.list.clientId"),
    sortable: true,
    searchable: true,
  },
  {
    key: "secret",
    label: t("settings.sso.list.secret"),
    sortable: true,
    value: (row) => (row.has_secret ? 0 : 1),
  },
  {
    key: "status",
    label: t("settings.sso.list.status"),
    sortable: true,
    value: (row) => (row.enabled ? 0 : 1),
  },
  { key: "scopes", label: t("settings.sso.list.scopes") },
  { key: "allowed_domains", label: t("settings.sso.list.allowedDomains") },
  { key: "actions", label: t("settings.sso.list.actions"), align: "right" },
]);

/* The proof line (design 23, section 3.1): read once, so no age promise. */
const proof = useProof(providersQuery);
const proofSegments = computed<ProofSegment[]>(() => {
  const n = providers.value.length;
  const parts: ProofSegment[] = [{ key: "providers", text: t("settings.access.proof.providers", { n }, n) }];
  if (n) parts.push({ key: "enabled", text: t("settings.access.proof.enabled", { n: providers.value.filter((provider) => provider.enabled).length }) });
  return parts;
});

function menuFor(provider: (typeof providers.value)[number]): RowMenuItem[] {
  return [
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, hidden: !canAdmin.value, run: () => openEdit(provider) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = provider) },
  ];
}
</script>

<template>
  <!-- One layer of the Access page (design 23, section 4.6): the page owns the heading and the tab row. -->
  <section class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="min-w-0 space-y-1">
        <p class="max-w-prose text-sm text-muted-foreground">{{ $t("settings.sso.explainer.body") }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="providersQuery.refresh" />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" as-child>
          <a :href="SSO_GUIDE_URL" target="_blank" rel="noreferrer">
            <ExternalLink class="size-4" aria-hidden="true" />
            {{ $t("settings.sso.guide") }}
          </a>
        </Button>
        <Button variant="outline" size="sm" :disabled="providersQuery.refreshing.value" @click="providersQuery.refresh">
          <RefreshCw :class="cn('size-4', providersQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t("common.actions.refresh") }}
        </Button>
        <Button v-if="canAdmin && providers.length" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t("settings.sso.newProvider") }}
        </Button>
      </div>
    </div>

    <DataTable
      state-key="providers"
      :columns="columns"
      :rows="sortedProviders"
      :row-key="(provider) => provider.id"
      :loading="providersQuery.loading.value"
      :error="providersQuery.error.value"
      :has-data="providersQuery.data.value !== undefined"
      :searchable="providers.length > 6"
      :expression-filter="false"
      :search-placeholder="$t('common.actions.search')"
      :empty-title="$t('settings.sso.list.emptyTitle')"
      :empty-description="$t('settings.sso.list.emptyDescription')"
      @retry="providersQuery.refresh"
    >
      <template #empty>
        <EmptyState :icon="Fingerprint" :title="$t('settings.sso.list.emptyTitle')" :description="$t('settings.sso.list.emptyDescription')">
          <Button v-if="canAdmin" size="sm" @click="openCreate">
            <Plus class="size-4" aria-hidden="true" />
            {{ $t("settings.sso.newProvider") }}
          </Button>
        </EmptyState>
      </template>

      <template #cell-display_name="{ row }">
        <div class="font-medium">{{ row.display_name || row.issuer }}</div>
        <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
      </template>

      <template #cell-issuer="{ row }">
        <!-- A width of its own, so the scrolling table at 375 does not wrap a URL one letter per line. -->
        <span class="line-clamp-2 block w-48 break-all font-mono text-xs text-muted-foreground lg:w-60" :title="row.issuer">{{ row.issuer }}</span>
      </template>

      <template #cell-client_id="{ row }">
        <span class="line-clamp-2 block w-40 break-all font-mono text-xs text-muted-foreground lg:w-44" :title="row.client_id">{{ row.client_id }}</span>
      </template>

      <template #cell-secret="{ row }">
        <Badge :variant="secretMeta(row).badgeVariant">
          <Lock v-if="row.has_secret" class="size-3" aria-hidden="true" />
          <Unlock v-else class="size-3" aria-hidden="true" />
          {{ row.has_secret ? $t("common.status.set") : $t("common.status.missing") }}
        </Badge>
      </template>

      <template #cell-status="{ row }">
        <Badge :variant="enabledBadge(row)">
          {{ row.enabled ? $t("common.status.enabled") : $t("common.status.disabled") }}
        </Badge>
      </template>

      <template #cell-scopes="{ row }">
        <div v-if="(row.scopes ?? []).length" class="flex flex-wrap gap-1 md:max-w-[200px]">
          <Badge v-for="scope in row.scopes" :key="scope" variant="outline" class="font-mono">
            {{ scope }}
          </Badge>
        </div>
        <span v-else class="text-xs text-muted-foreground">{{ $t("common.misc.none") }}</span>
      </template>

      <template #cell-allowed_domains="{ row }">
        <div v-if="(row.allowed_domains ?? []).length" class="flex flex-wrap gap-1 md:max-w-[200px]">
          <Badge
            v-for="domain in row.allowed_domains"
            :key="domain"
            variant="outline"
            class="font-mono"
          >
            {{ domain }}
          </Badge>
        </div>
        <span v-else class="text-xs text-muted-foreground">{{ $t("settings.sso.list.anyDomain") }}</span>
      </template>

      <template #cell-actions="{ row }">
        <RowMenu v-if="canAdmin" :name="row.display_name || row.id" :items="menuFor(row)" />
      </template>
    </DataTable>

    <!-- Create / Edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? $t("settings.sso.form.editTitle") : $t("settings.sso.form.createTitle") }}</DialogTitle>
          <DialogDescription>
            {{ $t("settings.sso.form.description") }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4 rounded-md border border-border bg-muted/30 p-4">
          <div class="flex items-start gap-3">
            <ShieldCheck class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div class="space-y-1">
              <p class="text-sm font-medium">{{ $t("settings.sso.form.tutorialTitle") }}</p>
              <p class="text-sm text-muted-foreground">{{ $t("settings.sso.form.tutorialBody") }}</p>
            </div>
          </div>
          <ol class="grid gap-2 pl-5 text-sm text-muted-foreground">
            <li>{{ $t("settings.sso.form.stepCreateApp") }}</li>
            <li>
              {{ $t("settings.sso.form.stepRedirect") }}
              <code class="block mt-1 relative overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
                {{ redirectUri }}
              </code>
            </li>
            <li>{{ $t("settings.sso.form.stepCopyFields") }}</li>
            <li>{{ $t("settings.sso.form.stepSaveTest") }}</li>
          </ol>
          <a
            :href="SSO_GUIDE_URL"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {{ $t("settings.sso.form.fullGuide") }}
            <ExternalLink class="size-3.5" aria-hidden="true" />
          </a>
        </div>

        <div class="rounded-md border border-border p-4">
          <p class="text-sm font-medium">{{ $t("settings.sso.form.fieldGuideTitle") }}</p>
          <dl class="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt class="font-medium">{{ $t("settings.sso.form.displayName") }}</dt>
              <dd class="text-muted-foreground">{{ $t("settings.sso.form.displayNameGuide") }}</dd>
            </div>
            <div>
              <dt class="font-medium">{{ $t("settings.sso.form.issuer") }}</dt>
              <dd class="text-muted-foreground">{{ $t("settings.sso.form.issuerGuide") }}</dd>
            </div>
            <div>
              <dt class="font-medium">{{ $t("settings.sso.form.clientId") }}</dt>
              <dd class="text-muted-foreground">{{ $t("settings.sso.form.clientIdGuide") }}</dd>
            </div>
            <div>
              <dt class="font-medium">{{ $t("settings.sso.form.clientSecret") }}</dt>
              <dd class="text-muted-foreground">{{ $t("settings.sso.form.clientSecretGuide") }}</dd>
            </div>
            <div>
              <dt class="font-medium">{{ $t("settings.sso.form.scopes") }}</dt>
              <dd class="text-muted-foreground">{{ $t("settings.sso.form.scopesGuide") }}</dd>
            </div>
            <div>
              <dt class="font-medium">{{ $t("settings.sso.form.allowedDomains") }}</dt>
              <dd class="text-muted-foreground">{{ $t("settings.sso.form.allowedDomainsGuide") }}</dd>
            </div>
          </dl>
        </div>

        <form class="space-y-4" @submit.prevent="requestSubmit">
          <div class="grid gap-2">
            <Label for="oidc-display">{{ $t("settings.sso.form.displayName") }}</Label>
            <Input id="oidc-display" v-model="form.display_name" :placeholder="$t('settings.sso.form.displayNamePlaceholder')" />
          </div>

          <div class="grid gap-2">
            <Label for="oidc-issuer">{{ $t("settings.sso.form.issuer") }}</Label>
            <Input
              id="oidc-issuer"
              v-model="form.issuer"
              required
              placeholder="https://idp.example.com"
            />
            <p v-if="form.issuer && !issuerValid" class="text-xs text-destructive">
              {{ $t("settings.sso.form.issuerInvalid") }}
            </p>
            <p v-else-if="form.issuer && !issuerUnique" class="text-xs text-destructive">
              {{ $t("settings.sso.form.issuerDuplicate") }}
            </p>
            <p v-else class="text-xs text-muted-foreground">
              {{ $t("settings.sso.form.issuerHint") }}
            </p>
            <p v-if="testResult?.ok" class="text-xs text-success">
              {{
                testResult.authorization_endpoint
                  ? $t("settings.sso.form.testOkWithEndpoint", { endpoint: testResult.authorization_endpoint })
                  : $t("settings.sso.form.testOk")
              }}
            </p>
            <p v-else-if="testResult && !testResult.ok" class="text-xs text-destructive">
              {{ testResult.error || $t("settings.sso.form.testFailed") }}
            </p>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="oidc-client-id">{{ $t("settings.sso.form.clientId") }}</Label>
              <Input id="oidc-client-id" v-model="form.client_id" required placeholder="lattice-console" />
            </div>
            <div class="grid gap-2">
              <Label for="oidc-client-secret">{{ $t("settings.sso.form.clientSecret") }}</Label>
              <Input
                id="oidc-client-secret"
                v-model="form.client_secret"
                type="password"
                autocomplete="off"
                :placeholder="editing ? $t('settings.sso.form.clientSecretPlaceholderEdit') : $t('settings.sso.form.clientSecretPlaceholderCreate')"
              />
              <p class="text-xs text-muted-foreground">
                {{ $t("settings.sso.form.clientSecretHint") }}
                <template v-if="editing">{{ $t("settings.sso.form.clientSecretHintEdit") }}</template>
                <template v-else>{{ $t("settings.sso.form.clientSecretHintCreate") }}</template>
              </p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="oidc-scopes">{{ $t("settings.sso.form.scopes") }}</Label>
            <Input id="oidc-scopes" v-model="form.scopes" placeholder="openid, profile, email" />
            <p class="text-xs text-muted-foreground">{{ $t("settings.sso.form.scopesHint") }}</p>
          </div>

          <div class="grid gap-2">
            <Label for="oidc-domains">{{ $t("settings.sso.form.allowedDomains") }}</Label>
            <Input id="oidc-domains" v-model="form.allowed_domains" placeholder="example.com, corp.example.com" />
            <p class="text-xs text-muted-foreground">
              {{ $t("settings.sso.form.allowedDomainsHint") }}
            </p>
          </div>

          <div class="grid gap-1">
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox v-model="form.enabled" />
              <span>{{ $t("settings.sso.form.enabled") }}</span>
            </label>
            <p v-if="disablingLastProvider" class="text-xs text-warning">
              {{ $t("settings.sso.form.disableLastWarning") }}
            </p>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t("common.actions.cancel") }}</Button>
            </DialogClose>
            <Button type="button" variant="outline" :disabled="testing || !issuerValid" @click="testConnection">
              <RefreshCw v-if="testing" class="size-4 animate-spin" aria-hidden="true" />
              <Plug v-else class="size-4" aria-hidden="true" />
              {{ $t("settings.sso.form.testConnection") }}
            </Button>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ editing ? $t("common.actions.saveChanges") : $t("common.actions.create") }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Disabling the last enabled provider -->
    <ConfirmDialog
      :open="disableConfirmOpen"
      :title="$t('settings.sso.disableLastTitle')"
      :description="$t('settings.sso.disableLastDescription', { name: editing?.display_name || editing?.issuer })"
      :confirm-label="$t('common.actions.disable')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="saving"
      @update:open="(v) => { if (!v) disableConfirmOpen = false; }"
      @confirm="confirmDisableLast"
    />

    <!-- Delete confirmation -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('settings.sso.deleteTitle')"
      :description="$t('settings.sso.deleteDescriptionShort', { name: deleteTarget?.display_name || deleteTarget?.issuer })"
      :impact="deleteImpact.lines"
      :impact-title="$t('settings.sso.deleteImpact.title')"
      :typed-confirm="deleteImpact.typed ? deleteTarget?.display_name || deleteTarget?.issuer : undefined"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />
  </section>
</template>
