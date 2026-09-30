<script setup lang="ts">
/**
 * One toolbar, one question (design 23, section 3.9). Lifted from Evidence
 * Explore: a time range (presets plus custom since and until), a token field
 * in the one query grammar (src/lib/queryTokens), a Filters popover whose
 * checkboxes write the token they show, and Apply.
 *
 * The page owns the grammar and the address bar; the bar owns the draft.
 * The field shows the applied query until the operator edits it; Escape puts
 * the applied query back. A search submitted before the lists that names
 * resolve against have answered waits for them (`ready`), because sending
 * `node:legend-sg` on as a literal id would search for a node that does not
 * exist. Problems (a value that does not resolve, an unknown enum value) are
 * named per token while typing, and kept after Apply until the next edit,
 * since the canonical spelling Apply writes back no longer holds the token.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { Search, SlidersHorizontal, X } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface QueryFilterOption {
  key: string;
  label: string;
  /** The token the checkbox writes, shown beside it (`reason:timeout`). */
  token?: string;
  /** Trailing context when the option has no token of its own (a node name). */
  hint?: string;
  checked: boolean;
  toggle: () => void;
}

export interface QueryFilterGroup {
  key: string;
  legend: string;
  options: QueryFilterOption[];
  /** Said when the group has no options. */
  empty?: string;
}

const props = withDefaults(
  defineProps<{
    /** The applied query in the field's canonical spelling. */
    appliedText: string;
    /** Accessible label for the field. */
    label: string;
    placeholder?: string;
    /** Names resolve now; a submit before this waits. */
    ready?: boolean;
    /** Problems with a draft, one sentence each, for the page's grammar. */
    problems?: (text: string) => string[];
    /**
     * The canonical spelling of a draft, shown in the field the moment it is
     * applied (a dropped token disappears at once, not on the next poll).
     */
    canonical?: (text: string) => string;
    /** Range presets; the range control shows only when given. */
    ranges?: readonly string[];
    range?: string;
    rangeLabel?: (value: string) => string;
    rangeAriaLabel?: string;
    /** The preset that asks for its own bounds. */
    customRange?: string;
    /** Custom bounds, ISO. */
    since?: string;
    until?: string;
    /** Filters set now, for the button's count. */
    filterCount?: number;
    filterGroups?: QueryFilterGroup[];
    filtersHint?: string;
    /** Said while a submit waits for the name lists. */
    resolvingText?: string;
    testid?: string;
  }>(),
  {
    placeholder: undefined,
    ready: true,
    problems: undefined,
    canonical: undefined,
    ranges: undefined,
    range: undefined,
    rangeLabel: undefined,
    rangeAriaLabel: undefined,
    customRange: "custom",
    since: "",
    until: "",
    filterCount: 0,
    filterGroups: undefined,
    filtersHint: undefined,
    resolvingText: undefined,
    testid: "query-bar",
  },
);

const emit = defineEmits<{
  submit: [text: string];
  clear: [];
  "update:range": [value: string];
  "update:since": [iso: string];
  "update:until": [iso: string];
}>();

const { t } = useI18n();

/** What the field shows. It follows the applied query until the operator edits it. */
const draft = ref(props.appliedText);
const editing = ref(false);
watch(
  () => props.appliedText,
  (text) => {
    if (!editing.value) draft.value = text;
  },
);

const submittedProblems = ref<string[]>([]);
const pendingSubmit = ref(false);

function submit(): void {
  if (!props.ready) {
    pendingSubmit.value = true;
    return;
  }
  pendingSubmit.value = false;
  const text = draft.value;
  submittedProblems.value = props.problems?.(text) ?? [];
  editing.value = false;
  if (props.canonical) draft.value = props.canonical(text);
  emit("submit", text);
}

/** Show a query the page applied on its own (a Filters checkbox). */
function settle(text: string): void {
  editing.value = false;
  pendingSubmit.value = false;
  draft.value = text;
}

watch(
  () => props.ready,
  (ready) => {
    if (ready && pendingSubmit.value) submit();
  },
);

function onInput(): void {
  editing.value = true;
}

function revert(): void {
  editing.value = false;
  pendingSubmit.value = false;
  draft.value = props.appliedText;
}

function clear(): void {
  submittedProblems.value = [];
  pendingSubmit.value = false;
  editing.value = false;
  draft.value = "";
  emit("clear");
}

const shownProblems = computed(() => (editing.value ? props.problems?.(draft.value) ?? [] : submittedProblems.value));
const canApply = computed(() => editing.value || draft.value !== props.appliedText);

