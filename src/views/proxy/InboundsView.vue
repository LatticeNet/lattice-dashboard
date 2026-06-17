<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  KeyRound,
  Lock,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  ApiError,
  unwrap,
  type ProxyInboundUpsertRequest,
  type ProxyInboundView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
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

const auth = useAuthStore();
const { t } = useI18n();

const inboundsQuery = useAsyncData(
  () => api.proxy.inbounds().then((r) => unwrap(r, "inbounds")),
  { pollInterval: 12000 },
);

const inbounds = computed(() => inboundsQuery.data.value ?? []);
const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = computed(() => t("proxy.inbounds.adminReason"));

const enabledCount = computed(() => inbounds.value.filter((i) => i.enabled).length);
const realitySetCount = computed(
  () => inbounds.value.filter((i) => i.has_reality_private_key).length,
);

const sortedInbounds = computed(() =>
  [...inbounds.value].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

// ---- Create / Edit dialog state ----
interface FormState {
  id: string;
  name: string;
  core: string;
  port: string;
  listen: string;
  sni: string;
  alpn: string;
  fingerprint: string;
  reality_private_key: string;
  reality_public_key: string;
  reality_short_ids: string;
  reality_dest: string;
  enabled: boolean;
}

const dialogOpen = ref(false);
const editingId = ref<string | undefined>();
const saving = ref(false);
const form = reactive<FormState>(blankForm());

function blankForm(): FormState {
  return {
    id: "",
    name: "",
    core: "sing-box",
    port: "",
    listen: "",
    sni: "",
    alpn: "",
    fingerprint: "",
    reality_private_key: "",
    reality_public_key: "",
    reality_short_ids: "",
    reality_dest: "",
    enabled: true,
  };
}

function assignForm(next: FormState) {
  Object.assign(form, next);
}

const isEditing = computed(() => !!editingId.value);

function openCreate() {
  if (!canAdmin.value) return;
  editingId.value = undefined;
  assignForm(blankForm());
  dialogOpen.value = true;
}

function openEdit(inbound: ProxyInboundView) {
  if (!canAdmin.value) return;
  editingId.value = inbound.id;
  assignForm({
    id: inbound.id,
    name: inbound.name,
    core: inbound.core || "sing-box",
    port: String(inbound.port ?? ""),
    listen: inbound.listen ?? "",
    sni: inbound.sni ?? "",
    alpn: (inbound.alpn ?? []).join(", "),
    fingerprint: inbound.fingerprint ?? "",
    reality_private_key: "",
    reality_public_key: inbound.reality_public_key ?? "",
    reality_short_ids: (inbound.reality_short_ids ?? []).join(", "),
    reality_dest: inbound.reality_dest ?? "",
    enabled: inbound.enabled,
  });
  dialogOpen.value = true;
}

function splitList(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const formValid = computed(() => {
  const portNum = Number(form.port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const shortIds = splitList(form.reality_short_ids);
  const keyOk = isEditing.value || form.reality_private_key.trim().length > 0;
  return (
    form.name.trim().length > 0 &&
    portOk &&
    shortIds.length >= 1 &&
    form.reality_dest.trim().length > 0 &&
    keyOk
  );
});

async function submitForm() {
  if (!formValid.value || saving.value) return;
  const shortIds = splitList(form.reality_short_ids);
  const alpn = splitList(form.alpn);

  // Build without the write-only secret; only attach it when provided so an
  // edit that leaves the field blank keeps the stored key (never sends "").
  const req: Omit<ProxyInboundUpsertRequest, "reality_private_key"> &
    Partial<Pick<ProxyInboundUpsertRequest, "reality_private_key">> = {
    name: form.name.trim(),
    core: form.core,
    port: Number(form.port),
    reality_short_ids: shortIds,
    reality_dest: form.reality_dest.trim(),
    enabled: form.enabled,
  };
  if (editingId.value) req.id = editingId.value;
  if (form.listen.trim()) req.listen = form.listen.trim();
  if (form.sni.trim()) req.sni = form.sni.trim();
  if (alpn.length) req.alpn = alpn;
  if (form.fingerprint.trim()) req.fingerprint = form.fingerprint.trim();
  if (form.reality_public_key.trim()) req.reality_public_key = form.reality_public_key.trim();
  if (form.reality_private_key.trim()) req.reality_private_key = form.reality_private_key.trim();

  saving.value = true;
  try {
    // On create, formValid guarantees reality_private_key is present; on edit the
    // server keeps the stored key when it is omitted.
    await api.proxy.upsertInbound(req as ProxyInboundUpsertRequest);
    toast.success(editingId.value ? t("proxy.inbounds.toastUpdated") : t("proxy.inbounds.toastCreated"));
    dialogOpen.value = false;
    inboundsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("proxy.inbounds.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ---- Delete dialog state ----
const deleteTarget = ref<ProxyInboundView | undefined>();
const deleteOpen = ref(false);
const deleting = ref(false);
const deleteConflict = ref(false);
const deleteConflictMessage = ref("");

function askDelete(inbound: ProxyInboundView) {
  if (!canAdmin.value) return;
  deleteTarget.value = inbound;
  deleteConflict.value = false;
  deleteConflictMessage.value = "";
  deleteOpen.value = true;
}

async function confirmDelete(force: boolean) {
  const target = deleteTarget.value;
  if (!target || deleting.value) return;
  deleting.value = true;
  try {
    await api.proxy.deleteInbound(target.id, force || undefined);
    toast.success(t("proxy.inbounds.toastDeleted"));
    deleteOpen.value = false;
    deleteTarget.value = undefined;
    inboundsQuery.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("proxy.inbounds.toastDeleteFailed");
    const isConflict =
      error instanceof ApiError && (error.status === 409 || error.code === "conflict");
    if (isConflict && !force) {
      deleteConflict.value = true;
      deleteConflictMessage.value = message;
    } else {
      toast.error(message);
    }
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.inbounds.title')"
      :description="$t('proxy.inbounds.description')"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="inboundsQuery.refreshing.value"
          @click="inboundsQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', inboundsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="canAdmin"
          size="sm"
          @click="openCreate"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('proxy.inbounds.newInbound') }}
        </Button>
        <Button v-else size="sm" disabled :title="adminReason">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('proxy.inbounds.newInbound') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('proxy.inbounds.kpiInbounds') }}</p>
            <p class="text-2xl font-semibold tabular">{{ inbounds.length }}</p>
          </div>
          <Network class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('proxy.inbounds.kpiEnabled') }}</p>
            <p class="text-2xl font-semibold tabular text-success">{{ enabledCount }}</p>
          </div>
          <ShieldCheck class="size-5 text-success" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('proxy.inbounds.kpiRealityKeySet') }}</p>
            <p
              :class="cn('text-2xl font-semibold tabular', realitySetCount < inbounds.length && 'text-warning')"
            >
              {{ realitySetCount }} / {{ inbounds.length }}
            </p>
          </div>
          <KeyRound class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Network class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('proxy.inbounds.listeners') }}
        </CardTitle>
        <CardDescription>
          {{ $t('proxy.inbounds.listenersDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="inboundsQuery.loading.value"
          :error="inboundsQuery.error.value"
          :is-empty="inbounds.length === 0"
          :empty-title="$t('proxy.inbounds.emptyTitle')"
          :empty-description="$t('proxy.inbounds.emptyDescription')"
          @retry="inboundsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colName') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colCore') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colProtocolPort') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colSecurity') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colRealityDest') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colPrivateKey') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colState') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('proxy.inbounds.colUpdated') }}</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('proxy.inbounds.colActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="inbound in sortedInbounds"
                  :key="inbound.id"
                  class="border-b border-border hover:bg-muted/40"
                >
                  <td class="px-3 py-3">
                    <div class="font-medium">{{ inbound.name || shortId(inbound.id) }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ shortId(inbound.id, 16) }}</div>
                  </td>
                  <td class="px-3 py-3">
                    <Badge variant="outline">{{ inbound.core || "sing-box" }}</Badge>
                  </td>
                  <td class="px-3 py-3">
                    <span class="font-mono text-xs">
                      {{ inbound.protocol || "vless" }} ·
                      {{ inbound.listen || "0.0.0.0" }}:{{ inbound.port }}
                    </span>
                  </td>
                  <td class="px-3 py-3">
                    <Badge variant="info">{{ inbound.security || "reality" }}</Badge>
                  </td>
                  <td class="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {{ inbound.reality_dest || "—" }}
                  </td>
                  <td class="px-3 py-3">
                    <Badge
                      :variant="inbound.has_reality_private_key ? 'success' : 'destructive'"
                      class="gap-1"
                    >
                      <Lock class="size-3" aria-hidden="true" />
                      {{ inbound.has_reality_private_key ? $t('common.status.set') : $t('common.status.missing') }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="inbound.enabled ? 'success' : 'secondary'">
                      {{ inbound.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3 text-xs text-muted-foreground">
                    <span :title="formatDateTime(inbound.updated_at)">
                      {{ formatRelativeTime(inbound.updated_at) }}
                    </span>
                  </td>
                  <td class="px-3 py-3">
                    <div class="flex justify-end gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin"
                        :title="canAdmin ? $t('proxy.inbounds.editInbound') : adminReason"
                        :aria-label="$t('common.actions.edit')"
                        @click="openEdit(inbound)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        :disabled="!canAdmin"
                        :title="canAdmin ? $t('proxy.inbounds.deleteInbound') : adminReason"
                        :aria-label="$t('common.actions.delete')"
                        @click="askDelete(inbound)"
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
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ isEditing ? $t('proxy.inbounds.dialogTitleEdit') : $t('proxy.inbounds.dialogTitleNew') }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.inbounds.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="inbound-name">{{ $t('proxy.inbounds.fieldName') }}</Label>
              <Input id="inbound-name" v-model="form.name" required :placeholder="$t('proxy.inbounds.fieldNamePlaceholder')" />
            </div>
            <div class="grid gap-2">
              <Label for="inbound-core">{{ $t('proxy.inbounds.fieldCore') }}</Label>
              <Select v-model="form.core">
                <SelectTrigger id="inbound-core">
                  <SelectValue :placeholder="$t('proxy.inbounds.selectCore')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sing-box">sing-box</SelectItem>
                  <SelectItem value="xray">xray</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="inbound-port">{{ $t('proxy.inbounds.fieldPort') }}</Label>
              <Input
                id="inbound-port"
                v-model="form.port"
                type="number"
                min="1"
                max="65535"
                required
                :placeholder="$t('proxy.inbounds.fieldPortPlaceholder')"
              />
            </div>
            <div class="grid gap-2">
              <Label for="inbound-listen">{{ $t('proxy.inbounds.fieldListen') }}</Label>
              <Input id="inbound-listen" v-model="form.listen" :placeholder="$t('proxy.inbounds.fieldListenPlaceholder')" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="inbound-sni">{{ $t('proxy.inbounds.fieldSni') }}</Label>
              <Input id="inbound-sni" v-model="form.sni" :placeholder="$t('proxy.inbounds.fieldSniPlaceholder')" />
            </div>
            <div class="grid gap-2">
              <Label for="inbound-fingerprint">{{ $t('proxy.inbounds.fieldFingerprint') }}</Label>
              <Input id="inbound-fingerprint" v-model="form.fingerprint" :placeholder="$t('proxy.inbounds.fieldFingerprintPlaceholder')" />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="inbound-alpn">{{ $t('proxy.inbounds.fieldAlpn') }}</Label>
            <Input id="inbound-alpn" v-model="form.alpn" :placeholder="$t('proxy.inbounds.fieldAlpnPlaceholder')" />
          </div>

          <div class="grid gap-2">
            <Label for="inbound-dest">{{ $t('proxy.inbounds.fieldRealityDest') }}</Label>
            <Input id="inbound-dest" v-model="form.reality_dest" required :placeholder="$t('proxy.inbounds.fieldRealityDestPlaceholder')" />
          </div>

          <div class="grid gap-2">
            <Label for="inbound-shortids">{{ $t('proxy.inbounds.fieldShortIds') }}</Label>
            <Input
              id="inbound-shortids"
              v-model="form.reality_short_ids"
              required
              :placeholder="$t('proxy.inbounds.fieldShortIdsPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">{{ $t('proxy.inbounds.shortIdsHint') }}</p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="inbound-private">{{ $t('proxy.inbounds.fieldPrivateKey') }} {{ isEditing ? "" : "*" }}</Label>
              <Input
                id="inbound-private"
                v-model="form.reality_private_key"
                type="password"
                autocomplete="off"
                :required="!isEditing"
                :placeholder="isEditing ? $t('proxy.inbounds.fieldPrivateKeyPlaceholderKeep') : $t('proxy.inbounds.fieldPrivateKeyPlaceholderNew')"
              />
            </div>
            <div class="grid gap-2">
              <Label for="inbound-public">{{ $t('proxy.inbounds.fieldPublicKey') }}</Label>
              <Input id="inbound-public" v-model="form.reality_public_key" :placeholder="$t('proxy.inbounds.fieldPublicKeyPlaceholder')" />
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
            {{ $t('proxy.inbounds.enabled') }}
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!formValid || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Server v-else class="size-4" aria-hidden="true" />
              {{ isEditing ? $t('common.actions.saveChanges') : $t('proxy.inbounds.createInbound') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete dialog -->
    <Dialog v-model:open="deleteOpen">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('proxy.inbounds.deleteTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('proxy.inbounds.deleteConfirm', { name: deleteTarget?.name || deleteTarget?.id }) }}
          </DialogDescription>
        </DialogHeader>

        <div
          v-if="deleteConflict"
          class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning"
        >
          {{ deleteConflictMessage }}
          <p class="mt-1 text-xs text-muted-foreground">
            {{ $t('proxy.inbounds.deleteConflictHint') }}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" @click="deleteOpen = false">{{ $t('common.actions.cancel') }}</Button>
          <Button
            v-if="!deleteConflict"
            type="button"
            variant="destructive"
            :disabled="deleting"
            @click="confirmDelete(false)"
          >
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
          <Button
            v-else
            type="button"
            variant="destructive"
            :disabled="deleting"
            @click="confirmDelete(true)"
          >
            <RefreshCw v-if="deleting" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.forceDelete') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
