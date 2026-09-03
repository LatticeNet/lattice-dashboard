<script setup lang="ts">
/**
 * Inbound webhooks.
 *
 * A webhook is one half of a contract with somebody who is not looking at this
 * console. The operator writes the event type and the message; a script
 * somewhere else supplies the fields. Neither side can see the other, so the
 * page's job is to make both halves visible in one place: the URL and the exact
 * request to send, the data fields the templates ask for, and whether anything
 * downstream is actually listening.
 *
 * That last part is why the routing notice exists. A fleet with no channel and
 * no rule accepts every webhook and delivers none of them, and "202 Accepted"
 * is a convincing thing to see while nothing reaches a phone.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { onBeforeRouteLeave } from "vue-router";
import {
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook,
} from "lucide-vue-next";
import {
  api,
  type NotifyWebhookSecretResponse,
  type NotifyWebhookUpsertRequest,
  type NotifyWebhookView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime } from "@/lib/format";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  curlExample,
  eventTypeError,
  healthTone,
  outcomeTone,
  parseFieldLines,
  requiredDataFields,
  placeholderLabel,
  unknownTemplateVars,
  webhookHealth,
  webhookUrl,
  PLATFORM_TEMPLATE_VARS,
  WEBHOOK_LIMITS,
} from "./webhooksModel";

const { t } = useI18n();
const auth = useAuthStore();
const canSend = computed(() => auth.can("notify:send"));

const webhooksQuery = useAsyncData((signal) => api.notify.webhooks({ signal }), {
  pollInterval: 15000,
});
const webhooks = computed(() => webhooksQuery.data.value?.webhooks ?? []);

// Channels and rules are read only to answer one question: would anything
// receive this. The page does not manage them; Notifications does.
const channelsQuery = useAsyncData((signal) => api.notify.channels({ signal }), {
  pollInterval: 60000,
});
const rulesQuery = useAsyncData((signal) => api.notify.rules({ signal }), {
  pollInterval: 60000,
});
const enabledChannels = computed(() => (channelsQuery.data.value ?? []).filter((c) => c.enabled));
const enabledRules = computed(() => (rulesQuery.data.value?.rules ?? []).filter((r) => r.enabled));

const selectedId = ref<string | undefined>();
const selected = computed(() => webhooks.value.find((h) => h.id === selectedId.value));

// Select the first webhook once the list arrives, so the detail pane is not an
// empty box on a page that has content.
watch(webhooks, (list) => {
  if (!selectedId.value && list.length) selectedId.value = list[0]?.id;
  if (selectedId.value && !list.some((h) => h.id === selectedId.value)) {
    selectedId.value = list[0]?.id;
  }
});

const deliveriesQuery = useAsyncData(
  (signal) =>
    selectedId.value
      ? api.notify.webhookDeliveries(selectedId.value, { signal })
      : Promise.resolve({ deliveries: [] }),
  { pollInterval: 10000 },
);
const deliveries = computed(() => deliveriesQuery.data.value?.deliveries ?? []);
watch(selectedId, () => deliveriesQuery.refresh());

const origin = computed(() => (typeof window === "undefined" ? "" : window.location.origin));
const selectedUrl = computed(() => (selected.value ? webhookUrl(origin.value, selected.value.path) : ""));
const selectedFields = computed(() => (selected.value ? requiredDataFields(selected.value) : []));
const selectedCurl = computed(() => (selected.value ? curlExample(origin.value, selected.value) : ""));

/**
 * The routing notice. Three distinct states, because the fix differs: no
 * channel at all, channels but no rule matching this webhook's event type, or
 * fine. A rule with no event types matches everything, which is the fallback
 * broadcast the dispatcher already implements.
 */
const routingState = computed<"no-channel" | "no-rule" | "ok">(() => {
  if (!enabledChannels.value.length) return "no-channel";
  if (!enabledRules.value.length) return "ok";
  const event = selected.value?.event_type;
  if (!event) return "ok";
  const matches = enabledRules.value.some(
    (r) => !r.event_types?.length || r.event_types.includes("*") || r.event_types.includes(event),
  );
  return matches ? "ok" : "no-rule";
});

