<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { toast } from "vue-sonner";
import {
  KeyRound,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unlock,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type OIDCProviderUpsertRequest,
  type OIDCProviderView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_SCOPES = "openid,profile,email";

const auth = useAuthStore();
const canAdmin = computed(() => auth.can("oidc:admin"));

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
    toast.success(editing.value ? "Provider updated" : "Provider created");
    formOpen.value = false;
    providersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Save failed");
  } finally {
    saving.value = false;
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
    toast.success("Provider deleted");
    deleteTarget.value = undefined;
    providersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Delete failed");
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Single Sign-On"
      description="OIDC identity providers for operator login via external IdPs"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="providersQuery.refreshing.value"
          @click="providersQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', providersQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" />
          New provider
        </Button>
      </template>
    </PageHeader>

    <Card class="border-primary/30 bg-primary/5">
      <CardContent class="flex items-start gap-3 p-4">
        <ShieldCheck class="mt-0.5 size-5 shrink-0 text-primary" />
        <div class="space-y-1 text-sm">
          <p class="font-medium">Auth-code flow with PKCE</p>
          <p class="text-muted-foreground">
            Lattice authenticates against each provider using the authorization-code flow
            with PKCE. A Lattice-local TOTP second factor is still enforced after SSO when it
            is enabled — single sign-on never bypasses 2FA. Client secrets are write-only and
            never returned by the API.
          </p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <KeyRound class="size-4 text-muted-foreground" />
          Identity Providers
        </CardTitle>
        <CardDescription>
          {{ providers.length }} {{ providers.length === 1 ? "provider" : "providers" }} configured
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="providersQuery.loading.value"
          :error="providersQuery.error.value"
          :is-empty="providers.length === 0"
          empty-title="No identity providers"
          empty-description="Add an OIDC provider to let operators sign in through an external IdP."
          @retry="providersQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th class="py-2 pr-4 font-medium">Display name</th>
                  <th class="py-2 pr-4 font-medium">Issuer</th>
                  <th class="py-2 pr-4 font-medium">Client ID</th>
                  <th class="py-2 pr-4 font-medium">Secret</th>
                  <th class="py-2 pr-4 font-medium">Status</th>
                  <th class="py-2 pr-4 font-medium">Scopes</th>
                  <th class="py-2 pr-4 font-medium">Allowed domains</th>
                  <th class="py-2 pl-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="provider in sortedProviders"
                  :key="provider.id"
                  class="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td class="py-3 pr-4">
                    <div class="font-medium">{{ provider.display_name || provider.issuer }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(provider.id, 16) }}</div>
                  </td>
                  <td class="py-3 pr-4 max-w-[240px]">
                    <span class="break-all font-mono text-xs text-muted-foreground">{{ provider.issuer }}</span>
                  </td>
                  <td class="py-3 pr-4 max-w-[180px]">
                    <span class="break-all font-mono text-xs text-muted-foreground">{{ provider.client_id }}</span>
                  </td>
                  <td class="py-3 pr-4">
                    <Badge :variant="provider.has_secret ? 'success' : 'warning'">
                      <Lock v-if="provider.has_secret" class="size-3" />
                      <Unlock v-else class="size-3" />
                      {{ provider.has_secret ? "set" : "missing" }}
                    </Badge>
                  </td>
                  <td class="py-3 pr-4">
                    <Badge :variant="provider.enabled ? 'success' : 'secondary'">
                      {{ provider.enabled ? "enabled" : "disabled" }}
                    </Badge>
                  </td>
                  <td class="py-3 pr-4 max-w-[200px]">
                    <div v-if="(provider.scopes ?? []).length" class="flex flex-wrap gap-1">
                      <Badge v-for="scope in provider.scopes" :key="scope" variant="outline" class="font-mono">
                        {{ scope }}
                      </Badge>
                    </div>
                    <span v-else class="text-xs text-muted-foreground">—</span>
                  </td>
                  <td class="py-3 pr-4 max-w-[200px]">
                    <div v-if="(provider.allowed_domains ?? []).length" class="flex flex-wrap gap-1">
                      <Badge
                        v-for="domain in provider.allowed_domains"
                        :key="domain"
                        variant="outline"
                        class="font-mono"
                      >
                        {{ domain }}
                      </Badge>
                    </div>
                    <span v-else class="text-xs text-muted-foreground">any</span>
                  </td>
                  <td class="py-3 pl-4">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit"
                        @click="openEdit(provider)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canAdmin"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        @click="deleteTarget = provider"
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
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? "Edit identity provider" : "New identity provider" }}</DialogTitle>
          <DialogDescription>
            Configure an OIDC provider. The client secret is write-only and never returned.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-2">
            <Label for="oidc-display">Display name</Label>
            <Input id="oidc-display" v-model="form.display_name" placeholder="Defaults to the issuer if left blank" />
          </div>

          <div class="grid gap-2">
            <Label for="oidc-issuer">Issuer</Label>
            <Input
              id="oidc-issuer"
              v-model="form.issuer"
              required
              placeholder="https://idp.example.com"
            />
            <p v-if="form.issuer && !issuerValid" class="text-xs text-destructive">
              Issuer must start with https://
            </p>
            <p v-else-if="form.issuer && !issuerUnique" class="text-xs text-destructive">
              Another provider already uses this issuer.
            </p>
            <p v-else class="text-xs text-muted-foreground">
              The provider's discovery base URL. Must be unique across providers.
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="oidc-client-id">Client ID</Label>
              <Input id="oidc-client-id" v-model="form.client_id" required placeholder="lattice-console" />
            </div>
            <div class="grid gap-2">
              <Label for="oidc-client-secret">Client secret</Label>
              <Input
                id="oidc-client-secret"
                v-model="form.client_secret"
                type="password"
                autocomplete="off"
                :placeholder="editing ? 'leave blank to keep' : 'write-only — stored at rest'"
              />
              <p class="text-xs text-muted-foreground">
                Write-only.
                <template v-if="editing">Leave blank to keep the existing secret.</template>
                <template v-else>Stored encrypted; never returned by the API.</template>
              </p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="oidc-scopes">Scopes</Label>
            <Input id="oidc-scopes" v-model="form.scopes" placeholder="openid, profile, email" />
            <p class="text-xs text-muted-foreground">Comma-separated OIDC scopes requested at login.</p>
          </div>

          <div class="grid gap-2">
            <Label for="oidc-domains">Allowed domains</Label>
            <Input id="oidc-domains" v-model="form.allowed_domains" placeholder="example.com, corp.example.com" />
            <p class="text-xs text-muted-foreground">
              Comma-separated. Leave empty to allow any verified email domain.
            </p>
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
            Enabled (offer this provider on the login screen)
          </label>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" />
              <Plus v-else class="size-4" />
              {{ editing ? "Save changes" : "Create" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete identity provider?</DialogTitle>
          <DialogDescription>
            Remove "{{ deleteTarget?.display_name || deleteTarget?.issuer }}". Operators linked to this
            provider will no longer be able to sign in through it. This cannot be undone.
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
  </div>
</template>
