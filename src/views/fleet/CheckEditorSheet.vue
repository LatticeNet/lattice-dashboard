<script setup lang="ts">
/**
 * Create or edit a check (design 29 D9), in task order: what to measure,
 * from where, to where, what counts as up, how often, what to do when it
 * fails, and its name.
 *
 * An edit goes to POST /api/monitors/update with the version the check was
 * read at; the server refuses a stale one (409) and the sheet says so and
 * reloads. Changing the method or the target is not an edit: one history
 * must never mix two measurements, so after the operator confirms, the sheet
 * creates a new check and pauses the old one, which keeps its history. If
 * the pause fails after the create, the sheet says exactly that.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw, Save } from "lucide-vue-next";

import { api, type MonitorType, type MonitorView, type Node } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import SourcePicker from "./SourcePicker.vue";
import {
  CHECK_KINDS,
  CHECK_MAX_INTERVAL_SEC,
  CHECK_MAX_TIMEOUT_SEC,
  CHECK_MIN_INTERVAL_SEC,
  buildCreate,
  buildPauseOld,
  buildUpdate,
  draftChanged,
  draftFromMonitor,
  draftProblems,
  emptyDraft,
  identityChanged,
  suggestName,
  switchDraftKind,
  type CheckDraft,
} from "./checksModel";
import { TLS_MAX_THRESHOLD_DAYS, isServerEvaluated, targetError } from "./monitorTypeModel";

const props = defineProps<{
  open: boolean;
  /** The check being edited; absent when creating. */
  monitor?: MonitorView;
  /** The method a create opens on. */
  initialType?: MonitorType;
  nodes: Node[];
  canReadNodes: boolean;
  /** The server takes an alert policy (design 29 servers do). */
  withAlert: boolean;
}>();

const emit = defineEmits<{ close: []; saved: [id: string]; reload: [] }>();

const { t } = useI18n();

const draft = ref<CheckDraft>(emptyDraft());
const base = ref<CheckDraft>(emptyDraft());
let stash: Parameters<typeof switchDraftKind>[2];

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const start = props.monitor ? draftFromMonitor(props.monitor) : emptyDraft(props.initialType ?? "http");
    draft.value = { ...start, nodeIds: [...start.nodeIds], pausedNodeIds: [...start.pausedNodeIds] };
    base.value = start;
    stash = undefined;
  },
  { immediate: true },
);

const editing = computed(() => !!props.monitor);
const isTls = computed(() => isServerEvaluated(draft.value.type));

function setKind(kind: MonitorType): void {
  const next = switchDraftKind(draft.value, kind, stash);
  draft.value = next.draft;
  stash = next.stash;
}