const columns = computed<DataTableColumn<NotifyWebhookView>[]>(() => [
  { key: "name", label: t("platform.webhooks.colName"), sortable: true, searchable: true },
  { key: "event_type", label: t("platform.webhooks.colEvent"), sortable: true, searchable: true },
  { key: "enabled", label: t("platform.webhooks.colState"), align: "left" },
  { key: "last_used_at", label: t("platform.webhooks.colLastCalled"), sortable: true },
]);

const health = computed(() => webhookHealth(deliveries.value));

// ---- Create and edit ----------------------------------------------------

const formOpen = ref(false);
const editingId = ref<string | undefined>();
const formName = ref("");
const formEvent = ref("");
const formTitle = ref("");
const formBody = ref("");
const formEnabled = ref(true);
const saving = ref(false);

// Composed here, not written inline: a literal "{{" in a Vue template is a
// nested mustache to the parser and fails the build.
const titlePlaceholder = `Backup of ${placeholderLabel("data.host")}`;
const bodyPlaceholder = placeholderLabel("data.detail");

const formEventError = computed(() => eventTypeError(formEvent.value));
const formUnknownVars = computed(() => unknownTemplateVars(formTitle.value, formBody.value));
const formFields = computed(() =>
  requiredDataFields({ title_template: formTitle.value, body_template: formBody.value }),
);
const canSubmit = computed(
  () => !!formName.value.trim() && !formEventError.value && !!formTitle.value.trim() && !saving.value,
);

/**
 * Once the create request is in flight the webhook is created whatever the
 * operator does next, so every path that would close this dialog is refused
 * until it settles. Otherwise Cancel dismisses the form, the request lands
 * anyway, and the reveal-once dialog appears on top of whatever they moved on
 * to, for something they believe they cancelled.
 */
function onFormOpenChange(next: boolean): void {
  if (!next && saving.value) return;
  formOpen.value = next;
}

function openCreate(): void {
  if (!canSend.value) return;
  editingId.value = undefined;
  formName.value = "";
  formEvent.value = "";
  formTitle.value = "";
  formBody.value = "";
  formEnabled.value = true;
  formOpen.value = true;
}

function openEdit(hook: NotifyWebhookView): void {
  if (!canSend.value) return;
  editingId.value = hook.id;
  formName.value = hook.name;
  formEvent.value = hook.event_type;
  formTitle.value = hook.title_template;
  formBody.value = hook.body_template ?? "";
  formEnabled.value = hook.enabled;
  formOpen.value = true;
}

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !canSend.value) return;
  saving.value = true;
  try {
    const req: NotifyWebhookUpsertRequest = {
      id: editingId.value,
      name: formName.value.trim(),
      event_type: formEvent.value.trim().toLowerCase(),
      title_template: formTitle.value.trim(),
      body_template: formBody.value.trim(),
      enabled: formEnabled.value,
    };
    const result = await api.notify.upsertWebhook(req);
    formOpen.value = false;
    webhooksQuery.refresh();
    if (editingId.value) {
      toast.success(t("platform.webhooks.updated"));
    } else {
      selectedId.value = result.id;
      // Creation is the only moment the plaintext secret exists. Everything
      // else can wait for the poll; this cannot.
      revealed.value = result;
      revealAcknowledged.value = false;
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.webhooks.saveFailed"));
  } finally {
    saving.value = false;
  }
}

// ---- Reveal once --------------------------------------------------------

/**
 * The server stores a PBKDF2 hash, so this is the only copy of the secret that
 * will ever exist. Dismissing the dialog destroys it, which is why escape,
 * overlay clicks and navigation are all refused until the operator ticks the
 * acknowledgement. Same contract as an access token.
 */
const revealed = ref<NotifyWebhookSecretResponse | undefined>();
const revealAcknowledged = ref(false);

const revealedCurl = computed(() =>
  revealed.value ? curlExample(origin.value, revealed.value, revealed.value.secret) : "",
);

onBeforeRouteLeave(() => {
  if (!revealed.value || revealAcknowledged.value) return true;
  toast.warning(t("platform.webhooks.reveal.blockedNavigation"));
  return false;
});

