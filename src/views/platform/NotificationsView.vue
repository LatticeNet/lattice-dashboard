<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import {
  Bell,
  CalendarClock,
  GitBranch,
  TriangleAlert,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Unplug,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type MachineView,
  type Node,
  type NotifyChannelUpsertRequest,
  type NotifyChannelView,
  type NotifyKind,
  type NotifyRuleUpsertRequest,
  type NotifyRuleView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatDay } from "@/views/fleet/inventoryEditorModel";
import { reminderCoverage, reminderMachineName, ruleRoutesRenewals } from "@/views/fleet/reminderModel";
import {
  DEFAULT_OFFLINE_MINUTES,
  formatOfflineDelay,
  nodeOfflinePolicy,
  ruleRoutesNodeOffline,
} from "@/views/platform/nodeOfflineModel";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  buildConfig as buildConfigFor,
  channelSaveGate,
  configComplete as configCompleteFor,
  fromSelectValue,
  KIND_FIELDS,
  KIND_OPTIONS,
  SELECT_DEFAULT,
  toSelectValue,
  type FieldDef,
} from "./notificationsModel";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

type RulePreset = {
  key: "quota" | "monitor" | "ssh";
  events: string;
  title: string;
  body: string;
};

// Every event type the server sends, typed or classified. ssh.pressure_window
// is left out on purpose: it is recorded, never notified.
const EVENT_OPTIONS = [
  "*",
  "monitor.down",
  "monitor.recovered",
  "service.down",
  "service.recovered",
  "node.offline",
  "node.online",
  "ssh.login",
  "ssh.compromise_suspected",
  "auth.2fa_limit",
  "proxy.quota",
  "proxy.expiry",
  "inventory.renewal",
];
// renderNotifyTemplate substitutes exactly three variables: event_type, title,
// and body. Anything else is left in the delivered message verbatim, which is
// how these presets used to ship literal "{{message}}" to Telegram.
const RULE_PRESETS: RulePreset[] = [
  {
    key: "quota",
    events: "proxy.quota, proxy.expiry",
    title: "{{event_type}}: {{title}}",
    body: "{{body}}",
  },
  {
    key: "monitor",
    events: "monitor.down, monitor.recovered",
    title: "{{event_type}}: {{title}}",
    body: "{{body}}",
  },
  {
    key: "ssh",
    events: "ssh.login",
    title: "SSH login: {{title}}",
    body: "{{body}}",
  },
];

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
// The notify split (2026-09): notify:admin governs channels, rules and
// webhooks; notify:send is dispatch only and gates just the test-send below.
const canManage = computed(() => auth.can("notify:admin"));
const canSend = computed(() => auth.can("notify:send"));

// BARE ARRAY endpoint: do NOT unwrap.
const channelsQuery = useAsyncData((signal) => api.notify.channels({ signal }), { pollInterval: 12000 });
const channels = computed(() => channelsQuery.data.value ?? []);
const rulesQuery = useAsyncData((signal) => api.notify.rules({ signal }), { pollInterval: 12000 });
const rules = computed(() => rulesQuery.data.value?.rules ?? []);

// Machines, for the line under each rule that routes inventory.renewal: how
// many machines it reaches and when the next reminder goes out. Read only
// with inventory:read; without it the line says so instead of guessing.
const canReadInventory = computed(() => auth.can("inventory:read"));
const machinesQuery = useAsyncData<MachineView[] | undefined>(
  (signal) =>
    canReadInventory.value
      ? api.machines.list({ signal }).then((r) => unwrap(r, "machines"))
      : Promise.resolve(undefined),
  { pollInterval: 60_000 },
);
const coverage = computed(() =>
  machinesQuery.data.value ? reminderCoverage(machinesQuery.data.value, formatDay(new Date())) : undefined,
);

function reminderWhen(inDays: number, at: string): string {
  if (inDays <= 0) return t("fleet.inventory.list.whenToday");
  if (inDays === 1) return t("fleet.inventory.list.whenTomorrow");
  return t("fleet.inventory.list.whenDate", { date: at });
}

/**
 * One line for a rule that routes renewals: whom it reaches and what goes out
 * next. `warn` marks an enabled rule through which no reminder will go out
 * (no dated machine, every reminder off, or nothing scheduled): the fix is in
 * Inventory, so the line says so there instead of reading as healthy.
 */
