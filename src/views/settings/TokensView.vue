<script setup lang="ts">
import { computed, reactive, ref } from "vue";
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
import { Separator } from "@/components/ui/separator";
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
  "static:read",
  "static:write",
  "task:read",
  "task:run",
  "token:admin",
  "tunnel:admin",
  "worker:deploy",
] as const;

const auth = useAuthStore();
const canAdmin = computed(() => auth.can("token:admin"));

// BARE ARRAY endpoint — do NOT unwrap.
const tokensQuery = useAsyncData(() => api.tokens.list(), { pollInterval: 15000 });
const tokens = computed(() => tokensQuery.data.value ?? []);

const sortedTokens = computed(() =>
  [...tokens.value].sort((a, b) => {
    const aRevoked = !!a.revoked_at;
    const bRevoked = !!b.revoked_at;
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

const form = reactive({
  name: "",
  scopes: [] as string[],
  server_allowlist: "",
});

function resetForm() {
  form.name = "";
  form.scopes = [];
  form.server_allowlist = "";
}

function openCreate() {
  if (!canAdmin.value) return;
  resetForm();
  formOpen.value = true;
}

function toggleScope(scope: string) {
  const index = form.scopes.indexOf(scope);
  if (index >= 0) form.scopes.splice(index, 1);
  else form.scopes.push(scope);
}

const canSubmit = computed(() => !!form.name.trim() && form.scopes.length > 0);

// ── One-time reveal ──────────────────────────────────────────────────────────
const revealed = ref<TokenCreateResponse | undefined>();

async function submitForm() {
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
    toast.success("Token created — copy it now");
    tokensQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Token creation failed");
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
    toast.success("Token revoked");
    revokeTarget.value = undefined;
    tokensQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Revoke failed");
  } finally {
    revoking.value = false;
  }
}

const activeCount = computed(() => tokens.value.filter((token) => !token.revoked_at).length);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Access Tokens"
      description="Personal access tokens (PATs) — Bearer credentials carrying RBAC scopes"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="tokensQuery.refreshing.value"
          @click="tokensQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', tokensQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          New token
        </Button>
      </template>
    </PageHeader>

    <Card class="border-primary/30 bg-primary/5">
      <CardContent class="flex items-start gap-3 p-4">
        <ShieldCheck class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div class="space-y-1 text-sm">
          <p class="font-medium">Privilege-contained minting</p>
          <p class="text-muted-foreground">
            A token can only grant scopes that are a subset of your own, and a server allowlist no
            broader than yours. The plaintext credential is shown exactly once at creation and never
            again — only its salted hash is stored. Revocation is one-way and idempotent.
          </p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <KeyRound class="size-4 text-muted-foreground" aria-hidden="true" />
          Tokens
        </CardTitle>
        <CardDescription>
          {{ activeCount }} active of {{ tokens.length }} {{ tokens.length === 1 ? "token" : "tokens" }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="tokensQuery.loading.value"
          :error="tokensQuery.error.value"
          :is-empty="tokens.length === 0"
          empty-title="No access tokens"
          empty-description="Mint a scoped PAT to authenticate automation or CLI callers."
          @retry="tokensQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="py-2 pr-4 font-medium">Name</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Actor</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Scopes</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Server allowlist</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Created</th>
                  <th scope="col" class="py-2 pr-4 font-medium">Status</th>
                  <th scope="col" class="py-2 pl-4 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="token in sortedTokens"
                  :key="token.id"
                  class="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td class="py-3 pr-4">
                    <div class="font-medium">{{ token.name || token.id }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(token.id, 16) }}</div>
                  </td>
                  <td class="py-3 pr-4">
                    <span class="break-all font-mono text-xs text-muted-foreground">{{ token.actor_id }}</span>
                  </td>
                  <td class="py-3 pr-4 max-w-[260px]">
                    <div class="flex flex-wrap gap-1">
                      <Badge v-for="scope in token.scopes" :key="scope" variant="outline" class="font-mono">
                        {{ scope }}
                      </Badge>
                    </div>
                  </td>
                  <td class="py-3 pr-4 max-w-[200px]">
                    <div v-if="token.server_allowlist.length" class="flex flex-wrap gap-1">
                      <Badge
                        v-for="node in token.server_allowlist"
                        :key="node"
                        variant="secondary"
                        class="font-mono"
                      >
                        {{ node }}
                      </Badge>
                    </div>
                    <Badge v-else variant="info">all</Badge>
                  </td>
                  <td class="py-3 pr-4 text-xs text-muted-foreground">
                    {{ token.created_at ? formatDateTime(token.created_at) : "—" }}
                  </td>
                  <td class="py-3 pr-4">
                    <Badge :variant="token.revoked_at ? 'destructive' : 'success'">
                      {{ token.revoked_at ? "revoked" : "active" }}
                    </Badge>
                  </td>
                  <td class="py-3 pl-4">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canAdmin && !token.revoked_at"
                        variant="ghost"
                        size="sm"
                        @click="revokeTarget = token"
                      >
                        <ShieldOff class="size-4 text-destructive" aria-hidden="true" />
                        Revoke
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

    <!-- Create dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New access token</DialogTitle>
          <DialogDescription>
            Granted scopes must be a subset of your own. The server rejects any scope you do not hold.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-2">
            <Label for="token-name">Name</Label>
            <Input id="token-name" v-model="form.name" required placeholder="ci-deploy-bot" />
          </div>

          <div class="grid gap-2">
            <div class="flex items-center justify-between">
              <Label>Scopes</Label>
              <span class="text-xs text-muted-foreground">{{ form.scopes.length }} selected</span>
            </div>
            <p class="text-xs text-muted-foreground">
              <template v-if="isSuperuser">
                You hold <code class="font-mono">*</code> (superuser) — any scope may be granted.
              </template>
              <template v-else>
                Only the scopes you currently hold are offered.
              </template>
            </p>
            <div class="grid max-h-72 grid-cols-1 gap-1.5 overflow-auto rounded-md border border-border p-2 sm:grid-cols-2">
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
                You hold no grantable scopes from the catalog.
              </p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="token-allowlist">Server allowlist</Label>
            <Input id="token-allowlist" v-model="form.server_allowlist" placeholder="node_a1b2, node_c3d4" />
            <p class="text-xs text-muted-foreground">
              Comma-separated node IDs. Must be a subset of your own allowlist. Leave empty for all nodes.
            </p>
            <p v-if="!isSuperuser && grantableAllowlist.length" class="text-xs text-muted-foreground">
              Your scopes:
              <code class="font-mono">{{ grantableAllowlist.slice(0, 6).join(", ") }}</code>
            </p>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              Create token
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- One-time reveal -->
    <Dialog :open="!!revealed" @update:open="(v) => { if (!v) closeReveal(); }">
      <DialogContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <TriangleAlert class="size-5 text-warning" aria-hidden="true" />
            Copy your token now
          </DialogTitle>
          <DialogDescription>
            This is the only time the full credential is shown. It is never stored in plaintext and
            cannot be retrieved again.
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-4">
            <div class="flex items-center justify-between gap-3">
              <Label>Token ({{ "<id>.<secret>" }})</Label>
              <CopyButton v-if="revealed" :value="revealed.token" label="Copy" />
            </div>
            <code class="block break-all font-mono text-xs text-foreground">
              {{ revealed?.token }}
            </code>
            <p class="text-xs text-muted-foreground">
              Copy now — this is shown once and never again.
            </p>
          </div>

          <Separator />

          <div class="grid gap-3 text-sm">
            <div class="grid gap-1">
              <span class="text-xs font-medium uppercase text-muted-foreground">Name</span>
              <span>{{ revealed?.view.name }}</span>
            </div>
            <div class="grid gap-1">
              <span class="text-xs font-medium uppercase text-muted-foreground">Scopes</span>
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
          <Button type="button" @click="closeReveal">Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Revoke confirmation -->
    <Dialog :open="!!revokeTarget" @update:open="(v) => { if (!v) revokeTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke token?</DialogTitle>
          <DialogDescription>
            Revoke "{{ revokeTarget?.name || revokeTarget?.id }}". Any caller using this credential will
            immediately lose access. This is one-way and cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">Cancel</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="revoking" @click="confirmRevoke">
            <RefreshCw v-if="revoking" class="size-4 animate-spin" aria-hidden="true" />
            <ShieldOff v-else class="size-4" aria-hidden="true" />
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
