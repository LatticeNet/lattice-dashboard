<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  KeyRound,
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

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
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

// Wrapped object endpoint — unwrap "providers".
const providersQuery = useAsyncData(
  () => api.oidc.providers().then((r) => unwrap(r, "providers")),
  { pollInterval: 15000 },
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

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<OIDCProviderView | undefined>();
const deleting = ref(false);

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
const enabledMeta = (provider: OIDCProviderView) =>
  statusMeta(provider.enabled ? "online" : "unknown");
const secretMeta = (provider: OIDCProviderView) =>
  statusMeta(provider.has_secret ? "online" : "degraded");

// DataTable columns — every existing column and the edit/delete row actions are
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
    searchable: true,
  },
  { key: "secret", label: t("settings.sso.list.secret") },
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
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('settings.sso.title')"
      :description="$t('settings.sso.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="providersQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" as-child>
          <a :href="SSO_GUIDE_URL" target="_blank" rel="noreferrer">
            <ExternalLink class="size-4" aria-hidden="true" />
            {{ $t("settings.sso.guide") }}
          </a>
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="providersQuery.refreshing.value"
          @click="providersQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', providersQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t("common.actions.refresh") }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t("settings.sso.newProvider") }}
        </Button>
      </template>
    </PageHeader>

    <Card class="border-primary/30 bg-primary/5">
      <CardContent class="flex items-start gap-3 p-4">
        <ShieldCheck class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div class="space-y-1 text-sm">
          <p class="font-medium">{{ $t("settings.sso.explainer.title") }}</p>
          <p class="text-muted-foreground">
            {{ $t("settings.sso.explainer.body") }}
          </p>
          <a
            :href="SSO_GUIDE_URL"
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {{ $t("settings.sso.explainer.guideLink") }}
            <ExternalLink class="size-3.5" aria-hidden="true" />
          </a>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t("settings.sso.list.title") }}
        </CardTitle>
        <CardDescription>
          {{ $t("settings.sso.list.count", { count: providers.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="sortedProviders"
          :row-key="(provider) => provider.id"
          :loading="providersQuery.loading.value"
          :error="providersQuery.error.value"
          :has-data="providersQuery.data.value !== undefined"
          searchable
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('settings.sso.list.emptyTitle')"
          :empty-description="$t('settings.sso.list.emptyDescription')"
          @retry="providersQuery.refresh"
        >
          <template #cell-display_name="{ row }">
            <div class="font-medium">{{ row.display_name || row.issuer }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
          </template>

          <template #cell-issuer="{ row }">
            <span class="break-all font-mono text-xs text-muted-foreground md:line-clamp-2 md:max-w-[240px]">{{ row.issuer }}</span>
          </template>

          <template #cell-client_id="{ row }">
            <span class="break-all font-mono text-xs text-muted-foreground md:max-w-[180px]">{{ row.client_id }}</span>
          </template>

          <template #cell-secret="{ row }">
            <Badge :variant="secretMeta(row).badgeVariant">
              <Lock v-if="row.has_secret" class="size-3" aria-hidden="true" />
              <Unlock v-else class="size-3" aria-hidden="true" />
              {{ row.has_secret ? $t("common.status.set") : $t("common.status.missing") }}
            </Badge>
          </template>

          <template #cell-status="{ row }">
            <Badge :variant="enabledMeta(row).badgeVariant">
              {{ row.enabled ? $t("common.status.enabled") : $t("common.status.disabled") }}
            </Badge>
          </template>

          <template #cell-scopes="{ row }">
            <div v-if="(row.scopes ?? []).length" class="flex flex-wrap gap-1 md:max-w-[200px]">
              <Badge v-for="scope in row.scopes" :key="scope" variant="outline" class="font-mono">
                {{ scope }}
              </Badge>
            </div>
            <span v-else class="text-xs text-muted-foreground">—</span>
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
            <div class="flex justify-end gap-1">
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.edit')"
                @click="openEdit(row)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.delete')"
                @click="deleteTarget = row"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

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
              <code class="block mt-1 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs text-foreground">
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
          <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
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

        <form class="space-y-4" @submit.prevent="submitForm">
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
            <p v-if="testResult?.ok" class="text-xs text-emerald-500">
              {{ $t("settings.sso.form.testOk") }} · auth: {{ testResult.authorization_endpoint }}
            </p>
            <p v-else-if="testResult && !testResult.ok" class="text-xs text-destructive">
              {{ testResult.error || $t("settings.sso.form.testFailed") }}
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
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

          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
            {{ $t("settings.sso.form.enabled") }}
          </label>

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

    <!-- Delete confirmation -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('settings.sso.deleteTitle')"
      :description="$t('settings.sso.deleteDescription', { name: deleteTarget?.display_name || deleteTarget?.issuer })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />
  </div>
</template>
