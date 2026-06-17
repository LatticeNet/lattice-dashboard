<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Bell,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  type NotifyChannelUpsertRequest,
  type NotifyChannelView,
  type NotifyKind,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

type FieldDef = { key: string; label: string; required: boolean; placeholder: string };

const KIND_FIELDS: Record<NotifyKind, FieldDef[]> = {
  telegram: [
    { key: "token", label: "platform.notifications.fieldBotToken", required: true, placeholder: "123456:ABC-DEF…" },
    { key: "chat_id", label: "platform.notifications.fieldChatId", required: true, placeholder: "-1001234567890" },
    { key: "base_url", label: "platform.notifications.fieldBaseUrl", required: false, placeholder: "https://api.telegram.org (optional)" },
  ],
  bark: [
    { key: "base_url", label: "platform.notifications.fieldBaseUrl", required: true, placeholder: "https://api.day.app" },
    { key: "key", label: "platform.notifications.fieldDeviceKey", required: true, placeholder: "platform.notifications.deviceKeyPlaceholder" },
  ],
  discord: [
    { key: "webhook_url", label: "platform.notifications.fieldWebhookUrl", required: true, placeholder: "https://discord.com/api/webhooks/…" },
  ],
  webhook: [
    { key: "url", label: "platform.notifications.fieldUrl", required: true, placeholder: "https://example.com/hook" },
  ],
};

const KIND_OPTIONS: NotifyKind[] = ["telegram", "bark", "discord", "webhook"];

function kindBadgeVariant(kind: string): "info" | "secondary" | "default" | "warning" {
  switch (kind) {
    case "telegram":
      return "info";
    case "discord":
      return "default";
    case "bark":
      return "warning";
    default:
      return "secondary";
  }
}

const { t } = useI18n();
const auth = useAuthStore();
const canSend = computed(() => auth.can("notify:send"));

// BARE ARRAY endpoint — do NOT unwrap.
const channelsQuery = useAsyncData(() => api.notify.channels(), { pollInterval: 12000 });
const channels = computed(() => channelsQuery.data.value ?? []);

const sortedChannels = computed(() =>
  [...channels.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

// ── Create / edit dialog ─────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const testing = ref(false);
const editingId = ref<string | undefined>();

const formName = ref("");
const formKind = ref<NotifyKind>("telegram");
const formEnabled = ref(true);
const formConfig = ref<Record<string, string>>({});
const formTitle = ref("");
const formBody = ref("");

const activeFields = computed<FieldDef[]>(() => KIND_FIELDS[formKind.value]);

function resetConfigForKind(): void {
  const next: Record<string, string> = {};
  for (const field of KIND_FIELDS[formKind.value]) next[field.key] = "";
  formConfig.value = next;
}

function openCreate(): void {
  if (!canSend.value) return;
  editingId.value = undefined;
  formName.value = "";
  formKind.value = "telegram";
  formEnabled.value = true;
  formTitle.value = "";
  formBody.value = "";
  resetConfigForKind();
  formOpen.value = true;
}

function openEdit(channel: NotifyChannelView): void {
  if (!canSend.value) return;
  editingId.value = channel.id;
  formName.value = channel.name;
  formKind.value = (KIND_OPTIONS.includes(channel.kind as NotifyKind)
    ? channel.kind
    : "telegram") as NotifyKind;
  formEnabled.value = channel.enabled;
  formTitle.value = "";
  formBody.value = "";
  resetConfigForKind();
  formOpen.value = true;
}

function onKindChange(): void {
  resetConfigForKind();
}

const configComplete = computed(() =>
  activeFields.value
    .filter((field) => field.required)
    .every((field) => (formConfig.value[field.key] ?? "").trim().length > 0),
);

const canSubmit = computed(() => !!formName.value.trim() && configComplete.value);

function buildConfig(): Record<string, string> {
  const config: Record<string, string> = {};
  for (const field of activeFields.value) {
    const value = (formConfig.value[field.key] ?? "").trim();
    if (value) config[field.key] = value;
  }
  return config;
}

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !canSend.value) return;
  saving.value = true;
  try {
    const req: NotifyChannelUpsertRequest = {
      name: formName.value.trim(),
      kind: formKind.value,
      config: buildConfig(),
      enabled: formEnabled.value,
    };
    await api.notify.upsertChannel(req);
    toast.success(editingId.value ? t("platform.notifications.channelUpdated") : t("platform.notifications.channelCreated"));
    formOpen.value = false;
    channelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.saveFailed"));
  } finally {
    saving.value = false;
  }
}