function onRevealOpenChange(next: boolean): void {
  if (next || !revealAcknowledged.value) return;
  closeReveal();
}

function closeReveal(): void {
  revealed.value = undefined;
  revealAcknowledged.value = false;
}

// ---- Rotate and delete --------------------------------------------------

const rotateTarget = ref<NotifyWebhookView | undefined>();
const deleteTarget = ref<NotifyWebhookView | undefined>();
const confirmText = ref("");
const confirmError = ref(false);
const pending = ref(false);

const confirmTarget = computed(() => rotateTarget.value ?? deleteTarget.value);
const confirmMatches = computed(
  () => !!confirmTarget.value && confirmText.value.trim() === confirmTarget.value.name,
);

function openRotate(hook: NotifyWebhookView): void {
  if (!canSend.value) return;
  rotateTarget.value = hook;
  confirmText.value = "";
  confirmError.value = false;
}

function openDelete(hook: NotifyWebhookView): void {
  if (!canSend.value) return;
  deleteTarget.value = hook;
  confirmText.value = "";
  confirmError.value = false;
}

// The mismatch message must clear itself the moment the operator types the right
// name; leaving it up until the next click reads as though the correct name is
// also wrong.
watch(confirmText, () => {
  if (confirmMatches.value) confirmError.value = false;
});

function closeConfirm(): void {
  rotateTarget.value = undefined;
  deleteTarget.value = undefined;
  confirmText.value = "";
  confirmError.value = false;
}

/** Answer the click rather than doing nothing when the typed name does not match. */
function runConfirm(): void {
  if (!confirmMatches.value) {
    confirmError.value = true;
    return;
  }
  if (rotateTarget.value) void doRotate();
  else void doDelete();
}

async function doRotate(): Promise<void> {
  if (!canSend.value) return;
  const target = rotateTarget.value;
  if (!target) return;
  pending.value = true;
  try {
    const result = await api.notify.rotateWebhookSecret(target.id);
    closeConfirm();
    webhooksQuery.refresh();
    revealed.value = result;
    revealAcknowledged.value = false;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.webhooks.rotateFailed"));
  } finally {
    pending.value = false;
  }
}

async function doDelete(): Promise<void> {
  if (!canSend.value) return;
  const target = deleteTarget.value;
  if (!target) return;
  pending.value = true;
  try {
    await api.notify.deleteWebhook(target.id);
    toast.success(t("platform.webhooks.deleted"));
    closeConfirm();
    webhooksQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.webhooks.deleteFailed"));
  } finally {
    pending.value = false;
  }
}

// ---- Test fire ----------------------------------------------------------

const testOpen = ref(false);
const testInput = ref("");
const testing = ref(false);

const testParsed = computed(() => parseFieldLines(testInput.value));

function openTest(): void {
  if (!canSend.value) return;
  if (!selected.value) return;
  // Prefill the fields the templates ask for, so the operator fills in values
  // rather than guessing the field names back out of the template.
  testInput.value = selectedFields.value.map((f) => `${f}=`).join("\n");
  testOpen.value = true;
}

