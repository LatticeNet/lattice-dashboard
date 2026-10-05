<script setup lang="ts">
/**
 * The retention line under the policy table, and its inline form (design 26,
 * R1): how big the trace store may grow, how long records, capture lines and
 * five-minute trends are kept, and how much raw log each source may hold.
 *
 * One sentence, sizes and durations in the mono face, because the budgets are
 * context for the operator's question rather than its answer. Anyone with
 * log:read reads it; only a full administrator (scope *, no node restriction)
 * gets Edit, which is what the server enforces. Lowering a value states what
 * the next retention pass removes, and Save waits for that to be
 * acknowledged, again after any further edit. A 409 means someone saved
 * since this form was opened: their values replace the fields the operator
 * left alone, the operator's edits stay, and the line says which is which
 * instead of overwriting either side.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "lucide-vue-next";

import { api, ApiError, type EvidenceSettings, type EvidenceSettingsField } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { useEvidenceContext } from "./evidenceContext";
import {
  EVIDENCE_SETTINGS_FIELDS,
  SETTINGS_FORM_UNIT,
  displayAmount,
  effectiveBounds,
  isSizeField,
  parseSettingsDraft,
  rebaseSettingsDraft,
  settingsDraft,
  settingsRemovals,
  toFormValue,
  type SettingsDraft,
  type SettingsRemoval,
  type SettingsUnit,
} from "./evidenceSettingsModel";

const { t } = useI18n();
const ctx = useEvidenceContext();

const response = computed(() => ctx.settings.data.value);
const settings = computed(() => response.value?.settings);
const bounds = computed(() => effectiveBounds(response.value?.bounds));

const readOnlyReason = computed(() =>
  ctx.canEditSettings.value ? undefined : t("platform.evidence.retention.needsFullAdmin"),
);

function amount(field: EvidenceSettingsField, raw: number): string {
  const { value, unit } = displayAmount(field, raw);
  return unitText(value, unit);
}

function unitText(value: string, unit: SettingsUnit): string {
  return t(`platform.evidence.retention.unit.${unit}`, { n: value });
}

/**
 * Where the values come from (defaults, or who saved them), which environment
 * variables they override, and why the line is read-only. One string, so the
 * sentences keep their spaces whichever of them apply.
 */
const provenance = computed(() => {
  const r = response.value;
  if (!r) return "";
  const parts = [
    r.stored
      ? r.settings.updated_at
        ? t("platform.evidence.retention.storedAt", {
            at: formatDateTime(r.settings.updated_at),
            by: r.settings.updated_by || t("common.misc.none"),
          })
        : t("platform.evidence.retention.stored")
      : t("platform.evidence.retention.defaults"),
  ];
  if (r.env_ignored?.length) parts.push(t("platform.evidence.retention.envIgnored", { vars: r.env_ignored.join(", ") }));
  if (readOnlyReason.value) parts.push(readOnlyReason.value);
  return parts.join(" ");
});

/* Editing ----------------------------------------------------------- */

const editing = ref(false);
const draft = ref<SettingsDraft | null>(null);
const saving = ref(false);
const saveError = ref("");
/** After a 409: what the other save changed, and where both changed the same field. */
const conflict = ref<{ theirs: string; clashes: string } | null>(null);
const acknowledged = ref(false);

const parsed = computed(() =>
  draft.value && settings.value ? parseSettingsDraft(draft.value, settings.value, bounds.value) : undefined,
);

const usage = computed(() => {
  const stats = ctx.stats.data.value;
  const full = stats && !stats.scoped && !ctx.stats.error.value;
  const logStats = ctx.logStats.error.value ? undefined : ctx.logStats.data.value;
  return {
    traceDbBytes: full && typeof stats.size_bytes === "number" ? stats.size_bytes : undefined,
    oldestRecordAt: full ? stats.oldest_record_at : undefined,
    rawSourceBytes: logStats?.map((entry) => entry.bytes),
    nowMs: Date.now(),
  };
});

const removals = computed<SettingsRemoval[]>(() =>
  parsed.value?.settings && settings.value ? settingsRemovals(settings.value, parsed.value.settings, usage.value) : [],
);

// Any edit is a different thing to agree to, even one that only makes a
// removal larger; the store growing on the 30 s stats poll is not.
watch(draft, () => {
  acknowledged.value = false;
});

const canSave = computed(
  () =>
    ctx.canEditSettings.value &&
    !!parsed.value?.settings &&
    parsed.value.changed.length > 0 &&
    (removals.value.length === 0 || acknowledged.value) &&
    !saving.value,
);