async function sendTest(): Promise<void> {
  if (!canSend.value) return;
  if (!configComplete.value) {
    toast.error(t("platform.notifications.enterRequiredFields"));
    return;
  }
  testing.value = true;
  try {
    const res = await api.notify.test({
      channel: formKind.value,
      config: buildConfig(),
      title: formTitle.value.trim() || undefined,
      body: formBody.value.trim() || undefined,
    });
    if (res.ok) toast.success(t("platform.notifications.testDelivered", { channel: res.channel }));
    else toast.error(t("platform.notifications.testDeliveryFailed"));
  } catch (error) {
    // Delivery failure surfaces as 502 from the API; message is human-readable.
    toast.error(error instanceof Error ? error.message : t("platform.notifications.testDeliveryFailed"));
  } finally {
    testing.value = false;
  }
}

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<NotifyChannelView | undefined>();
const deleting = ref(false);

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.notify.deleteChannel(deleteTarget.value.id);
    toast.success(t("platform.notifications.channelDeleted"));
    deleteTarget.value = undefined;
    channelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.deleteFailed"));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('platform.notifications.title')" :description="$t('platform.notifications.description')">
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="channelsQuery.refreshing.value"
          @click="channelsQuery.refresh"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', channelsQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canSend" size="sm" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.notifications.newChannel') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Bell aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.notifications.channelsTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('platform.notifications.channelsCount', { count: channels.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="channelsQuery.loading.value"
          :error="channelsQuery.error.value"
          :is-empty="channels.length === 0"
          :empty-title="$t('platform.notifications.emptyTitle')"
          :empty-description="$t('platform.notifications.emptyDescription')"
          @retry="channelsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.notifications.colName') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.notifications.colKind') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.notifications.colConfiguredKeys') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.notifications.colStatus') }}</th>
                  <th scope="col" class="py-2 pr-4 font-medium">{{ $t('platform.notifications.colUpdated') }}</th>
                  <th scope="col" class="py-2 pl-4 text-right font-medium">{{ $t('platform.notifications.colActions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="channel in sortedChannels"
                  :key="channel.id"
                  class="border-b border-border hover:bg-muted/40"
                >
                  <td class="py-3 pr-4">
                    <div class="font-medium">{{ channel.name || channel.id }}</div>
                  </td>
                  <td class="py-3 pr-4">
                    <Badge :variant="kindBadgeVariant(channel.kind)">{{ channel.kind }}</Badge>
                  </td>
                  <td class="py-3 pr-4">
                    <div class="flex flex-wrap gap-1">
                      <Badge
                        v-for="key in channel.config_keys"
                        :key="key"
                        variant="outline"
                        class="font-mono text-[10px]"
                      >
                        {{ key }}
                      </Badge>
                      <span v-if="channel.config_keys.length === 0" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
                    </div>
                  </td>
                  <td class="py-3 pr-4">
                    <Badge :variant="channel.enabled ? 'success' : 'secondary'">
                      {{ channel.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
                    </Badge>
                  </td>
                  <td class="py-3 pr-4 text-xs text-muted-foreground">{{ formatDateTime(channel.updated_at) }}</td>
                  <td class="py-3 pl-4">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canSend"
                        variant="ghost"
                        size="icon-sm"
                        :aria-label="$t('platform.notifications.editChannelAria')"
                        @click="openEdit(channel)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canSend"
                        variant="ghost"
                        size="icon-sm"
                        :aria-label="$t('platform.notifications.deleteChannelAria')"
                        @click="deleteTarget = channel"
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

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('platform.notifications.editChannelTitle') : $t('platform.notifications.newChannelTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.notifications.formHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ch-name">{{ $t('platform.notifications.nameLabel') }}</Label>
              <Input id="ch-name" v-model="formName" required placeholder="ops-alerts" />
            </div>
            <div class="grid gap-2">
              <Label for="ch-kind">{{ $t('platform.notifications.kindLabel') }}</Label>
              <Select v-model="formKind" @update:model-value="onKindChange">
                <SelectTrigger id="ch-kind">
                  <SelectValue :placeholder="$t('platform.notifications.selectKind')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="kind in KIND_OPTIONS" :key="kind" :value="kind">
                    {{ kind }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="space-y-3 rounded-md border border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.kindConfig', { kind: formKind }) }}</p>
            <div v-for="field in activeFields" :key="field.key" class="grid gap-2">
              <Label :for="`cfg-${field.key}`">
                {{ $t(field.label) }}
                <span v-if="field.required" class="text-destructive">*</span>
              </Label>
              <Input
                :id="`cfg-${field.key}`"
                v-model="formConfig[field.key]"
                :placeholder="editingId ? $t('common.misc.keepBlank') : (field.placeholder.startsWith('platform.') ? $t(field.placeholder) : field.placeholder)"
                autocomplete="off"
              />
            </div>
            <p v-if="editingId" class="text-xs text-muted-foreground">
              {{ $t('platform.notifications.replaceConfigHint') }}
            </p>
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="formEnabled" type="checkbox" class="size-4 accent-primary" />
            {{ $t('platform.notifications.enabledLabel') }}
          </label>

          <div class="space-y-3 rounded-md border border-dashed border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.sendTest') }}</p>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="test-title">{{ $t('platform.notifications.testTitleLabel') }}</Label>
                <Input id="test-title" v-model="formTitle" :placeholder="$t('platform.notifications.testTitlePlaceholder')" />
              </div>
              <div class="grid gap-2">
                <Label for="test-body">{{ $t('platform.notifications.testBodyLabel') }}</Label>
                <Input id="test-body" v-model="formBody" :placeholder="$t('platform.notifications.testBodyPlaceholder')" />
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="testing || !configComplete"
              @click="sendTest"
            >
              <RefreshCw v-if="testing" aria-hidden="true" class="size-4 animate-spin" />
              <Send v-else aria-hidden="true" class="size-4" />
              {{ $t('platform.notifications.sendTest') }}
            </Button>
            <p class="text-xs text-muted-foreground">
              {{ $t('platform.notifications.testThroughConfigHint') }}
            </p>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" aria-hidden="true" class="size-4 animate-spin" />
              <Plus v-else-if="!editingId" aria-hidden="true" class="size-4" />
              <Pencil v-else aria-hidden="true" class="size-4" />
              {{ editingId ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.notifications.deleteChannelTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.notifications.deleteChannelConfirm', { name: deleteTarget?.name || deleteTarget?.id }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" aria-hidden="true" class="size-4 animate-spin" />
            <Trash2 v-else aria-hidden="true" class="size-4" />
            {{ $t('common.actions.delete') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
