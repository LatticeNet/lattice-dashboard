<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { RefreshCw, Plus, Trash2, Pencil, Link2, ShieldCheck, Users, KeyRound, Lock } from "lucide-vue-next";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const VPN_CORE = "latticenet.vpn-core";
const USERS_SVC = "latticenet.vpn-core/users";
const ADMIN_SVC = "latticenet.vpn-core/users-admin";
const LINES_SVC = "latticenet.vpn-core/lines";

const PROTOCOLS = ["vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "anytls"] as const;
type Protocol = (typeof PROTOCOLS)[number];
const UUID_PROTOCOLS = new Set<Protocol>(["vless", "vmess", "tuic"]);

interface VpnCredentialView {
  protocol: Protocol;
  flow?: string;
  method?: string;
  security?: string;
  has_secret: boolean;
}
interface LineBinding {
  line_hash_id: string;
  enabled: boolean;
  flow_override?: string;
}
interface VpnUserView {
  id: string;
  email: string;
  name?: string;
  enabled: boolean;
  credentials: VpnCredentialView[];
  bindings: LineBinding[];
  quota_bytes?: number;
  expires_at?: string;
  group?: string;
  comment?: string;
  migrated: boolean;
  created_at: string;
  updated_at: string;
}
interface CredentialInput {
  protocol: Protocol;
  uuid?: string;
  password?: string;
  flow?: string;
  method?: string;
  security?: string;
}
interface LineOpt {
  line_hash_id: string;
  label: string;
}

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("proxy:admin"));

const usersQuery = useAsyncData(
  () => api.plugins.call<{ users: VpnUserView[]; count: number }>(VPN_CORE, USERS_SVC, "list"),
  { pollInterval: 20000 },
);
const users = computed<VpnUserView[]>(() => usersQuery.data.value?.users ?? []);
const totalBindings = computed(() => users.value.reduce((n, u) => n + (u.bindings?.length ?? 0), 0));
const enabledCount = computed(() => users.value.filter((u) => u.enabled).length);
const migratedCount = computed(() => users.value.filter((u) => u.migrated).length);

// ── line options for the binding picker (loaded on demand) ────────────────────
const lineOpts = ref<LineOpt[]>([]);
const lineOptsLoaded = ref(false);
async function loadLineOpts() {
  if (lineOptsLoaded.value) return;
  try {
    const res = await api.plugins.call<{ groups: { node_id: string; node_name?: string; lines: { line_hash_id: string; name: string; type?: string }[] }[] }>(
      VPN_CORE, LINES_SVC, "list",
    );
    const opts: LineOpt[] = [];
    for (const g of res.groups ?? []) {
      for (const l of g.lines ?? []) {
        opts.push({ line_hash_id: l.line_hash_id, label: `${g.node_name || g.node_id} · ${l.name}${l.type ? ` (${l.type})` : ""}` });
      }
    }
    lineOpts.value = opts;
    lineOptsLoaded.value = true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("vpnUsers.toastLinesFailed"));
  }
}
function lineLabel(hash: string): string {
  return lineOpts.value.find((o) => o.line_hash_id === hash)?.label ?? hash;
}

// ── create / edit dialog ──────────────────────────────────────────────────────
const editOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const replaceCreds = ref(false);
const form = reactive<{
  email: string;
  name: string;
  enabled: boolean;
  credentials: CredentialInput[];
  quota_bytes: string;
  group: string;
  comment: string;
}>({ email: "", name: "", enabled: true, credentials: [], quota_bytes: "", group: "", comment: "" });