/** datetime-local speaks local wall time; the page speaks ISO. */
function toLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

defineExpose({ draft, submit, revert, settle });
</script>

<template>
  <div class="space-y-2">
    <form class="flex flex-wrap items-center gap-2" role="search" :data-testid="testid" @submit.prevent="submit">
      <Select
        v-if="ranges?.length"
        :model-value="range"
        @update:model-value="(value) => emit('update:range', String(value))"
      >
        <SelectTrigger class="w-36 sm:w-40" :aria-label="rangeAriaLabel ?? $t('common.query.rangeLabel')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="value in ranges" :key="value" :value="value">
            {{ rangeLabel ? rangeLabel(value) : value }}
          </SelectItem>
        </SelectContent>
      </Select>

      <slot name="leading" />

      <div class="relative min-w-0 flex-1 basis-full sm:basis-72">
        <Search aria-hidden="true" class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="draft"
          class="pr-8 pl-8 font-mono text-xs"
          autocomplete="off"
          spellcheck="false"
          autocapitalize="off"
          :aria-label="label"
          :placeholder="placeholder"
          :data-testid="`${testid}-field`"
          @input="onInput"
          @keydown.escape="revert"
        />
        <button
          v-if="draft"
          type="button"
          class="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="$t('common.query.clear')"
          @click="clear"
        >
          <X aria-hidden="true" class="size-4" />
        </button>
      </div>

      <PopoverRoot v-if="filterGroups || $slots.filters">
        <PopoverTrigger as-child>
          <Button type="button" variant="outline" :data-testid="`${testid}-filters`">
            <SlidersHorizontal aria-hidden="true" class="size-4" />
            {{ $t('common.query.filters') }}
            <span v-if="filterCount" class="font-mono text-xs tabular text-muted-foreground">{{ filterCount }}</span>
          </Button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            :side-offset="6"
            align="end"
            :collision-padding="12"
            class="z-50 max-h-[min(32rem,var(--reka-popover-content-available-height))] w-[min(22rem,calc(100vw-24px))] overflow-y-auto rounded-md border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          >
            <p v-if="filtersHint" class="mb-3 text-xs text-muted-foreground">{{ filtersHint }}</p>
            <slot name="filters">
              <fieldset v-for="(group, index) in filterGroups" :key="group.key" :class="index > 0 ? 'mt-4 space-y-1.5' : 'space-y-1.5'">
                <legend class="mb-1 text-xs font-medium text-muted-foreground">{{ group.legend }}</legend>
                <p v-if="group.options.length === 0 && group.empty" class="text-sm text-muted-foreground">{{ group.empty }}</p>
                <label v-for="option in group.options" :key="option.key" class="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
                  <Checkbox :model-value="option.checked" @update:model-value="option.toggle" />
                  <span class="min-w-0 truncate" :title="option.label">{{ option.label }}</span>
                  <span v-if="option.token" class="ms-auto shrink-0 font-mono text-xs text-muted-foreground">{{ option.token }}</span>
                  <span v-else-if="option.hint" class="ms-auto truncate text-xs text-muted-foreground">{{ option.hint }}</span>
                </label>
              </fieldset>
            </slot>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>

      <Button type="submit" variant="outline" :disabled="!canApply" :data-testid="`${testid}-apply`">
        {{ $t('common.query.apply') }}
      </Button>

      <!-- A custom window needs its two bounds; they sit on their own row. -->
      <div v-if="ranges?.length && range === customRange" class="flex w-full flex-wrap items-center gap-2">
        <label class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">{{ $t('common.query.since') }}</span>
          <Input
            type="datetime-local"
            class="w-auto"
            :model-value="toLocalInput(since)"
            @change="(e: Event) => emit('update:since', fromLocalInput((e.target as HTMLInputElement).value))"
          />
        </label>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">{{ $t('common.query.until') }}</span>
          <Input
            type="datetime-local"
            class="w-auto"
            :model-value="toLocalInput(until)"
            @change="(e: Event) => emit('update:until', fromLocalInput((e.target as HTMLInputElement).value))"
          />
        </label>
      </div>
    </form>

    <p v-if="pendingSubmit" class="text-xs text-muted-foreground" aria-live="polite">
      {{ resolvingText ?? t('common.query.resolvingNames') }}
    </p>
    <ul v-if="shownProblems.length" class="space-y-0.5 text-xs text-warning-text" aria-live="polite">
      <li v-for="problem in shownProblems" :key="problem">{{ problem }}</li>
    </ul>
  </div>
</template>