function renewalLine(rule: NotifyRuleView): { text: string; warn: boolean } {
  if (!canReadInventory.value) return { text: t("platform.notifications.renewals.noAccess"), warn: false };
  const c = coverage.value;
  if (!c) {
    return {
      text: machinesQuery.error.value
        ? t("platform.notifications.renewals.failed")
        : t("platform.notifications.renewals.loading"),
      warn: false,
    };
  }
  if (c.covered === 0 && c.off > 0) return { text: t("platform.notifications.renewals.noneOn", { n: c.off }), warn: rule.enabled };
  if (c.covered === 0) return { text: t("platform.notifications.renewals.noDates"), warn: rule.enabled };
  const covers = rule.enabled ? "platform.notifications.renewals.covers" : "platform.notifications.renewals.coversDisabled";
  const parts = [t(covers, { n: c.covered }, c.covered)];
  if (c.off > 0) parts.push(t("platform.notifications.renewals.off", { n: c.off }, c.off));
  // Nothing goes out through a disabled rule, so it has no next reminder to name.
  if (!rule.enabled) return { text: parts.join(" "), warn: false };
  if (!c.next) {
    parts.push(t("platform.notifications.renewals.none"));
    return { text: parts.join(" "), warn: true };
  }
  const { machine, reminder } = c.next;
  const args = {
    when: reminderWhen(reminder.inDays, reminder.at),
    name: reminderMachineName(machine),
    offset: reminder.offset,
    renewal: reminder.renewal,
    count: c.sameDay,
  };
  if (reminder.offset < 0) {
    parts.push(t(reminder.inDays > 0 ? "platform.notifications.renewals.nextAfterDate" : "platform.notifications.renewals.nextOverdue", args));
  } else {
    parts.push(t(c.sameDay > 1 ? "platform.notifications.renewals.nextMany" : "platform.notifications.renewals.next", args));
  }
  return { text: parts.join(" "), warn: false };
}

// Nodes, for the line under each rule that routes node.offline: which delay
// each node pages after, which never page, and which carry a delay tag the
// server ignores. Read only with node:read.
const canReadNodes = computed(() => auth.can("node:read"));
const nodesQuery = useAsyncData<Node[] | undefined>(
  (signal) =>
    canReadNodes.value
      ? api.nodes.list({ signal }).then((r) => (Array.isArray(r) ? r : r.nodes ?? []))
      : Promise.resolve(undefined),
  { pollInterval: 60_000 },
);
const offlinePolicy = computed(() => (nodesQuery.data.value ? nodeOfflinePolicy(nodesQuery.data.value) : undefined));

const LIST_CAP = 8;
function capList(items: string[]): string {
  if (items.length <= LIST_CAP) return items.join(", ");
  return t("platform.notifications.offline.andMore", { list: items.slice(0, LIST_CAP).join(", "), n: items.length - LIST_CAP });
}

/**
 * One line for a rule that routes node.offline: the default delay and whom it
 * covers, the nodes that wait longer or never page, and any delay tag the
 * server will ignore (`warn`), since that node silently uses the default.
 */
function offlineLine(rule: NotifyRuleView): { text: string; warn: boolean } {
  if (!canReadNodes.value) return { text: t("platform.notifications.offline.noAccess"), warn: false };
  const policy = offlinePolicy.value;
  if (!policy) {
    return {
      text: nodesQuery.error.value ? t("platform.notifications.offline.failed") : t("platform.notifications.offline.loading"),
      warn: false,
    };
  }
  const delay = formatOfflineDelay(DEFAULT_OFFLINE_MINUTES);
  const key = rule.enabled ? "platform.notifications.offline.covers" : "platform.notifications.offline.coversDisabled";
  const parts = [t(key, { delay, n: policy.defaultCount }, policy.defaultCount)];
  if (policy.delayed.length > 0) {
    parts.push(t("platform.notifications.offline.delayed", {
      list: capList(policy.delayed.map((d) => `${d.name} (${formatOfflineDelay(d.minutes)})`)),
    }));
  }
  if (policy.quiet.length > 0) parts.push(t("platform.notifications.offline.quiet", { list: capList(policy.quiet) }));
  if (policy.invalid.length > 0) {
    parts.push(t("platform.notifications.offline.invalid", {
      delay,
      list: capList(policy.invalid.map((i) => `${i.name} (${i.tag})`)),
    }));
    return { text: parts.join(" "), warn: true };
  }
  return { text: parts.join(" "), warn: false };
}

