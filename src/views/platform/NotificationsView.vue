<script setup lang="ts">
import { computed, ref } from "vue";
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
    { key: "token", label: "Bot token", required: true, placeholder: "123456:ABC-DEF…" },
    { key: "chat_id", label: "Chat ID", required: true, placeholder: "-1001234567890" },
    { key: "base_url", label: "Base URL", required: false, placeholder: "https://api.telegram.org (optional)" },
  ],
  bark: [
    { key: "base_url", label: "Base URL", required: true, placeholder: "https://api.day.app" },
    { key: "key", label: "Device key", required: true, placeholder: "device key" },
  ],
  discord: [
    { key: "webhook_url", label: "Webhook URL", required: true, placeholder: "https://discord.com/api/webhooks/…" },
  ],
  webhook: [
    { key: "url", label: "URL", required: true, placeholder: "https://example.com/hook" },
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
    toast.success(editingId.value ? "Channel updated" : "Channel created");
    formOpen.value = false;
    channelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Save failed");
  } finally {
    saving.value = false;
  }
}

async function sendTest(): Promise<void> {
  if (!canSend.value) return;
  if (!configComplete.value) {
    toast.error("Enter the required config fields before testing.");
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
    if (res.ok) toast.success(`Test delivered via ${res.channel}`);
    else toast.error("Test delivery failed");
  } catch (error) {
    // Delivery failure surfaces as 502 from the API; message is human-readable.
    toast.error(error instanceof Error ? error.message : "Test delivery failed");
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
    toast.success("Channel deleted");
    deleteTarget.value = undefined;
    channelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Delete failed");
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Notifications" description="Outbound notification channels for alerts and monitor flips">
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="channelsQuery.refreshing.value"
          @click="channelsQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', channelsQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canSend" size="sm" @click="openCreate">
          <Plus class="size-4" />
          New channel
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Bell class="size-4 text-muted-foreground" />
          Channels
        </CardTitle>
        <CardDescription>
          {{ channels.length }} {{ channels.length === 1 ? "channel" : "channels" }} ·
          secrets are write-only and never returned by the server
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="channelsQuery.loading.value"
          :error="channelsQuery.error.value"
          :is-empty="channels.length === 0"
          empty-title="No channels configured"
          empty-description="Add a telegram, bark, discord, or webhook channel to receive notifications."
          @retry="channelsQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th class="py-2 pr-4 font-medium">Name</th>
                  <th class="py-2 pr-4 font-medium">Kind</th>
                  <th class="py-2 pr-4 font-medium">Configured keys</th>
                  <th class="py-2 pr-4 font-medium">Status</th>
                  <th class="py-2 pr-4 font-medium">Updated</th>
                  <th class="py-2 pl-4 text-right font-medium">Actions</th>
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
                      <span v-if="channel.config_keys.length === 0" class="text-xs text-muted-foreground">none</span>
                    </div>
                  </td>
                  <td class="py-3 pr-4">
                    <Badge :variant="channel.enabled ? 'success' : 'secondary'">
                      {{ channel.enabled ? "enabled" : "disabled" }}
                    </Badge>
                  </td>
                  <td class="py-3 pr-4 text-xs text-muted-foreground">{{ formatDateTime(channel.updated_at) }}</td>
                  <td class="py-3 pl-4">
                    <div class="flex justify-end gap-1">
                      <Button
                        v-if="canSend"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit channel"
                        @click="openEdit(channel)"
                      >
                        <Pencil class="size-4" />
                      </Button>
                      <Button
                        v-if="canSend"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete channel"
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
          <DialogTitle>{{ editingId ? "Edit channel" : "New channel" }}</DialogTitle>
          <DialogDescription>
            Configure an outbound destination. Secrets are write-only — on edit, leave fields filled to set
            new values (stored secrets are never returned).
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ch-name">Name</Label>
              <Input id="ch-name" v-model="formName" required placeholder="ops-alerts" />
            </div>
            <div class="grid gap-2">
              <Label for="ch-kind">Kind</Label>
              <Select v-model="formKind" @update:model-value="onKindChange">
                <SelectTrigger id="ch-kind">
                  <SelectValue placeholder="Select kind" />
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
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ formKind }} config</p>
            <div v-for="field in activeFields" :key="field.key" class="grid gap-2">
              <Label :for="`cfg-${field.key}`">
                {{ field.label }}
                <span v-if="field.required" class="text-destructive">*</span>
              </Label>
              <Input
                :id="`cfg-${field.key}`"
                v-model="formConfig[field.key]"
                :placeholder="editingId ? 'leave blank to keep current' : field.placeholder"
                autocomplete="off"
              />
            </div>
            <p v-if="editingId" class="text-xs text-muted-foreground">
              Editing replaces the full config. Re-enter every required field to update the channel.
            </p>
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="formEnabled" type="checkbox" class="size-4 accent-primary" />
            Enabled
          </label>

          <div class="space-y-3 rounded-md border border-dashed border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">Send test</p>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="test-title">Title</Label>
                <Input id="test-title" v-model="formTitle" placeholder="Lattice test" />
              </div>
              <div class="grid gap-2">
                <Label for="test-body">Body</Label>
                <Input id="test-body" v-model="formBody" placeholder="Notification channel verified." />
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="testing || !configComplete"
              @click="sendTest"
            >
              <RefreshCw v-if="testing" class="size-4 animate-spin" />
              <Send v-else class="size-4" />
              Send test
            </Button>
            <p class="text-xs text-muted-foreground">
              Tests deliver through the config entered above (not a stored channel).
            </p>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" />
              <Plus v-else-if="!editingId" class="size-4" />
              <Pencil v-else class="size-4" />
              {{ editingId ? "Save" : "Create" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete channel?</DialogTitle>
          <DialogDescription>
            Remove "{{ deleteTarget?.name || deleteTarget?.id }}". This cannot be undone.
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