function resetForm() {
  form.email = "";
  form.name = "";
  form.enabled = true;
  form.credentials = [];
  form.quota_bytes = "";
  form.group = "";
  form.comment = "";
  replaceCreds.value = false;
}
function defaultCredentialSet(): CredentialInput[] {
  return PROTOCOLS.map((protocol) => ({ protocol }));
}
function openCreate() {
  editingId.value = null;
  resetForm();
  form.credentials = defaultCredentialSet();
  replaceCreds.value = true; // create always sends credentials
  editOpen.value = true;
}
function openEdit(u: VpnUserView) {
  editingId.value = u.id;
  resetForm();
  form.email = u.email;
  form.name = u.name ?? "";
  form.enabled = u.enabled;
  form.group = u.group ?? "";
  form.comment = u.comment ?? "";
  form.quota_bytes = u.quota_bytes ? String(u.quota_bytes) : "";
  // Secrets are never returned, so prefill protocol shells only; credentials are
  // sent ONLY when the operator opts into replacing them (else existing secrets
  // are preserved server-side).
  form.credentials = u.credentials.map((c) => ({ protocol: c.protocol, flow: c.flow, method: c.method, security: c.security }));
  replaceCreds.value = false;
  editOpen.value = true;
}
function addCred() {
  form.credentials.push({ protocol: "vless" });
}
function resetCredsToFullSet() {
  form.credentials = defaultCredentialSet();
}
function removeCred(i: number) {
  form.credentials.splice(i, 1);
}
function isUUIDProto(p: Protocol) {
  return UUID_PROTOCOLS.has(p);
}