async function runTest(): Promise<void> {
  if (!canSend.value) return;
  if (!selected.value || testParsed.value.error) return;
  testing.value = true;
  try {
    const result = await api.notify.testWebhook(selected.value.id, testParsed.value.data);
    testOpen.value = false;
    deliveriesQuery.refresh();
    webhooksQuery.refresh();
    if (result.outcome === "no_route") {
      toast.warning(t("platform.webhooks.testNoRoute"));
    } else {
      toast.success(t("platform.webhooks.testSent", { channels: result.channels }));
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.webhooks.testFailed"));
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="space-y-6 p-6">
    <PageHeader
      :title="$t('platform.webhooks.title')"
      :description="$t('platform.webhooks.description')"
      :section="$t('platform.webhooks.section')"
    >
      <template #status>
        <FreshnessLabel :last-updated="webhooksQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" @click="webhooksQuery.refresh()">
          <RefreshCw class="size-4" />
          {{ $t("common.actions.refresh") }}
        </Button>
        <Button v-if="canSend" size="sm" @click="openCreate">
          <Plus class="size-4" />
          {{ $t("platform.webhooks.newWebhook") }}
        </Button>
      </template>
    </PageHeader>

    <!--
      A webhook that fires into a fleet with no channel returns 202 and reaches
      nobody. Saying so here is the difference between a working integration and
      one that looks like it works.
    -->
    <div
      v-if="routingState !== 'ok' && webhooks.length"
      class="flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4"
    >
      <Webhook class="mt-0.5 size-4 shrink-0 text-warning" />
      <div class="min-w-0 flex-1 space-y-1">
        <p class="text-sm font-medium text-foreground">
          {{
            routingState === "no-channel"
              ? $t("platform.webhooks.noChannelTitle")
              : $t("platform.webhooks.noRuleTitle")
          }}
        </p>
        <p class="text-sm text-muted-foreground">
          {{
            routingState === "no-channel"
              ? $t("platform.webhooks.noChannelDetail")
              : $t("platform.webhooks.noRuleDetail", { event: selected?.event_type ?? "" })
          }}
        </p>
      </div>
      <Button variant="outline" size="sm" as-child>
        <RouterLink to="/platform/notifications">
          {{ $t("platform.webhooks.openNotifications") }}
        </RouterLink>
      </Button>
    </div>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
      <DataTable
        class="min-w-0"
        state-key="webhooks"
        :columns="columns"
        :rows="webhooks"
        :row-key="(hook: NotifyWebhookView) => hook.id"
        :loading="webhooksQuery.loading.value"
        :error="webhooksQuery.error.value"
        :has-data="webhooksQuery.data.value !== undefined"
        :page-size="25"
        searchable
        :search-placeholder="$t('platform.shared.searchNames')"
        :empty-title="$t('platform.webhooks.emptyTitle')"
        :empty-description="$t('platform.webhooks.emptyDescription')"
        :no-match-title="$t('platform.shared.noMatchesTitle')"
        :no-match-description="$t('platform.shared.noMatchesDescription')"
        @row-select="(hook: NotifyWebhookView) => (selectedId = hook.id)"
        @retry="webhooksQuery.refresh"
      >
        <template #empty>
          <EmptyState
            :icon="Webhook"
            :title="$t('platform.webhooks.emptyTitle')"
            :description="$t('platform.webhooks.emptyDescription')"
            :steps="[
              { title: $t('platform.webhooks.step1Title'), detail: $t('platform.webhooks.step1Detail') },
              { title: $t('platform.webhooks.step2Title'), detail: $t('platform.webhooks.step2Detail') },
              { title: $t('platform.webhooks.step3Title'), detail: $t('platform.webhooks.step3Detail') },
            ]"
          >
            <Button v-if="canSend" size="sm" @click="openCreate">
              <Plus class="size-4" />
              {{ $t("platform.webhooks.newWebhook") }}
            </Button>
          </EmptyState>
        </template>

        <template #cell-name="{ row }">
          <span class="font-medium">{{ row.name }}</span>
        </template>
        <template #cell-event_type="{ row }">
          <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{{ row.event_type }}</code>
        </template>
        <template #cell-enabled="{ row }">
          <Badge :variant="row.enabled ? 'success' : 'secondary'">
            {{ row.enabled ? $t("platform.webhooks.enabled") : $t("platform.webhooks.disabled") }}
          </Badge>
        </template>
        <template #cell-last_used_at="{ row }">
          <span class="text-muted-foreground tabular">
            {{ row.last_used_at ? formatRelativeTime(row.last_used_at) : $t("platform.webhooks.never") }}
          </span>
        </template>
      </DataTable>

      <!--
        min-w-0: a grid item's default min-width is auto, so without it the
        preformatted request block below sets this column's floor at its own
        intrinsic width and the page scrolls sideways at 375 instead of the
        block scrolling inside itself.
      -->
      <div class="min-w-0 space-y-4">
        <div
          v-if="!selected"
          class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground"
        >
          {{ $t("platform.webhooks.selectPrompt") }}
        </div>

        <div v-else class="space-y-4 rounded-lg border border-border bg-card p-4">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="truncate text-sm font-semibold text-foreground">{{ selected.name }}</h3>
              <p class="text-xs text-muted-foreground">
                {{ $t("platform.webhooks.createdAt", { at: formatDateTime(selected.created_at) }) }}
              </p>
            </div>
            <Badge :variant="healthTone(health)">{{ $t(`platform.webhooks.health.${health}`) }}</Badge>
          </div>

          <!-- The endpoint. -->
          <div class="space-y-1.5">
            <p class="text-xs font-medium text-muted-foreground">{{ $t("platform.webhooks.endpoint") }}</p>
            <div class="flex items-start gap-2">
              <code class="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">{{
                selectedUrl
              }}</code>
              <CopyButton :value="selectedUrl" />
            </div>
            <p class="text-xs text-muted-foreground">{{ $t("platform.webhooks.urlIsNotSecret") }}</p>
          </div>

          <!-- The caller's half of the contract. -->
          <div class="space-y-1.5">
            <p class="text-xs font-medium text-muted-foreground">
              {{ $t("platform.webhooks.callerFields") }}
            </p>
            <div v-if="selectedFields.length" class="flex flex-wrap gap-1.5">
              <Badge v-for="field in selectedFields" :key="field" variant="outline" class="font-mono">
                {{ field }}
              </Badge>
            </div>
            <p v-else class="text-xs text-muted-foreground">{{ $t("platform.webhooks.noFields") }}</p>
            <p class="text-xs text-muted-foreground">
              {{
                $t("platform.webhooks.fieldLimits", {
                  fields: WEBHOOK_LIMITS.maxFields,
                  chars: WEBHOOK_LIMITS.maxValueChars,
                  bytes: WEBHOOK_LIMITS.maxBodyBytes,
                })
              }}
            </p>
          </div>

          <!-- The request to send. -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-medium text-muted-foreground">{{ $t("platform.webhooks.example") }}</p>
              <CopyButton :value="selectedCurl" :label="$t('common.actions.copy')" />
            </div>
            <pre
              class="overflow-x-auto rounded bg-muted p-2.5 font-mono text-xs leading-relaxed"
            ><code>{{ selectedCurl }}</code></pre>
          </div>

          <div v-if="canSend" class="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button variant="outline" size="sm" @click="openTest">
              <Send class="size-4" />
              {{ $t("platform.webhooks.sendTest") }}
            </Button>
            <Button variant="outline" size="sm" @click="openEdit(selected)">
              <Pencil class="size-4" />
              {{ $t("common.actions.edit") }}
            </Button>
            <Button variant="outline" size="sm" @click="openRotate(selected)">
              <KeyRound class="size-4" />
              {{ $t("platform.webhooks.rotate") }}
            </Button>
            <Button variant="outline" size="sm" @click="openDelete(selected)">
              <Trash2 class="size-4" />
              {{ $t("common.actions.delete") }}
            </Button>
          </div>
        </div>

        <!-- Recent attempts. -->
        <div v-if="selected" class="rounded-lg border border-border bg-card">
          <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h3 class="text-sm font-semibold text-foreground">{{ $t("platform.webhooks.deliveries") }}</h3>
            <FreshnessLabel :last-updated="deliveriesQuery.lastUpdated.value" />
          </div>
          <p
            v-if="!deliveries.length"
            class="px-4 py-6 text-center text-sm text-muted-foreground"
          >
            {{ $t("platform.webhooks.noDeliveries") }}
          </p>
          <ul v-else class="divide-y divide-border">
            <li v-for="d in deliveries" :key="d.id" class="space-y-1 px-4 py-3">
              <div class="flex flex-wrap items-center gap-2">
                <Badge :variant="outcomeTone(d.outcome)">{{
                  $t(`platform.webhooks.outcome.${d.outcome}`)
                }}</Badge>
                <Badge v-if="d.test" variant="outline">{{ $t("platform.webhooks.testBadge") }}</Badge>
                <span class="text-xs text-muted-foreground tabular">{{ formatDateTime(d.created_at) }}</span>
              </div>
              <p v-if="d.title" class="truncate text-sm text-foreground">{{ d.title }}</p>
              <p v-if="d.reason" class="text-xs text-muted-foreground">{{ d.reason }}</p>
              <p class="text-xs text-muted-foreground tabular">
                {{
                  $t("platform.webhooks.deliveryMeta", {
                    delivered: d.delivered,
                    channels: d.channels,
                    fields: d.fields,
                    ip: d.source_ip || "-",
                  })
                }}
              </p>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Create and edit. -->
    <Dialog :open="formOpen" @update:open="onFormOpenChange">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{
            editingId ? $t("platform.webhooks.editTitle") : $t("platform.webhooks.createTitle")
          }}</DialogTitle>
          <DialogDescription>{{ $t("platform.webhooks.formDescription") }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="space-y-1.5">
            <Label for="wh-name">{{ $t("platform.webhooks.fieldName") }}</Label>
            <Input id="wh-name" v-model="formName" :placeholder="$t('platform.webhooks.namePlaceholder')" />
          </div>

          <div class="space-y-1.5">
            <Label for="wh-event">{{ $t("platform.webhooks.fieldEvent") }}</Label>
            <Input
              id="wh-event"
              v-model="formEvent"
              class="font-mono"
              placeholder="backup.finished"
              :aria-invalid="!!formEventError || undefined"
            />
            <p v-if="formEventError" class="text-xs text-destructive">
              {{ $t(`platform.webhooks.eventError.${formEventError}`) }}
            </p>
            <p v-else class="text-xs text-muted-foreground">{{ $t("platform.webhooks.eventHint") }}</p>
          </div>

          <div class="space-y-1.5">
            <Label for="wh-title">{{ $t("platform.webhooks.fieldTitleTemplate") }}</Label>
            <Input id="wh-title" v-model="formTitle" class="font-mono" :placeholder="titlePlaceholder" />
          </div>

          <div class="space-y-1.5">
            <Label for="wh-body">{{ $t("platform.webhooks.fieldBodyTemplate") }}</Label>
            <Textarea
              id="wh-body"
              v-model="formBody"
              class="font-mono"
              rows="3"
              :placeholder="bodyPlaceholder"
            />
          </div>

          <div class="space-y-2 rounded-md border border-border bg-muted/40 p-3">
            <p class="text-xs font-medium text-foreground">{{ $t("platform.webhooks.varsTitle") }}</p>
            <p class="text-xs text-muted-foreground">{{ $t("platform.webhooks.varsHelp") }}</p>
            <div class="flex flex-wrap gap-1.5">
              <Badge v-for="v in PLATFORM_TEMPLATE_VARS" :key="v" variant="secondary" class="font-mono">
                {{ placeholderLabel(v) }}
              </Badge>
            </div>
            <div v-if="formFields.length" class="space-y-1">
              <p class="text-xs text-muted-foreground">{{ $t("platform.webhooks.varsCaller") }}</p>
              <div class="flex flex-wrap gap-1.5">
                <Badge v-for="f in formFields" :key="f" variant="outline" class="font-mono">{{ f }}</Badge>
              </div>
            </div>
            <p v-if="formUnknownVars.length" class="text-xs text-warning">
              {{ $t("platform.webhooks.varsUnknown", { vars: formUnknownVars.join(", ") }) }}
            </p>
          </div>

          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox v-model="formEnabled" class="mt-0.5" />
            <span>
              {{ $t("platform.webhooks.fieldEnabled") }}
              <span class="block text-xs text-muted-foreground">{{
                $t("platform.webhooks.enabledHint")
              }}</span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" type="button" :disabled="saving" @click="onFormOpenChange(false)">
            {{ $t("common.actions.cancel") }}
          </Button>
          <Button type="button" :disabled="!canSubmit" @click="submitForm">
            {{ editingId ? $t("common.actions.save") : $t("platform.webhooks.createAction") }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!--
      Reveal once. The server keeps only a hash, so dismissing this destroys the
      only copy; every dismissal path stays shut until the box is ticked.
    -->
    <Dialog :open="!!revealed" @update:open="onRevealOpenChange">
      <DialogContent class="sm:max-w-xl" @escape-key-down.prevent @interact-outside.prevent>
        <DialogHeader>
          <DialogTitle>{{ $t("platform.webhooks.reveal.title") }}</DialogTitle>
          <DialogDescription>{{ $t("platform.webhooks.reveal.description") }}</DialogDescription>
        </DialogHeader>

        <div class="min-w-0 space-y-2 rounded-md border border-warning/40 bg-warning/5 p-4">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium text-foreground">{{ $t("platform.webhooks.reveal.secret") }}</p>
            <CopyButton v-if="revealed" :value="revealed.secret" :label="$t('common.actions.copy')" />
          </div>
          <code class="block break-all font-mono text-xs text-foreground">{{ revealed?.secret }}</code>
        </div>

        <!--
          min-w-0: DialogContent lays its children out in a grid, whose items
          take their minimum width from their content. The request block below
          holds one long unbroken line, so without this the grid track grows
          past the panel and the copy buttons render outside it.
        -->
        <div class="min-w-0 space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t("platform.webhooks.example") }}</p>
            <CopyButton :value="revealedCurl" :label="$t('common.actions.copy')" />
          </div>
          <pre
            class="overflow-x-auto rounded bg-muted p-2.5 font-mono text-xs leading-relaxed"
          ><code>{{ revealedCurl }}</code></pre>
        </div>

        <label class="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 p-3 text-sm">
          <Checkbox v-model="revealAcknowledged" class="mt-0.5" />
          <span>{{ $t("platform.webhooks.reveal.acknowledge") }}</span>
        </label>

        <DialogFooter>
          <Button type="button" :disabled="!revealAcknowledged" @click="closeReveal">
            {{ $t("common.actions.done") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Test fire. -->
    <Dialog v-model:open="testOpen">
      <DialogScrollContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t("platform.webhooks.test.title") }}</DialogTitle>
          <DialogDescription>{{ $t("platform.webhooks.test.description") }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-1.5">
          <Label for="wh-test">{{ $t("platform.webhooks.test.fields") }}</Label>
          <Textarea id="wh-test" v-model="testInput" class="font-mono" rows="5" placeholder="host=edge-1" />
          <p v-if="testParsed.error" class="text-xs text-destructive">
            {{ $t(`platform.webhooks.test.error.${testParsed.error}`) }}
          </p>
          <p v-else class="text-xs text-muted-foreground">{{ $t("platform.webhooks.test.hint") }}</p>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button variant="outline" type="button">{{ $t("common.actions.cancel") }}</Button>
          </DialogClose>
          <Button type="button" :disabled="!!testParsed.error || testing" @click="runTest">
            <Send class="size-4" />
            {{ $t("platform.webhooks.sendTest") }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!--
      Rotate and delete share one dialog. Both invalidate a URL somebody else is
      calling, so both are type-to-confirm rather than one click.
    -->
    <ConfirmDialog
      :open="!!confirmTarget"
      :title="rotateTarget ? $t('platform.webhooks.rotateTitle') : $t('platform.webhooks.deleteTitle')"
      :description="
        rotateTarget
          ? $t('platform.webhooks.rotateConfirm', { name: rotateTarget.name })
          : $t('platform.webhooks.deleteConfirm', { name: deleteTarget?.name })
      "
      :confirm-label="rotateTarget ? $t('platform.webhooks.rotate') : $t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="pending"
      :confirm-disabled="!confirmMatches"
      @update:open="(v: boolean) => { if (!v) closeConfirm(); }"
      @confirm="runConfirm"
    >
      <div class="space-y-1.5">
        <Label for="wh-confirm">{{
          $t("platform.webhooks.typeToConfirm", { name: confirmTarget?.name })
        }}</Label>
        <Input id="wh-confirm" v-model="confirmText" :aria-invalid="confirmError || undefined" />
        <p v-if="confirmError" class="text-xs text-destructive">
          {{ $t("platform.webhooks.confirmMismatch") }}
        </p>
      </div>
    </ConfirmDialog>
  </div>
</template>
