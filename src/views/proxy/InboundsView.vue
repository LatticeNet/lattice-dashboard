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
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import { statusMeta } from "@/lib/status";
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
  attempted.value = false;
  assignForm(blankForm());
  dialogOpen.value = true;
}

function openEdit(inbound: ProxyInboundView) {
  if (!canAdmin.value) return;
  editingId.value = inbound.id;
  attempted.value = false;
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

// Surface inline field errors only after a save attempt (avoids nagging on a fresh form).
const attempted = ref(false);

const portValue = computed(() => Number(form.port));
const portValid = computed(
  () => Number.isInteger(portValue.value) && portValue.value >= 1 && portValue.value <= 65535,
);
const shortIdsValid = computed(() => splitList(form.reality_short_ids).length >= 1);
const nameValid = computed(() => form.name.trim().length > 0);
const destValid = computed(() => form.reality_dest.trim().length > 0);
const privateKeyValid = computed(
  () => isEditing.value || form.reality_private_key.trim().length > 0,
);

const nameError = computed(() => (attempted.value && !nameValid.value ? t("proxy.inbounds.errorNameRequired") : ""));
const portError = computed(() => (attempted.value && !portValid.value ? t("proxy.inbounds.errorPort") : ""));
const destError = computed(() => (attempted.value && !destValid.value ? t("proxy.inbounds.errorDestRequired") : ""));
const shortIdsError = computed(() => (attempted.value && !shortIdsValid.value ? t("proxy.inbounds.errorShortIds") : ""));
const privateKeyError = computed(() => (attempted.value && !privateKeyValid.value ? t("proxy.inbounds.errorPrivateKey") : ""));

const formValid = computed(
  () =>
    nameValid.value &&
    portValid.value &&
    shortIdsValid.value &&
    destValid.value &&
    privateKeyValid.value,
);

// ── DataTable columns ──────────────────────────────────────────────────────────
const inboundColumns = computed<DataTableColumn<ProxyInboundView>[]>(() => [
  { key: "name", label: t("proxy.inbounds.colName"), sortable: true, searchable: true, value: (i) => i.name || i.id },
  { key: "core", label: t("proxy.inbounds.colCore"), sortable: true, searchable: true, value: (i) => i.core || "sing-box" },
  { key: "protocolPort", label: t("proxy.inbounds.colProtocolPort"), sortable: true, value: (i) => i.port ?? 0 },
  { key: "security", label: t("proxy.inbounds.colSecurity"), value: (i) => i.security || "reality" },
  { key: "realityDest", label: t("proxy.inbounds.colRealityDest"), sortable: true, searchable: true, value: (i) => i.reality_dest || "" },
  { key: "privateKey", label: t("proxy.inbounds.colPrivateKey"), sortable: true, value: (i) => (i.has_reality_private_key ? 1 : 0) },
  { key: "state", label: t("proxy.inbounds.colState"), sortable: true, value: (i) => (i.enabled ? 1 : 0) },
  { key: "updated", label: t("proxy.inbounds.colUpdated"), sortable: true, value: (i) => i.updated_at || "" },
  { key: "actions", label: t("proxy.inbounds.colActions"), align: "right" },
]);

async function submitForm() {
  attempted.value = true;
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

// ConfirmDialog drives a single confirm action; force is implied once the server
// reports a 409 conflict and the operator confirms again.
function onDeleteConfirm() {
  confirmDelete(deleteConflict.value);
}

const deleteConfirmLabel = computed(() =>
  deleteConflict.value ? t("common.actions.forceDelete") : t("common.actions.delete"),
);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('proxy.inbounds.title')"
      :description="$t('proxy.inbounds.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="inboundsQuery.lastUpdated.value" />
      </template>
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
        <DataTable
          :columns="inboundColumns"
          :rows="sortedInbounds"
          :row-key="(i) => i.id"
          :loading="inboundsQuery.loading.value"
          :error="inboundsQuery.error.value"
          :page-size="15"
          searchable
          :search-placeholder="$t('proxy.inbounds.searchPlaceholder')"
          :empty-title="$t('proxy.inbounds.emptyTitle')"
          :empty-description="$t('proxy.inbounds.emptyDescription')"
          :no-match-title="$t('proxy.table.noMatchTitle')"
          :no-match-description="$t('proxy.table.noMatchDescription')"
          :actions-label="$t('proxy.inbounds.colActions')"
          :showing-label="$t('proxy.table.showing')"
          :of-label="$t('proxy.table.of')"
          :page-of-label="$t('proxy.table.of')"
          :prev-label="$t('proxy.table.prevPage')"
          :next-label="$t('proxy.table.nextPage')"
          :clear-search-label="$t('proxy.table.clearSearch')"
          @retry="inboundsQuery.refresh"
        >
          <template #cell-name="{ row }">
            <div class="min-w-0">
              <div class="font-medium">{{ row.name || shortId(row.id) }}</div>
              <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.id, 16) }}</div>
            </div>
          </template>
          <template #cell-core="{ row }">
            <Badge variant="outline">{{ row.core || "sing-box" }}</Badge>
          </template>
          <template #cell-protocolPort="{ row }">
            <span class="font-mono text-xs">
              {{ row.protocol || "vless" }} ·
              {{ row.listen || "0.0.0.0" }}:{{ row.port }}
            </span>
          </template>
          <template #cell-security="{ row }">
            <Badge variant="info">{{ row.security || "reality" }}</Badge>
          </template>
          <template #cell-realityDest="{ row }">
            <span class="font-mono text-xs text-muted-foreground">{{ row.reality_dest || "—" }}</span>
          </template>
          <template #cell-privateKey="{ row }">
            <Badge
              :variant="row.has_reality_private_key ? statusMeta('online').badgeVariant : statusMeta('offline').badgeVariant"
              class="gap-1"
            >
              <Lock class="size-3" aria-hidden="true" />
              {{ row.has_reality_private_key ? $t('common.status.set') : $t('common.status.missing') }}
            </Badge>
          </template>
          <template #cell-state="{ row }">
            <Badge :variant="row.enabled ? statusMeta('online').badgeVariant : 'secondary'">
              {{ row.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
            </Badge>
          </template>
          <template #cell-updated="{ row }">
            <span class="text-xs text-muted-foreground" :title="formatDateTime(row.updated_at)">
              {{ formatRelativeTime(row.updated_at) }}
            </span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                :disabled="!canAdmin"
                :title="canAdmin ? $t('proxy.inbounds.editInbound') : adminReason"
                :aria-label="$t('common.actions.edit')"
                @click="openEdit(row)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                :disabled="!canAdmin"
                :title="canAdmin ? $t('proxy.inbounds.deleteInbound') : adminReason"
                :aria-label="$t('common.actions.delete')"
                @click="askDelete(row)"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
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
              <Input
                id="inbound-name"
                v-model="form.name"
                required
                :aria-invalid="!!nameError"
                :class="cn(nameError && 'border-destructive')"
                :placeholder="$t('proxy.inbounds.fieldNamePlaceholder')"
              />
              <p v-if="nameError" class="text-xs text-destructive">{{ nameError }}</p>
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
                :aria-invalid="!!portError"
                :class="cn(portError && 'border-destructive')"
                :placeholder="$t('proxy.inbounds.fieldPortPlaceholder')"
              />
              <p v-if="portError" class="text-xs text-destructive">{{ portError }}</p>
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
            <Input
              id="inbound-dest"
              v-model="form.reality_dest"
              required
              :aria-invalid="!!destError"
              :class="cn(destError && 'border-destructive')"
              :placeholder="$t('proxy.inbounds.fieldRealityDestPlaceholder')"
            />
            <p v-if="destError" class="text-xs text-destructive">{{ destError }}</p>
          </div>

          <div class="grid gap-2">
            <Label for="inbound-shortids">{{ $t('proxy.inbounds.fieldShortIds') }}</Label>
            <Input
              id="inbound-shortids"
              v-model="form.reality_short_ids"
              required
              :aria-invalid="!!shortIdsError"
              :class="cn(shortIdsError && 'border-destructive')"
              :placeholder="$t('proxy.inbounds.fieldShortIdsPlaceholder')"
            />
            <p v-if="shortIdsError" class="text-xs text-destructive">{{ shortIdsError }}</p>
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
                :aria-invalid="!!privateKeyError"
                :class="cn(privateKeyError && 'border-destructive')"
                :placeholder="isEditing ? $t('proxy.inbounds.fieldPrivateKeyPlaceholderKeep') : $t('proxy.inbounds.fieldPrivateKeyPlaceholderNew')"
              />
              <p v-if="privateKeyError" class="text-xs text-destructive">{{ privateKeyError }}</p>
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

    <!-- Delete confirm (themed; force-delete after a 409 conflict) -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('proxy.inbounds.deleteTitle')"
      :description="$t('proxy.inbounds.deleteConfirm', { name: deleteTarget?.name || deleteTarget?.id })"
      :confirm-label="deleteConfirmLabel"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @confirm="onDeleteConfirm"
    >
      <div
        v-if="deleteConflict"
        class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-warning"
      >
        {{ deleteConflictMessage }}
        <p class="mt-1 text-xs text-muted-foreground">
          {{ $t('proxy.inbounds.deleteConflictHint') }}
        </p>
      </div>
    </ConfirmDialog>
  </div>
</template>