const problems = computed(() => draftProblems(draft.value));
const targetProblem = computed(() => (draft.value.target.trim() ? targetError(draft.value.type, draft.value.target) : undefined));
const offerHttp = computed(() => draft.value.type === "tcp" && /^https?:\/\//i.test(draft.value.target.trim()));
const suggested = computed(() => suggestName(draft.value.type, draft.value.target));
const dirty = computed(() => (props.monitor ? draftChanged(props.monitor, draft.value) : JSON.stringify(draft.value) !== JSON.stringify(base.value)));
const replaces = computed(() => !!props.monitor && identityChanged(props.monitor, draft.value));

const problemText = computed(() =>
  problems.value
    .filter((p) => p !== "target" || draft.value.target.trim())
    .map((p) =>
      t(`fleet.monitoring.checks.editor.problem.${p}`, {
        min: CHECK_MIN_INTERVAL_SEC,
        max: CHECK_MAX_INTERVAL_SEC,
        timeout: CHECK_MAX_TIMEOUT_SEC,
        days: TLS_MAX_THRESHOLD_DAYS,
      }),
    ),
);
const missing = computed(() => {
  const out: string[] = [];
  if (!draft.value.target.trim()) out.push(t("fleet.monitoring.checks.editor.missing.target"));
  if (problems.value.includes("sources")) out.push(t("fleet.monitoring.checks.editor.missing.sources"));
  return out;
});

const pending = ref(false);
const replaceOpen = ref(false);
const discardOpen = ref(false);

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

async function save(): Promise<void> {
  if (problems.value.length || pending.value) return;
  if (props.monitor && !dirty.value) return;
  if (replaces.value) {
    replaceOpen.value = true;
    return;
  }
  pending.value = true;
  try {
    if (props.monitor) {
      await api.monitors.update(buildUpdate(props.monitor, draft.value));
      toast.success(t("fleet.monitoring.checks.toast.saved"));
      emit("saved", props.monitor.id);
    } else {
      const created = await api.monitors.create(buildCreate(draft.value, props.withAlert));
      toast.success(t("fleet.monitoring.toast.created"));
      emit("saved", created.id);
    }
    emit("close");
  } catch (error) {
    if (statusOf(error) === 409) {
      toast.error(t("fleet.monitoring.checks.toast.conflict"));
      emit("reload");
      emit("close");
    } else {
      toast.error(error instanceof Error ? error.message : t("fleet.monitoring.checks.toast.failed"));
    }
  } finally {
    pending.value = false;
  }
}

/** The method or target changed: create the new check, then pause the old one. */
async function replace(): Promise<void> {
  const old = props.monitor;
  if (!old) return;
  replaceOpen.value = false;
  pending.value = true;
  let createdId: string | undefined;
  try {
    const created = await api.monitors.create(buildCreate(draft.value, props.withAlert));
    createdId = created.id;
    await api.monitors.update(buildPauseOld(old));
    toast.success(t("fleet.monitoring.checks.toast.replaced", { name: old.name || old.id }));
    emit("saved", created.id);
    emit("close");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (createdId) {
      // The new check exists; only the pause failed. Say so, and go to the new check.
      toast.error(t("fleet.monitoring.checks.toast.pauseOldFailed", { name: old.name || old.id, reason }));
      emit("saved", createdId);
      emit("close");
    } else {
      toast.error(reason || t("fleet.monitoring.checks.toast.failed"));
    }
  } finally {
    pending.value = false;
  }
}

function requestClose(): void {
  if (pending.value) return;
  if (dirty.value) {
    discardOpen.value = true;
    return;
  }
  emit("close");
}

function discard(): void {
  discardOpen.value = false;
  emit("close");
}

const title = computed(() => (props.monitor ? t("fleet.monitoring.checks.editor.editTitle", { name: props.monitor.name || props.monitor.id }) : t("fleet.monitoring.checks.editor.createTitle")));
// A fieldset's legend breaks a top border, so sections are set apart by space, not rules.
const SECTION = "m-0 grid min-w-0 gap-2.5 border-0 p-0";
const STEP = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
</script>

<template>
  <ObjectSheet :open="open" :title="title" :subtitle="monitor?.id" @close="requestClose">
    <form id="check-editor" class="space-y-6 text-sm" data-testid="check-editor" @submit.prevent="save">
      <!-- 1. What to measure -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.what') }}</legend>
        <div class="grid gap-1.5" role="radiogroup" :aria-label="$t('fleet.monitoring.checks.editor.step.what')">
          <label
            v-for="kind in CHECK_KINDS"
            :key="kind"
            :class="cn('flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors pointer-coarse:min-h-11', draft.type === kind ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40')"
          >
            <input type="radio" name="check-kind" class="mt-1 accent-[var(--primary)]" :value="kind" :checked="draft.type === kind" @change="setKind(kind)" />
            <span>
              <span class="block font-mono text-xs font-medium uppercase">{{ kind }}</span>
              <span class="block text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.kind.${kind}`) }}</span>
            </span>
          </label>
        </div>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.kindLater') }}</p>
        <p v-if="replaces" class="rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning-text" role="status" data-testid="check-replaces">
          {{ $t('fleet.monitoring.checks.editor.replacesNote') }}
        </p>
      </fieldset>

      <!-- 2. From where -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.from') }}</legend>
        <p v-if="isTls" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.controlPlane') }}</p>
        <template v-else>
          <div class="grid grid-cols-2 rounded-md border border-input p-1" role="group" :aria-label="$t('fleet.monitoring.checks.editor.step.from')">
            <button
              type="button"
              :class="cn('rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', draft.assignAll && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="draft.assignAll"
              @click="draft = { ...draft, assignAll: true }"
            >{{ $t('fleet.monitoring.checks.editor.everyNode') }}</button>
            <button
              type="button"
              :class="cn('rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', !draft.assignAll && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="!draft.assignAll"
              @click="draft = { ...draft, assignAll: false }"
            >{{ $t('fleet.monitoring.checks.editor.chosenNodes') }}</button>
          </div>
          <p v-if="draft.assignAll" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.everyNodeHint') }}</p>
          <SourcePicker
            v-else-if="canReadNodes"
            v-model="draft.nodeIds"
            v-model:paused="draft.pausedNodeIds"
            :nodes="nodes"
            :show-pause="editing"
            :label="$t('fleet.monitoring.checks.editor.step.from')"
          />
          <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.nodeIdsManualHint') }}</p>
          <p v-if="editing && !draft.assignAll" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.pauseHint') }}</p>
        </template>
      </fieldset>

      <!-- 3. To where -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.to') }}</legend>
        <Label for="check-target" class="sr-only">{{ $t('fleet.monitoring.create.target') }}</Label>
        <Input
          id="check-target"
          v-model="draft.target"
          class="font-mono"
          :aria-invalid="!!targetProblem"
          :aria-describedby="targetProblem ? 'check-target-error' : undefined"
          :placeholder="isTls ? $t('fleet.monitoring.create.targetTlsPlaceholder') : draft.type === 'tcp' ? $t('fleet.monitoring.create.targetTcpPlaceholder') : $t('fleet.monitoring.create.targetHttpPlaceholder')"
        />
        <p v-if="targetProblem" id="check-target-error" role="alert" class="text-xs text-destructive">
          {{ isTls ? $t('fleet.monitoring.create.targetTlsError') : draft.type === 'http' ? $t('fleet.monitoring.create.targetHttpError') : $t('fleet.monitoring.create.targetTcpError') }}
          <button v-if="offerHttp" type="button" class="ms-1 font-medium text-foreground underline underline-offset-2" @click="setKind('http')">
            {{ $t('fleet.monitoring.create.switchToHttp') }}
          </button>
        </p>
      </fieldset>

      <!-- 4. What counts as up -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.expect') }}</legend>
        <template v-if="isTls">
          <div class="grid max-w-48 gap-1.5">
            <Label for="check-threshold">{{ $t('fleet.monitoring.create.thresholdDays') }}</Label>
            <Input id="check-threshold" v-model.number="draft.thresholdDays" type="number" min="1" :max="TLS_MAX_THRESHOLD_DAYS" />
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.thresholdHint', { days: draft.thresholdDays }) }}</p>
        </template>
        <p v-else class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.expect.${draft.type}`) }}</p>
      </fieldset>

      <!-- 5. How often -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.often') }}</legend>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label for="check-interval">{{ $t('fleet.monitoring.checks.editor.interval') }}</Label>
            <Input id="check-interval" v-model.number="draft.intervalSec" type="number" :min="CHECK_MIN_INTERVAL_SEC" :max="CHECK_MAX_INTERVAL_SEC" />
          </div>
          <div class="grid gap-1.5">
            <Label for="check-timeout">{{ $t('fleet.monitoring.checks.editor.timeout') }}</Label>
            <Input id="check-timeout" v-model.number="draft.timeoutSec" type="number" min="1" :max="CHECK_MAX_TIMEOUT_SEC" />
          </div>
        </div>
      </fieldset>

      <!-- 6. When it fails -->
      <fieldset v-if="withAlert" :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.fail') }}</legend>
        <label class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
          <input type="radio" name="check-alert" class="accent-[var(--primary)]" :checked="draft.alert === 'off'" @change="draft = { ...draft, alert: 'off' }" />
          <span>{{ $t('fleet.monitoring.checks.editor.alertOff') }}</span>
        </label>
        <label class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
          <input type="radio" name="check-alert" class="accent-[var(--primary)]" :checked="draft.alert === 'down'" @change="draft = { ...draft, alert: 'down' }" />
          <span>{{ $t('fleet.monitoring.checks.editor.alertDown') }}</span>
        </label>
      </fieldset>

      <!-- 7. Name -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.name') }}</legend>
        <Label for="check-name" class="sr-only">{{ $t('fleet.monitoring.create.name') }}</Label>
        <Input id="check-name" v-model="draft.name" :placeholder="suggested || $t('fleet.monitoring.create.namePlaceholder')" />
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.nameHint') }}</p>
      </fieldset>

      <p v-for="text in problemText" :key="text" role="alert" class="text-xs text-destructive">{{ text }}</p>
    </form>
    <template #actions>
      <p v-if="missing.length" class="me-auto text-xs text-muted-foreground" data-testid="check-missing">
        {{ $t('fleet.monitoring.create.missing', { fields: missing.join($t('fleet.monitoring.create.missingJoin')) }) }}
      </p>
      <p v-else-if="editing && !dirty" class="me-auto text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.unchanged') }}</p>
      <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.cancel') }}</Button>
      <Button type="submit" form="check-editor" size="sm" :disabled="pending || problems.length > 0 || (editing && !dirty)" data-testid="check-save">
        <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
        <Save v-else-if="editing" class="size-4" aria-hidden="true" />
        <Plus v-else class="size-4" aria-hidden="true" />
        {{ replaces ? $t('fleet.monitoring.checks.editor.saveReplace') : editing ? $t('fleet.monitoring.checks.editor.save') : $t('fleet.monitoring.checks.editor.create') }}
      </Button>
    </template>
  </ObjectSheet>

  <ConfirmDialog
    v-model:open="replaceOpen"
    :title="$t('fleet.monitoring.checks.editor.replace.title')"
    :description="$t('fleet.monitoring.checks.editor.replace.description', { name: monitor?.name || monitor?.id || '' })"
    :impact="[$t('fleet.monitoring.checks.editor.replace.impactNew'), $t('fleet.monitoring.checks.editor.replace.impactOld')]"
    :impact-title="$t('fleet.monitoring.checks.editor.replace.impactTitle')"
    variant="default"
    :confirm-label="$t('fleet.monitoring.checks.editor.replace.confirm')"
    :cancel-label="$t('fleet.monitoring.checks.editor.replace.keep')"
    :pending="pending"
    @confirm="replace"
  />
  <ConfirmDialog
    v-model:open="discardOpen"
    :title="$t('fleet.monitoring.checks.editor.discard.title')"
    :description="$t('fleet.monitoring.checks.editor.discard.description')"
    :confirm-label="$t('fleet.monitoring.checks.editor.discard.confirm')"
    :cancel-label="$t('fleet.monitoring.checks.editor.discard.keep')"
    @confirm="discard"
  />
</template>
