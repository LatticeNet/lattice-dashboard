<script setup lang="ts">
/**
 * "What counts as up" for a dns check (design 32 S5a), shared by the check
 * and definition editors: the name asked, the question type, whether the
 * name must resolve or must not, and the values every one of which must be
 * in the answer. The rules are dnsCheckModel's, which mirrors the SDK, and
 * every control carries the request path a refusal names (R6).
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { DNS_EXPECT_MAX, DNS_NAME_MAX, DNS_RCODE_NXDOMAIN, DNS_TYPES, DNS_VALUE_MAX, normalizeDnsName, parseExpect, resolverEncrypted } from "./dnsCheckModel";

const props = defineProps<{
  /** Prefix for the controls' ids, unique on the page. */
  idPrefix: string;
  /** The resolver endpoints the check asks, for the certificate note. */
  targets: readonly string[];
}>();
const name = defineModel<string>("name", { required: true });
const type = defineModel<string>("type", { required: true });
const expect = defineModel<string>("expect", { required: true });
const rcode = defineModel<string>("rcode", { required: true });

const { t } = useI18n();

const SEGMENT = "rounded px-2 py-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11";

const nameResult = computed(() => normalizeDnsName(name.value));
/** A name is judged once something is typed; an empty one is named by the save's missing list. */
const nameProblem = computed(() => (name.value.trim() && !nameResult.value.ok ? nameResult.value.problem : undefined));
const nxdomain = computed(() => rcode.value === DNS_RCODE_NXDOMAIN);
const expected = computed(() => parseExpect(type.value, expect.value, rcode.value));
const expectInvalid = computed(() => expected.value.problems.length > 0 || expected.value.tooMany || expected.value.withNxdomain);
const encrypted = computed(() => props.targets.some(resolverEncrypted));

function setRcode(next: string): void {
  rcode.value = next;
}
</script>

<template>
  <div class="grid gap-3" data-testid="dns-question">
    <div class="grid gap-1.5">
      <Label :for="`${idPrefix}-name`">{{ $t('fleet.monitoring.checks.editor.dns.name') }}</Label>
      <Input
        :id="`${idPrefix}-name`"
        v-model="name"
        data-field="dns_name"
        class="font-mono"
        spellcheck="false"
        autocapitalize="off"
        :placeholder="$t('fleet.monitoring.checks.editor.dns.namePlaceholder')"
        :aria-invalid="!!nameProblem || undefined"
        :aria-describedby="nameProblem ? `${idPrefix}-name-error` : undefined"
      />
      <p v-if="nameProblem" :id="`${idPrefix}-name-error`" role="alert" class="text-xs text-destructive">
        {{ $t(`fleet.monitoring.checks.editor.dns.nameProblem.${nameProblem}`, { max: DNS_NAME_MAX }) }}
      </p>
    </div>

    <div class="grid gap-1.5">
      <span :id="`${idPrefix}-type-label`" class="text-sm font-medium">{{ $t('fleet.monitoring.checks.editor.dns.type') }}</span>
      <div class="grid grid-cols-3 rounded-md border border-input p-1 sm:grid-cols-6" role="radiogroup" :aria-labelledby="`${idPrefix}-type-label`" data-field="dns_type">
        <button
          v-for="option in DNS_TYPES"
          :key="option"
          type="button"
          role="radio"
          :aria-checked="type === option"
          :class="cn(SEGMENT, 'font-mono', type === option && 'bg-secondary font-medium text-foreground')"
          @click="type = option"
        >{{ option }}</button>
      </div>
    </div>

    <div class="grid gap-1.5">
      <span :id="`${idPrefix}-answer-label`" class="text-sm font-medium">{{ $t('fleet.monitoring.checks.editor.dns.answer') }}</span>
      <div class="grid grid-cols-2 rounded-md border border-input p-1" role="radiogroup" :aria-labelledby="`${idPrefix}-answer-label`" data-field="dns_expect_rcode">
        <button type="button" role="radio" :aria-checked="!nxdomain" :class="cn(SEGMENT, !nxdomain && 'bg-secondary font-medium text-foreground')" @click="setRcode('')">
          {{ $t('fleet.monitoring.checks.editor.dns.resolves') }}
        </button>
        <button type="button" role="radio" :aria-checked="nxdomain" :class="cn(SEGMENT, nxdomain && 'bg-secondary font-medium text-foreground')" @click="setRcode(DNS_RCODE_NXDOMAIN)">
          {{ $t('fleet.monitoring.checks.editor.dns.nxdomain') }}
        </button>
      </div>
    </div>

    <div v-if="!nxdomain || expect.trim()" class="grid gap-1.5">
      <Label :for="`${idPrefix}-expect`">{{ $t('fleet.monitoring.checks.editor.dns.expect') }}</Label>
      <Textarea
        :id="`${idPrefix}-expect`"
        v-model="expect"
        data-field="dns_expect"
        rows="3"
        class="font-mono text-xs"
        spellcheck="false"
        autocapitalize="off"
        :placeholder="$t(`fleet.monitoring.checks.editor.dns.expectPlaceholder.${type}`)"
        :aria-invalid="expectInvalid || undefined"
        :aria-describedby="`${idPrefix}-expect-hint`"
      />
      <p :id="`${idPrefix}-expect-hint`" :class="cn('text-xs break-words', expectInvalid ? 'text-destructive' : 'text-muted-foreground')" :role="expectInvalid ? 'alert' : undefined" data-testid="dns-expect-hint">
        <template v-if="expected.withNxdomain">{{ $t('fleet.monitoring.checks.editor.dns.withNxdomain') }}</template>
        <template v-else-if="expected.problems.length">
          {{ $t(`fleet.monitoring.checks.editor.dns.valueProblem.${expected.problems[0]!.problem}`, { line: expected.problems[0]!.line, max: DNS_VALUE_MAX }) }}
        </template>
        <template v-else-if="expected.tooMany">{{ $t('fleet.monitoring.checks.editor.dns.tooMany', { max: DNS_EXPECT_MAX, n: expected.values.length }) }}</template>
        <template v-else-if="expected.values.length">{{ $t('fleet.monitoring.checks.editor.dns.expectAll', { n: expected.values.length, type }, expected.values.length) }}</template>
        <template v-else>{{ $t('fleet.monitoring.checks.editor.dns.expectAny', { type }) }}</template>
      </p>
    </div>
    <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.dns.nxdomainHint') }}</p>

    <p class="text-xs text-muted-foreground">
      {{ $t('fleet.monitoring.checks.editor.dns.judged') }}
      <template v-if="encrypted">{{ $t('fleet.monitoring.checks.editor.dns.certificate') }}</template>
    </p>
  </div>
</template>