function startEdit(): void {
  if (!settings.value || !ctx.canEditSettings.value) return;
  draft.value = settingsDraft(settings.value);
  editing.value = true;
  conflict.value = null;
  saveError.value = "";
  acknowledged.value = false;
}

function cancelEdit(): void {
  editing.value = false;
  draft.value = null;
  conflict.value = null;
  saveError.value = "";
}

function fieldList(fields: readonly EvidenceSettingsField[], values: EvidenceSettings): string {
  return fields.map((field) => `${t(`platform.evidence.retention.label.${field}`)} ${amount(field, values[field])}`).join(", ");
}

function setDraft(field: EvidenceSettingsField, value: string | number | undefined): void {
  if (!draft.value) return;
  draft.value = { ...draft.value, [field]: value === undefined ? "" : String(value) };
}

async function save(): Promise<void> {
  const body = parsed.value?.settings;
  if (!canSave.value || !body) return;
  const before = settings.value;
  saving.value = true;
  saveError.value = "";
  conflict.value = null;
  try {
    await api.evidence.setSettings(body);
    toast.success(t("platform.evidence.retention.saved"));
    editing.value = false;
    draft.value = null;
    await ctx.settings.refresh();
    // The cap the proof line states changes live.
    void ctx.stats.refresh();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await ctx.settings.refresh();
      const after = settings.value;
      if (before && after && draft.value) {
        const rebased = rebaseSettingsDraft(draft.value, before, after);
        draft.value = rebased.draft;
        conflict.value = { theirs: fieldList(rebased.theirs, after), clashes: fieldList(rebased.clashes, after) };
      } else {
        conflict.value = { theirs: "", clashes: "" };
      }
    } else {
      saveError.value = error instanceof Error ? error.message : t("platform.evidence.retention.saveFailed");
    }
  } finally {
    saving.value = false;
  }
}

/* Form text --------------------------------------------------------- */

function boundsText(field: EvidenceSettingsField): string {
  const [min, max] = bounds.value[field];
  const unit = SETTINGS_FORM_UNIT[field];
  return t("platform.evidence.retention.bounds", {
    min: unitText(toFormValue(field, min), unit),
    max: unitText(toFormValue(field, max), unit),
  });
}

/** What the field holds now, beside its new value (question 11). */
function nowText(field: EvidenceSettingsField): string {
  if (field === "trace_db_max_bytes" && usage.value.traceDbBytes !== undefined) {
    return t("platform.evidence.retention.nowHolds", { size: formatBytes(usage.value.traceDbBytes) });
  }
  if (field === "raw_source_max_bytes" && usage.value.rawSourceBytes?.length) {
    return t("platform.evidence.retention.largestSource", { size: formatBytes(Math.max(...usage.value.rawSourceBytes)) });
  }
  if (field === "record_ttl_seconds" && usage.value.oldestRecordAt) {
    return t("platform.evidence.retention.oldestRecord", { at: formatDateTime(usage.value.oldestRecordAt) });
  }
  return "";
}

function removalText(removal: SettingsRemoval): string {
  if (removal.kind === "bytes") {
    const what = t(`platform.evidence.retention.removes.${removal.field}`);
    return removal.bytes === undefined
      ? t("platform.evidence.retention.removeUnknown", { what })
      : t("platform.evidence.retention.removeBytes", { what, size: formatBytes(removal.bytes) });
  }
  const { value, unit } = displayAmount(removal.field, removal.olderThanSeconds);
  return t("platform.evidence.retention.removeAge", {
    what: t(`platform.evidence.retention.removes.${removal.field}`),
    age: unitText(value, unit),
  });
}

const problemText = (field: EvidenceSettingsField): string => {
  const problem = parsed.value?.problems[field];
  if (!problem) return "";
  return problem === "invalid" ? t("platform.evidence.retention.invalid") : boundsText(field);
};
</script>