function ruleHasDetail(rule: NotifyRuleView): boolean {
  return ruleRoutesRenewals(rule) || ruleRoutesNodeOffline(rule);
}

const sortedChannels = computed(() =>
  [...channels.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);
const sortedRules = computed(() =>
  [...rules.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

const channelColumns = computed<DataTableColumn<NotifyChannelView>[]>(() => [
  { key: "name", label: t("platform.notifications.colName"), sortable: true, searchable: true, value: (c) => c.name || c.id },
  { key: "kind", label: t("platform.notifications.colKind"), sortable: true, searchable: true },
  { key: "config_keys", label: t("platform.notifications.colConfiguredKeys") },
  { key: "enabled", label: t("platform.notifications.colStatus"), sortable: true },
  { key: "updated_at", label: t("platform.notifications.colUpdated"), sortable: true, class: "text-xs text-muted-foreground" },
  { key: "actions", label: t("platform.notifications.colActions"), align: "right" },
]);

const ruleColumns = computed<DataTableColumn<NotifyRuleView>[]>(() => [
  { key: "name", label: t("platform.notifications.colRule"), sortable: true, searchable: true, value: (r) => r.name || r.id },
  { key: "event_types", label: t("platform.notifications.colEvents") },
  { key: "channel_ids", label: t("platform.notifications.colChannels") },
  { key: "templates", label: t("platform.notifications.colTemplates") },
  { key: "enabled", label: t("platform.notifications.colStatus"), sortable: true },
  { key: "actions", label: t("platform.notifications.colActions"), align: "right" },
]);

// ── Create / edit dialog ─────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const testing = ref(false);
const editingId = ref<string | undefined>();

const formName = ref("");
const formKind = ref<NotifyKind>("telegram");
// Kind the channel was loaded with. Switching kind while editing invalidates the
// stored config, so the new kind's required fields must be entered in full.
const editingKind = ref<NotifyKind | undefined>();
const formEnabled = ref(true);
const formConfig = ref<Record<string, string>>({});
const formTitle = ref("");
const formBody = ref("");
// Keys the server holds for the channel being edited. Values never come back,
// so this is the only trace the form has of a stored level, group or url.
const storedKeys = ref<string[]>([]);
const clearAcknowledged = ref(false);

const activeFields = computed<FieldDef[]>(() => KIND_FIELDS[formKind.value]);

function resetConfigForKind(): void {
  const next: Record<string, string> = {};
  for (const field of KIND_FIELDS[formKind.value]) next[field.key] = "";
  formConfig.value = next;
}

function openCreate(): void {
  if (!canManage.value) return;
  editingId.value = undefined;
  editingKind.value = undefined;
  formName.value = "";
  formKind.value = "telegram";
  formEnabled.value = true;
  formTitle.value = "";
  formBody.value = "";
  storedKeys.value = [];
  clearAcknowledged.value = false;
  resetConfigForKind();
  formOpen.value = true;
}

function openEdit(channel: NotifyChannelView): void {
  if (!canManage.value) return;
  editingId.value = channel.id;
  formName.value = channel.name;
  formKind.value = (KIND_OPTIONS.includes(channel.kind as NotifyKind)
    ? channel.kind
    : "telegram") as NotifyKind;
  editingKind.value = formKind.value;
  formEnabled.value = channel.enabled;
  formTitle.value = "";
  formBody.value = "";
  storedKeys.value = [...(channel.config_keys ?? [])];
  clearAcknowledged.value = false;
  resetConfigForKind();
  formOpen.value = true;
}

function onKindChange(): void {
  clearAcknowledged.value = false;
  resetConfigForKind();
}

const configComplete = computed(() => configCompleteFor(activeFields.value, formConfig.value));

// Secrets are write-only: the server never returns them, so an edit starts with
// empty fields and a blank field means "leave the stored value alone". Demanding
// every secret again just to rename a channel or flip `enabled` is what made
// Save permanently unreachable on edit. Changing the kind is the exception: the
// stored config belongs to the old kind and cannot carry over.
const kindChanged = computed(() => !!editingId.value && formKind.value !== editingKind.value);
const secretsOptional = computed(() => !!editingId.value && !kindChanged.value);

// Stored optional keys the form leaves blank are replaced away on save, with
// no error to say so. The gate lists them and keeps Save out of reach until
// the operator either re-enters them or acknowledges the clear.
const saveGate = computed(() =>
  channelSaveGate({
    fields: activeFields.value,
    storedKeys: editingId.value ? storedKeys.value : [],
    config: formConfig.value,
    kindChanged: kindChanged.value,
    clearAcknowledged: clearAcknowledged.value,
  }),
);
const isStored = (key: string): boolean => !!editingId.value && !kindChanged.value && storedKeys.value.includes(key);

const canSubmit = computed(
  () => !!formName.value.trim() && (secretsOptional.value || configComplete.value) && !saveGate.value.blocked,
);

function buildConfig(): Record<string, string> {
  return buildConfigFor(activeFields.value, formConfig.value);
}

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !canManage.value) return;
  saving.value = true;
  try {
    const req: NotifyChannelUpsertRequest = {
      id: editingId.value,
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

// ── Routing rules ───────────────────────────────────────────────────────────
const ruleOpen = ref(false);
const ruleSaving = ref(false);
const ruleEditingId = ref<string | undefined>();
const ruleName = ref("");
const ruleEvents = ref("monitor.down");
const ruleChannelIds = ref<string[]>([]);
const ruleTitleTemplate = ref("");
const ruleBodyTemplate = ref("");
const ruleEnabled = ref(true);
const deleteRuleTarget = ref<NotifyRuleView | undefined>();
const deletingRule = ref(false);

function openRuleCreate(): void {
  if (!canManage.value) return;
  ruleEditingId.value = undefined;
  ruleName.value = "";
  ruleEvents.value = "monitor.down";
  ruleChannelIds.value = sortedChannels.value[0]?.id ? [sortedChannels.value[0].id] : [];
  ruleTitleTemplate.value = "";
  ruleBodyTemplate.value = "";
  ruleEnabled.value = true;
  ruleOpen.value = true;
}

function openRulePreset(preset: RulePreset): void {
  if (!canManage.value) return;
  ruleEditingId.value = undefined;
  ruleName.value = t(`platform.notifications.presets.${preset.key}`);
  ruleEvents.value = preset.events;
  ruleChannelIds.value = sortedChannels.value[0]?.id ? [sortedChannels.value[0].id] : [];
  ruleTitleTemplate.value = preset.title;
  ruleBodyTemplate.value = preset.body;
  ruleEnabled.value = true;
  ruleOpen.value = true;
}

function openRuleEdit(rule: NotifyRuleView): void {
  if (!canManage.value) return;
  ruleEditingId.value = rule.id;
  ruleName.value = rule.name;
  ruleEvents.value = (rule.event_types ?? ["*"]).join(", ");
  ruleChannelIds.value = [...(rule.channel_ids ?? [])];
  ruleTitleTemplate.value = rule.title_template ?? "";
  ruleBodyTemplate.value = rule.body_template ?? "";
  ruleEnabled.value = rule.enabled;
  ruleOpen.value = true;
}

function parseRuleEvents(input: string): string[] {
  return input
    .split(",")
    .map((event) => event.trim())
    .filter(Boolean);
}

function channelName(id: string): string {
  return sortedChannels.value.find((channel) => channel.id === id)?.name || id;
}

function toggleRuleChannel(id: string, checked: boolean): void {
  const next = ruleChannelIds.value.filter((current) => current !== id);
  ruleChannelIds.value = checked ? [...next, id] : next;
}

const canSubmitRule = computed(
  () => !!ruleName.value.trim() && parseRuleEvents(ruleEvents.value).length > 0 && ruleChannelIds.value.length > 0,
);

async function submitRule(): Promise<void> {
  if (!canSubmitRule.value || !canManage.value) return;
  ruleSaving.value = true;
  try {
    const req: NotifyRuleUpsertRequest = {
      id: ruleEditingId.value,
      name: ruleName.value.trim(),
      event_types: parseRuleEvents(ruleEvents.value),
      channel_ids: ruleChannelIds.value,
      title_template: ruleTitleTemplate.value.trim() || undefined,
      body_template: ruleBodyTemplate.value.trim() || undefined,
      enabled: ruleEnabled.value,
    };
    await api.notify.upsertRule(req);
    toast.success(ruleEditingId.value ? t("platform.notifications.ruleUpdated") : t("platform.notifications.ruleCreated"));
    ruleOpen.value = false;
    rulesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.ruleSaveFailed"));
  } finally {
    ruleSaving.value = false;
  }
}

async function confirmDeleteRule(): Promise<void> {
  if (!deleteRuleTarget.value) return;
  deletingRule.value = true;
  try {
    await api.notify.deleteRule(deleteRuleTarget.value.id);
    toast.success(t("platform.notifications.ruleDeleted"));
    deleteRuleTarget.value = undefined;
    rulesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.ruleDeleteFailed"));
  } finally {
    deletingRule.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('platform.notifications.title')" :description="$t('platform.notifications.description')">
      <template #status>
        <FreshnessLabel :last-updated="channelsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="channelsQuery.refreshing.value || rulesQuery.refreshing.value"
          @click="() => { channelsQuery.refresh(); rulesQuery.refresh(); }"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', (channelsQuery.refreshing.value || rulesQuery.refreshing.value) && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canManage" variant="outline" size="sm" @click="openRuleCreate">
          <GitBranch aria-hidden="true" class="size-4" />
          {{ $t('platform.notifications.newRule') }}
        </Button>
        <Button v-if="canManage" size="sm" @click="openCreate">
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
        <div v-if="canManage" class="mb-4 rounded-md border border-border p-3">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p class="text-sm font-medium">{{ $t('platform.notifications.presetsTitle') }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.presetsDescription') }}</p>
              <p v-if="sortedChannels.length === 0" class="text-xs text-muted-foreground">
                {{ $t('platform.notifications.presetsNeedChannel') }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button
                v-for="preset in RULE_PRESETS"
                :key="preset.key"
                variant="outline"
                size="sm"
                :disabled="sortedChannels.length === 0"
                :title="sortedChannels.length === 0 ? $t('platform.notifications.presetsNeedChannel') : undefined"
                @click="openRulePreset(preset)"
              >
                <Plus class="size-4" aria-hidden="true" />
                {{ $t(`platform.notifications.presets.${preset.key}`) }}
              </Button>
            </div>
          </div>
        </div>
        <DataTable
          state-key="channels"
          :columns="channelColumns"
          :rows="sortedChannels"
          :row-key="(channel) => channel.id"
          :loading="channelsQuery.loading.value"
          :error="channelsQuery.error.value"
          :has-data="channelsQuery.data.value !== undefined"
          :page-size="50"
          searchable
          :search-placeholder="$t('platform.shared.searchNames')"
          :empty-title="$t('platform.notifications.emptyTitle')"
          :empty-description="$t('platform.notifications.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="channelsQuery.refresh"
        >
          <template #cell-name="{ row }">
            <div class="font-medium">{{ row.name || row.id }}</div>
          </template>
          <template #cell-kind="{ row }">
            <Badge :variant="kindBadgeVariant(row.kind)">{{ row.kind }}</Badge>
          </template>
          <template #cell-config_keys="{ row }">
            <div class="flex flex-wrap gap-1">
              <Badge
                v-for="key in row.config_keys"
                :key="key"
                variant="outline"
                class="font-mono text-[10px]"
              >
                {{ key }}
              </Badge>
              <span v-if="row.config_keys.length === 0" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
            </div>
          </template>
          <template #cell-enabled="{ row }">
            <Badge :variant="row.enabled ? 'success' : 'secondary'">
              {{ row.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
            </Badge>
          </template>
          <template #cell-updated_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-1">
              <Button
                v-if="canManage"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('platform.notifications.editChannelAria')"
                @click="openEdit(row)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canManage"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('platform.notifications.deleteChannelAria')"
                @click="deleteTarget = row"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <GitBranch aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.notifications.rulesTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('platform.notifications.rulesDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          state-key="rules"
          :columns="ruleColumns"
          :rows="sortedRules"
          :row-key="(rule) => rule.id"
          :loading="rulesQuery.loading.value"
          :error="rulesQuery.error.value"
          :has-data="rulesQuery.data.value !== undefined"
          :row-expanded="ruleHasDetail"
          :page-size="50"
          searchable
          :search-placeholder="$t('platform.shared.searchNames')"
          :empty-title="$t('platform.notifications.rulesEmptyTitle')"
          :empty-description="$t('platform.notifications.rulesEmptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="rulesQuery.refresh"
        >
          <template #cell-name="{ row }">
            <div class="font-medium">{{ row.name || row.id }}</div>
            <div class="mt-1 font-mono text-xs text-muted-foreground">{{ row.id }}</div>
          </template>
          <template #row-detail="{ row }">
            <p
              v-if="ruleRoutesRenewals(row)"
              :class="cn('flex items-start gap-2 text-xs', renewalLine(row).warn ? 'text-warning-text' : 'text-muted-foreground')"
              data-testid="renewal-coverage"
            >
              <TriangleAlert v-if="renewalLine(row).warn" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <CalendarClock v-else class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {{ renewalLine(row).text }}
                <RouterLink
                  v-if="renewalLine(row).warn"
                  :to="{ name: 'inventory', query: { group: 'renewal' } }"
                  class="rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >{{ $t('platform.notifications.renewals.openInventory') }}</RouterLink>
              </span>
            </p>
            <p
              v-if="ruleRoutesNodeOffline(row)"
              :class="cn('flex items-start gap-2 text-xs', offlineLine(row).warn ? 'text-warning-text' : 'text-muted-foreground', ruleRoutesRenewals(row) && 'mt-1.5')"
              data-testid="offline-coverage"
            >
              <TriangleAlert v-if="offlineLine(row).warn" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <Unplug v-else class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{{ offlineLine(row).text }}</span>
            </p>
          </template>
          <template #cell-event_types="{ row }">
            <div class="flex flex-wrap gap-1">
              <Badge v-for="event in (row.event_types ?? [])" :key="event" variant="outline" class="font-mono text-[10px]">{{ event }}</Badge>
            </div>
          </template>
          <template #cell-channel_ids="{ row }">
            <div class="flex flex-wrap gap-1">
              <Badge v-for="id in (row.channel_ids ?? [])" :key="id" variant="secondary">{{ channelName(id) }}</Badge>
            </div>
          </template>
          <template #cell-templates="{ row }">
            <div class="text-xs text-muted-foreground">
              <div>{{ row.title_template || $t('platform.notifications.defaultTitleTemplate') }}</div>
              <div>{{ row.body_template || $t('platform.notifications.defaultBodyTemplate') }}</div>
            </div>
          </template>
          <template #cell-enabled="{ row }">
            <Badge :variant="row.enabled ? 'success' : 'secondary'">
              {{ row.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
            </Badge>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-1">
              <Button
                v-if="canManage"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('platform.notifications.editRuleAria')"
                @click="openRuleEdit(row)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canManage"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('platform.notifications.deleteRuleAria')"
                @click="deleteRuleTarget = row"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
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
                <span v-if="field.required && !secretsOptional" class="text-destructive">*</span>
                <span v-else-if="field.required" class="text-xs font-normal text-muted-foreground">
                  ({{ $t('common.misc.keepBlank') }})
                </span>
                <span v-else-if="isStored(field.key)" class="text-xs font-normal text-warning">
                  ({{ $t('platform.notifications.storedOptionalHint') }})
                </span>
                <span v-else class="text-xs font-normal text-muted-foreground">
                  ({{ $t('common.misc.optional') }})
                </span>
              </Label>
              <Select
                v-if="field.options"
                :model-value="toSelectValue(formConfig[field.key] ?? '')"
                @update:model-value="(value) => (formConfig[field.key] = fromSelectValue(String(value ?? '')))"
              >
                <SelectTrigger :id="`cfg-${field.key}`">
                  <SelectValue :placeholder="isStored(field.key) ? $t('platform.notifications.storedPlaceholder') : $t(field.placeholder)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="SELECT_DEFAULT">{{ $t(field.placeholder) }}</SelectItem>
                  <SelectItem v-for="option in field.options" :key="option" :value="option">
                    {{ option }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                v-else
                :id="`cfg-${field.key}`"
                v-model="formConfig[field.key]"
                :placeholder="isStored(field.key) && !field.required
                  ? $t('platform.notifications.storedPlaceholder')
                  : secretsOptional && field.required
                    ? $t('common.misc.keepBlank')
                    : (field.placeholder.startsWith('platform.') ? $t(field.placeholder) : field.placeholder)"
                autocomplete="off"
              />
              <p v-if="field.hint" class="text-xs text-muted-foreground">{{ $t(field.hint) }}</p>
            </div>
            <p v-if="kindChanged" class="text-xs text-warning">
              {{ $t('platform.notifications.kindChangedHint') }}
            </p>
            <p v-else-if="editingId" class="text-xs text-muted-foreground">
              {{ $t('platform.notifications.replaceConfigHint') }}
            </p>
            <label
              v-if="saveGate.dropped.length > 0"
              class="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
            >
              <Checkbox v-model="clearAcknowledged" class="mt-0.5" />
              <span>{{ $t('platform.notifications.clearStoredLabel', { keys: saveGate.dropped.join(', ') }) }}</span>
            </label>
          </div>

          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox v-model="formEnabled" />
            <span>{{ $t('platform.notifications.enabledLabel') }}</span>
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
              :disabled="testing || !configComplete || !canSend"
              :title="!canSend ? $t('platform.notifications.sendScopeMissing') : undefined"
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

    <!-- Rule dialog -->
    <Dialog v-model:open="ruleOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ ruleEditingId ? $t('platform.notifications.editRuleTitle') : $t('platform.notifications.newRuleTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.notifications.ruleFormHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitRule">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="rule-name">{{ $t('platform.notifications.ruleNameLabel') }}</Label>
              <Input id="rule-name" v-model="ruleName" required placeholder="critical-monitor-alerts" />
            </div>
            <div class="grid gap-2">
              <Label for="rule-events">{{ $t('platform.notifications.ruleEventsLabel') }}</Label>
              <Input id="rule-events" v-model="ruleEvents" required placeholder="monitor.down, monitor.recovered" />
            </div>
          </div>

          <div class="space-y-2 rounded-md border border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.availableEvents') }}</p>
            <div class="flex flex-wrap gap-1">
              <Badge v-for="event in EVENT_OPTIONS" :key="event" variant="outline" class="font-mono text-[10px]">{{ event }}</Badge>
            </div>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.ruleEventsHint') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.nodeOfflineHint') }}</p>
          </div>

          <div class="space-y-2 rounded-md border border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.ruleChannelsLabel') }}</p>
            <div v-if="sortedChannels.length > 0" class="grid gap-2 sm:grid-cols-2">
              <label
                v-for="channel in sortedChannels"
                :key="channel.id"
                class="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <Checkbox
                  :model-value="ruleChannelIds.includes(channel.id)"
                  @update:model-value="(v) => toggleRuleChannel(channel.id, v === true)"
                />
                <span class="min-w-0">
                  <span class="block truncate font-medium" :title="channel.name || channel.id">{{ channel.name || channel.id }}</span>
                  <span
                    class="block truncate text-xs text-muted-foreground"
                    :title="`${channel.kind} · ${channel.id}`"
                  >{{ channel.kind }} · {{ channel.id }}</span>
                </span>
              </label>
            </div>
            <p v-else class="text-sm text-muted-foreground">{{ $t('platform.notifications.createChannelFirst') }}</p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="rule-title-template">{{ $t('platform.notifications.titleTemplateLabel') }}</Label>
              <Input id="rule-title-template" v-model="ruleTitleTemplate" placeholder="[{{event_type}}] {{title}}" />
            </div>
            <div class="grid gap-2">
              <Label for="rule-body-template">{{ $t('platform.notifications.bodyTemplateLabel') }}</Label>
              <Input id="rule-body-template" v-model="ruleBodyTemplate" placeholder="{{body}}" />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.templateVarsHint') }}</p>

          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox v-model="ruleEnabled" />
            <span>{{ $t('platform.notifications.ruleEnabledLabel') }}</span>
          </label>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="ruleSaving || !canSubmitRule">
              <RefreshCw v-if="ruleSaving" aria-hidden="true" class="size-4 animate-spin" />
              <GitBranch v-else aria-hidden="true" class="size-4" />
              {{ ruleEditingId ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('platform.notifications.deleteChannelTitle')"
      :description="$t('platform.notifications.deleteChannelConfirm', { name: deleteTarget?.name || deleteTarget?.id })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Delete rule confirmation -->
    <ConfirmDialog
      :open="!!deleteRuleTarget"
      :title="$t('platform.notifications.deleteRuleTitle')"
      :description="$t('platform.notifications.deleteRuleConfirm', { name: deleteRuleTarget?.name || deleteRuleTarget?.id })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletingRule"
      @update:open="(v) => { if (!v) deleteRuleTarget = undefined; }"
      @confirm="confirmDeleteRule"
    />
  </div>
</template>
