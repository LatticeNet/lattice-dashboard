<script setup lang="ts">
/**
 * The expiry half of a share form.
 *
 * One component rather than the same three fields written into both the publish
 * dialog and the edit dialog. Two copies drift, and the one that drifts is
 * always the one that decides when a public URL stops answering.
 *
 * It owns no policy: the arithmetic and the validation live in
 * shareExpiryModel, and this only binds them to controls.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

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
  expiryFormError,
  expiryInstant,
  type DurationUnit,
  type ExpiryForm,
} from "@/views/networking/shareExpiryModel";
import { formatDateTime } from "@/lib/format";

const form = defineModel<ExpiryForm>({ required: true });
const props = defineProps<{ idPrefix: string; now: number }>();

const { t } = useI18n();

const UNITS: DurationUnit[] = ["day", "month", "quarter", "year"];

const errorKey = computed(() => expiryFormError(form.value, props.now));
const error = computed(() =>
  errorKey.value ? t(`networking.shares.expiry.errors.${errorKey.value}`) : "",
);

/**
 * The resolved instant, echoed back under the controls.
 *
 * "90 days" and "the 30th" are both indirect ways of naming a moment, and the
 * operator is about to publish a URL that dies at that moment. Showing it turns
 * a calculation they have to trust into one they can check.
 */
const resolved = computed(() => {
  if (errorKey.value) return "";
  const at = expiryInstant(form.value, props.now);
  return at ? formatDateTime(at) : "";
});
</script>

<template>
  <div class="grid gap-2">
    <Label :for="`${props.idPrefix}-expiry-mode`">{{
      $t("networking.shares.expiry.label")
    }}</Label>
    <Select v-model="form.mode">
      <SelectTrigger :id="`${props.idPrefix}-expiry-mode`"
        ><SelectValue
      /></SelectTrigger>
      <SelectContent>
        <SelectItem value="never">{{
          $t("networking.shares.expiry.modeNever")
        }}</SelectItem>
        <SelectItem value="duration">{{
          $t("networking.shares.expiry.modeDuration")
        }}</SelectItem>
        <SelectItem value="date">{{
          $t("networking.shares.expiry.modeDate")
        }}</SelectItem>
      </SelectContent>
    </Select>

    <div v-if="form.mode === 'duration'" class="flex gap-2">
      <Input
        :id="`${props.idPrefix}-expiry-amount`"
        v-model.number="form.amount"
        type="number"
        min="1"
        step="1"
        class="w-24"
        :aria-label="$t('networking.shares.expiry.amountLabel')"
      />
      <Select v-model="form.unit">
        <SelectTrigger class="flex-1"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="unit in UNITS" :key="unit" :value="unit">
            {{ $t(`networking.shares.expiry.unit.${unit}`) }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <Input
      v-else-if="form.mode === 'date'"
      :id="`${props.idPrefix}-expiry-on`"
      v-model="form.on"
      type="date"
      :aria-label="$t('networking.shares.expiry.dateLabel')"
    />

    <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
    <p v-else-if="resolved" class="text-xs text-muted-foreground">
      {{ $t("networking.shares.expiry.resolved", { at: resolved }) }}
    </p>
    <p v-else class="text-xs text-muted-foreground">
      {{ $t("networking.shares.expiry.neverHint") }}
    </p>
  </div>
</template>