<template>
  <div class="space-y-3" data-testid="evidence-retention">
    <!-- The line -->
    <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div class="min-w-0 space-y-1">
        <!-- Each segment keeps its separator, so a wrapped line never
             starts with one. -->
        <p v-if="settings" class="text-sm" :title="readOnlyReason">
          <template v-for="(field, index) in EVIDENCE_SETTINGS_FIELDS" :key="field">
            <span class="whitespace-nowrap">
              <i18n-t :keypath="`platform.evidence.retention.line.${field}`" tag="span" scope="global">
                <template #value><span class="font-mono text-xs tabular">{{ amount(field, settings[field]) }}</span></template>
              </i18n-t>
              <span v-if="index < EVIDENCE_SETTINGS_FIELDS.length - 1" class="text-muted-foreground" aria-hidden="true"> ·</span>
            </span>
            {{ ' ' }}
          </template>
        </p>
        <p v-else-if="ctx.settings.error.value" class="text-sm text-destructive" role="alert">
          {{ $t('platform.evidence.retention.unread', { reason: ctx.settings.error.value.message }) }}
          <Button variant="ghost" size="sm" class="ms-1" @click="ctx.settings.refresh">
            <RefreshCw aria-hidden="true" class="size-4" />
            {{ $t('common.actions.retry') }}
          </Button>
        </p>
        <p v-else class="text-sm text-muted-foreground">{{ $t('platform.evidence.retention.reading') }}</p>
        <p v-if="response" class="text-xs text-muted-foreground">{{ provenance }}</p>
      </div>
      <Button
        v-if="ctx.canEditSettings.value && settings && !editing"
        variant="outline"
        size="sm"
        class="pointer-coarse:min-h-11"
        data-testid="retention-edit"
        @click="startEdit"
      >
        {{ $t('common.actions.edit') }}
      </Button>
    </div>

    <div v-if="conflict" class="space-y-1 text-sm text-warning-text" role="alert">
      <p>{{ conflict.theirs ? $t('platform.evidence.retention.conflictTheirs', { changes: conflict.theirs }) : $t('platform.evidence.retention.conflict') }}</p>
      <p v-if="conflict.clashes">{{ $t('platform.evidence.retention.conflictClash', { fields: conflict.clashes }) }}</p>
    </div>

    <!-- The form -->
    <form v-if="editing && draft && settings" class="space-y-4 rounded-md border border-border p-4" @submit.prevent="save">
      <div class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        <div v-for="field in EVIDENCE_SETTINGS_FIELDS" :key="field" class="grid content-start gap-1.5">
          <Label :for="`retention-${field}`">{{ $t(`platform.evidence.retention.label.${field}`) }}</Label>
          <div class="flex items-center gap-2">
            <Input
              :id="`retention-${field}`"
              class="h-9 w-32 font-mono text-sm pointer-coarse:h-11"
              type="number"
              inputmode="decimal"
              :step="isSizeField(field) && SETTINGS_FORM_UNIT[field] === 'GiB' ? '0.25' : '1'"
              :model-value="draft[field]"
              :aria-invalid="parsed?.problems[field] ? 'true' : undefined"
              :aria-describedby="`retention-${field}-hint`"
              @update:model-value="(v) => setDraft(field, v)"
            />
            <span class="text-sm text-muted-foreground">{{ $t(`platform.evidence.retention.formUnit.${SETTINGS_FORM_UNIT[field]}`) }}</span>
          </div>
          <p :id="`retention-${field}-hint`" class="text-xs" :class="parsed?.problems[field] ? 'text-destructive' : 'text-muted-foreground'">
            {{ problemText(field) || boundsText(field) }}
            <template v-if="!parsed?.problems[field] && nowText(field)"> · {{ nowText(field) }}</template>
          </p>
        </div>
      </div>

      <!-- What a lower value removes, said before Save is possible. -->
      <div v-if="removals.length" class="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid="retention-removals">
        <ul class="space-y-1 text-sm text-destructive">
          <li v-for="removal in removals" :key="removal.field">{{ removalText(removal) }}</li>
        </ul>
        <label class="flex min-h-11 items-center gap-2 text-sm sm:min-h-0">
          <Checkbox
            :model-value="acknowledged"
            :aria-label="$t('platform.evidence.retention.acknowledge')"
            @update:model-value="(v) => (acknowledged = v === true)"
          />
          <span>{{ $t('platform.evidence.retention.acknowledge') }}</span>
        </label>
      </div>

      <p v-if="saveError" class="text-sm text-destructive" role="alert">{{ $t('platform.evidence.retention.saveFailedReason', { reason: saveError }) }}</p>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <p class="me-auto text-xs text-muted-foreground">{{ $t('platform.evidence.retention.audited') }}</p>
        <Button type="button" variant="ghost" size="sm" class="pointer-coarse:min-h-11" @click="cancelEdit">{{ $t('common.actions.cancel') }}</Button>
        <Button type="submit" size="sm" class="pointer-coarse:min-h-11" :disabled="!canSave" data-testid="retention-save">
          <RefreshCw v-if="saving" aria-hidden="true" class="size-4 animate-spin" />
          {{ $t('common.actions.save') }}
        </Button>
      </div>
    </form>
  </div>
</template>