async function submitForm() {
  if (!form.email.trim()) {
    toast.error(t("vpnUsers.emailRequired"));
    return;
  }
  saving.value = true;
  try {
    const payload: Record<string, unknown> = {
      email: form.email.trim(),
      name: form.name.trim(),
      enabled: form.enabled,
      group: form.group.trim(),
      comment: form.comment.trim(),
      quota_bytes: form.quota_bytes ? Number(form.quota_bytes) : 0,
    };
    // Send credentials on create always; on edit only when replacing.
    if (editingId.value === null || replaceCreds.value) {
      payload.credentials = form.credentials.map((c) => {
        const out: CredentialInput = { protocol: c.protocol };
        if (isUUIDProto(c.protocol)) {
          if (c.uuid?.trim()) out.uuid = c.uuid.trim();
        } else if (c.password) {
          out.password = c.password;
        }
        if (c.flow?.trim()) out.flow = c.flow.trim();
        if (c.method?.trim()) out.method = c.method.trim();
        if (c.security?.trim()) out.security = c.security.trim();
        return out;
      });
    }
    if (editingId.value === null) {
      await api.plugins.call(VPN_CORE, ADMIN_SVC, "create", payload);
      toast.success(t("vpnUsers.toastCreated"));
    } else {
      payload.id = editingId.value;
      await api.plugins.call(VPN_CORE, ADMIN_SVC, "update", payload);
      toast.success(t("vpnUsers.toastUpdated"));
    }
    editOpen.value = false;
    await usersQuery.refresh();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("vpnUsers.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── bindings dialog ───────────────────────────────────────────────────────────
const bindOpen = ref(false);
const bindUser = ref<VpnUserView | null>(null);
const bindSelection = ref<string>("");
const binding = ref(false);
async function openBindings(u: VpnUserView) {
  bindUser.value = u;
  bindSelection.value = "";
  bindOpen.value = true;
  await loadLineOpts();
}
function currentBindUser(): VpnUserView | undefined {
  return users.value.find((u) => u.id === bindUser.value?.id);
}
async function doBind() {
  const u = bindUser.value;
  if (!u || !bindSelection.value) return;
  binding.value = true;
  try {
    await api.plugins.call(VPN_CORE, ADMIN_SVC, "bind", { user_id: u.id, line_hash_id: bindSelection.value });
    toast.success(t("vpnUsers.toastBound"));
    bindSelection.value = "";
    await usersQuery.refresh();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("vpnUsers.toastBindFailed"));
  } finally {
    binding.value = false;
  }
}
async function doUnbind(hash: string) {
  const u = bindUser.value;
  if (!u) return;
  try {
    await api.plugins.call(VPN_CORE, ADMIN_SVC, "unbind", { user_id: u.id, line_hash_id: hash });
    toast.success(t("vpnUsers.toastUnbound"));
    await usersQuery.refresh();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("vpnUsers.toastUnbindFailed"));
  }
}
const unboundOpts = computed<LineOpt[]>(() => {
  const u = currentBindUser();
  const bound = new Set((u?.bindings ?? []).map((b) => b.line_hash_id));
  return lineOpts.value.filter((o) => !bound.has(o.line_hash_id));
});

// ── delete ────────────────────────────────────────────────────────────────────
const deleteTarget = ref<VpnUserView | null>(null);
async function confirmDelete() {
  const u = deleteTarget.value;
  if (!u) return;
  try {
    await api.plugins.call(VPN_CORE, ADMIN_SVC, "delete", { id: u.id });
    toast.success(t("vpnUsers.toastDeleted"));
    deleteTarget.value = null;
    await usersQuery.refresh();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : t("vpnUsers.toastDeleteFailed"));
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('vpnUsers.title')" :description="$t('vpnUsers.description')">
      <template #status>
        <FreshnessLabel :last-updated="usersQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="usersQuery.refreshing.value" @click="usersQuery.refresh">
          <RefreshCw :class="cn('size-4', usersQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" /> {{ $t('vpnUsers.create') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('vpnUsers.kpiTotal')" :value="users.length" :icon="Users" />
      <StatCard :label="$t('vpnUsers.kpiEnabled')" :value="enabledCount" :icon="ShieldCheck" tone="success" />
      <StatCard :label="$t('vpnUsers.kpiMigrated')" :value="migratedCount" :icon="KeyRound" />
      <StatCard :label="$t('vpnUsers.kpiBindings')" :value="totalBindings" :icon="Link2" />
    </div>

    <DataState
      :loading="usersQuery.loading.value"
      :error="usersQuery.error.value"
      :has-data="usersQuery.data.value !== undefined"
      :is-empty="users.length === 0"
      :empty-title="$t('vpnUsers.emptyTitle')"
      :empty-description="$t('vpnUsers.emptyDescription')"
      @retry="usersQuery.refresh"
    >
      <Card>
        <CardContent class="p-0">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('vpnUsers.colEmail') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('vpnUsers.colName') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('vpnUsers.colStatus') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('vpnUsers.colCreds') }}</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('vpnUsers.colBindings') }}</th>
                  <th scope="col" class="px-3 py-2 text-right"><span class="sr-only">actions</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in users" :key="u.id" class="border-b border-border last:border-0 hover:bg-muted/40">
                  <td class="px-3 py-3">
                    <span class="font-medium">{{ u.email }}</span>
                    <Badge v-if="u.migrated" variant="outline" class="ml-2 text-[10px]">{{ $t('vpnUsers.migrated') }}</Badge>
                  </td>
                  <td class="px-3 py-3 text-muted-foreground">{{ u.name || "—" }}</td>
                  <td class="px-3 py-3">
                    <Badge :variant="u.enabled ? 'success' : 'secondary'">
                      {{ u.enabled ? $t('vpnUsers.enabled') : $t('vpnUsers.disabled') }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3">
                    <span v-if="!u.credentials.length" class="text-muted-foreground">—</span>
                    <span v-for="c in u.credentials" :key="c.protocol" class="mr-1 inline-flex">
                      <Badge variant="outline" class="gap-1 text-[11px]">
                        {{ c.protocol }}<Lock v-if="c.has_secret" class="size-3 opacity-60" aria-hidden="true" />
                      </Badge>
                    </span>
                  </td>
                  <td class="px-3 py-3 text-right tabular-nums">{{ u.bindings?.length ?? 0 }}</td>
                  <td class="px-3 py-3">
                    <div class="flex items-center justify-end gap-1">
                      <Button v-if="canAdmin" variant="ghost" size="icon" :title="$t('vpnUsers.manageBindings')" @click="openBindings(u)">
                        <Link2 class="size-4" aria-hidden="true" />
                      </Button>
                      <Button v-if="canAdmin" variant="ghost" size="icon" :title="$t('common.actions.edit')" @click="openEdit(u)">
                        <Pencil class="size-4" aria-hidden="true" />
                      </Button>
                      <Button v-if="canAdmin" variant="ghost" size="icon" class="text-destructive" :title="$t('common.actions.delete')" @click="deleteTarget = u">
                        <Trash2 class="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </DataState>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="editOpen">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('vpnUsers.editTitle') : $t('vpnUsers.createTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('vpnUsers.formDescription') }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="grid gap-2">
            <Label for="vu-email">{{ $t('vpnUsers.fieldEmail') }}</Label>
            <Input id="vu-email" v-model="form.email" type="email" placeholder="user@example.com" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="grid gap-2">
              <Label for="vu-name">{{ $t('vpnUsers.fieldName') }}</Label>
              <Input id="vu-name" v-model="form.name" />
            </div>
            <div class="grid gap-2">
              <Label for="vu-group">{{ $t('vpnUsers.fieldGroup') }}</Label>
              <Input id="vu-group" v-model="form.group" />
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" v-model="form.enabled" class="size-4" /> {{ $t('vpnUsers.fieldEnabled') }}
          </label>

          <!-- credentials -->
          <div class="space-y-2 rounded-md border border-border p-3">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">{{ $t('vpnUsers.credentials') }}</span>
              <label v-if="editingId" class="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" v-model="replaceCreds" class="size-3.5" /> {{ $t('vpnUsers.replaceCreds') }}
              </label>
            </div>
            <p v-if="editingId && !replaceCreds" class="text-xs text-muted-foreground">{{ $t('vpnUsers.credsPreserved') }}</p>
            <template v-if="editingId === null || replaceCreds">
              <div v-for="(c, i) in form.credentials" :key="i" class="flex flex-wrap items-end gap-2">
                <div class="grid gap-1">
                  <Label class="text-xs">{{ $t('vpnUsers.protocol') }}</Label>
                  <Select v-model="c.protocol">
                    <SelectTrigger class="h-9 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="p in PROTOCOLS" :key="p" :value="p">{{ p }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div v-if="isUUIDProto(c.protocol)" class="grid flex-1 gap-1">
                  <Label class="text-xs">{{ $t('vpnUsers.uuid') }}</Label>
                  <Input v-model="c.uuid" :placeholder="$t('vpnUsers.uuidPlaceholder')" />
                </div>
                <div v-else class="grid flex-1 gap-1">
                  <Label class="text-xs">{{ $t('vpnUsers.password') }}</Label>
                  <Input v-model="c.password" type="password" />
                </div>
                <Button variant="ghost" size="icon" class="text-destructive" :title="$t('common.actions.delete')" @click="removeCred(i)">
                  <Trash2 class="size-4" aria-hidden="true" />
                </Button>
              </div>
              <Button variant="outline" size="sm" @click="addCred">
                <Plus class="size-4" aria-hidden="true" /> {{ $t('vpnUsers.addCredential') }}
              </Button>
              <Button variant="ghost" size="sm" @click="resetCredsToFullSet">
                {{ $t('vpnUsers.fullCredentialSet') }}
              </Button>
            </template>
          </div>

          <div class="grid gap-2">
            <Label for="vu-quota">{{ $t('vpnUsers.fieldQuota') }}</Label>
            <Input id="vu-quota" v-model="form.quota_bytes" type="number" min="0" placeholder="0" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">{{ $t('common.actions.cancel') }}</Button>
          <Button :disabled="saving" @click="submitForm">{{ $t('common.actions.save') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Bindings dialog -->
    <Dialog v-model:open="bindOpen">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t('vpnUsers.bindingsTitle') }}</DialogTitle>
          <DialogDescription>{{ bindUser?.email }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-1">
            <div
              v-for="b in currentBindUser()?.bindings ?? []"
              :key="b.line_hash_id"
              class="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
            >
              <span class="truncate text-sm">{{ lineLabel(b.line_hash_id) }}</span>
              <Button v-if="canAdmin" variant="ghost" size="sm" class="text-destructive" @click="doUnbind(b.line_hash_id)">
                {{ $t('vpnUsers.unbind') }}
              </Button>
            </div>
            <p v-if="!(currentBindUser()?.bindings?.length)" class="text-sm text-muted-foreground">{{ $t('vpnUsers.noBindings') }}</p>
          </div>
          <div v-if="canAdmin" class="flex items-end gap-2">
            <div class="grid flex-1 gap-1">
              <Label class="text-xs">{{ $t('vpnUsers.bindLine') }}</Label>
              <Select v-model="bindSelection">
                <SelectTrigger class="h-9"><SelectValue :placeholder="$t('vpnUsers.selectLine')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="o in unboundOpts" :key="o.line_hash_id" :value="o.line_hash_id">{{ o.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button :disabled="!bindSelection || binding" @click="doBind">{{ $t('vpnUsers.bind') }}</Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="bindOpen = false">{{ $t('common.actions.close') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = null }">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('vpnUsers.deleteTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('vpnUsers.deleteConfirm', { email: deleteTarget?.email }) }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteTarget = null">{{ $t('common.actions.cancel') }}</Button>
          <Button variant="destructive" @click="confirmDelete">{{ $t('common.actions.delete') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
