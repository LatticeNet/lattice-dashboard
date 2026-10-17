<script setup lang="ts">
/**
 * "Degraded when" (design 29 D13): the degraded rule's four thresholds in a
 * collapsed disclosure, shared by the check editor and the path set. The
 * summary says the rule in one sentence; open, it offers each threshold with
 * its unit, checks the bounds as the server does (degradedRuleModel), and
 * resets to the defaults. Degraded is shown whatever the alert policy, so the
 * disclosure is there for every kind but tls, which is never judged.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RotateCcw } from "lucide-vue-next";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

import { DEGRADED_BOUNDS, DEGRADED_FIELDS, defaultDegradedDraft, degradedProblems, degradedSummary, isDefaultRule, type DegradedDraft, type DegradedField } from "./degradedRuleModel";

const props = defineProps<{
  modelValue: DegradedDraft;
  /** Prefix for the inputs' ids, unique on the page. */
  idPrefix: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: DegradedDraft] }>();

const { t } = useI18n();

const problems = computed(() => new Set(degradedProblems(props.modelValue)));
const summary = computed(() => t("fleet.monitoring.degradedRule.summary", degradedSummary(props.modelValue)));
const isDefault = computed(() => isDefaultRule(props.modelValue));

function set(field: DegradedField, value: string | number): void {
  emit("update:modelValue", { ...props.modelValue, [field]: value });
}

function reset(): void {
  emit("update:modelValue", defaultDegradedDraft());
}

const STEP: Record<DegradedField, string> = { lossPercent: "0.1", lossFactor: "0.1", latencyFactor: "0.1", latencyMarginMs: "1" };
</script>

<template>
  <details class="group rounded-md border border-border" data-testid="degraded-rule">
    <summary class="flex cursor-pointer list-none items-start gap-2 px-3 py-2 pointer-coarse:min-h-11 pointer-coarse:items-center">
      <span class="min-w-0 flex-1">
        <span class="block text-xs font-medium">{{ $t('fleet.monitoring.degradedRule.title') }}</span>
        <span :class="cn('block text-xs break-words', problems.size ? 'text-destructive' : 'text-muted-foreground')" data-testid="degraded-rule-summary">
          {{ problems.size ? $t('fleet.monitoring.degradedRule.fix', { n: problems.size }, problems.size) : summary }}
        </span>
      </span>
      <span class="shrink-0 pt-0.5 text-xs text-muted-foreground group-open:hidden" aria-hidden="true">{{ $t('fleet.monitoring.degradedRule.open') }}</span>
    </summary>
    <div class="grid gap-3 border-t border-border px-3 py-3">
      <div v-for="field in DEGRADED_FIELDS" :key="field" class="grid gap-1">
        <label :for="`${idPrefix}-${field}`" class="text-xs font-medium">{{ $t(`fleet.monitoring.degradedRule.field.${field}`) }}</label>
        <div class="flex items-center gap-2">
          <Input
            :id="`${idPrefix}-${field}`"
            :model-value="modelValue[field]"
            type="number"
            inputmode="decimal"
            :min="DEGRADED_BOUNDS[field].min"
            :max="DEGRADED_BOUNDS[field].max"
            :step="STEP[field]"
            :placeholder="String(DEGRADED_BOUNDS[field].default)"
            class="h-8 w-24"
            :aria-invalid="problems.has(field) || undefined"
            :aria-describedby="`${idPrefix}-${field}-hint`"
            :data-field="field"
            @update:model-value="(v) => set(field, v ?? '')"
          />
          <span class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.degradedRule.unit.${field}`) }}</span>
        </div>
        <p :id="`${idPrefix}-${field}-hint`" :class="cn('text-[11px]', problems.has(field) ? 'text-destructive' : 'text-muted-foreground')" :role="problems.has(field) ? 'alert' : undefined">
          {{
            problems.has(field)
              ? $t('fleet.monitoring.degradedRule.outOfBounds', { min: DEGRADED_BOUNDS[field].min, max: DEGRADED_BOUNDS[field].max })
              : $t('fleet.monitoring.degradedRule.bounds', { min: DEGRADED_BOUNDS[field].min, max: DEGRADED_BOUNDS[field].max, default: DEGRADED_BOUNDS[field].default })
          }}
        </p>
      </div>
      <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.degradedRule.gate') }}</p>
      <div>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11"
          :disabled="isDefault"
          data-testid="degraded-rule-reset"
          @click="reset"
        >
          <RotateCcw class="size-3.5" aria-hidden="true" />
          {{ $t('fleet.monitoring.degradedRule.reset') }}
        </button>
      </div>
    </div>
  </details>
</template>
