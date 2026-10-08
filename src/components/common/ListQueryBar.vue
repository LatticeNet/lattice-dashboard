<script setup lang="ts">
/**
 * One field that searches, filters and sorts a list in the browser, in the
 * list query grammar (src/lib/query). The client-side sibling of QueryBar,
 * which writes server queries and waits for Apply; this one filters as the
 * operator types, because the rows are already here.
 *
 *   [/] tag:edge status:offline OR status:degraded sort:-cpu   12/34 [x] [?]
 *
 * The page owns the text (usually `?q=`, through useQueryText) and the query
 * (useListQuery); the bar owns the typing: a menu of fields, flags, sort keys
 * and values at the caret, a help card with the page's examples, the syntax
 * and the page's fields, the count inside the field's end so the page never
 * shifts, the error with the offending characters marked, and the
 * operator's recent queries for this page.
 *
 * Keys. Nothing in the menu is marked until the operator arrows into it, so
 * Enter and Tab keep their usual meaning: Enter keeps the query (and shows
 * any error at once), Tab moves on. ArrowDown opens the menu (on an empty
 * field: the recent queries) and moves through it, ArrowUp moves back,
 * Enter or Tab inserts the marked item, Escape closes the menu and, with the
 * menu closed, leaves the field. The clear button is the one way to empty it.
 * Keys pressed while an input method is composing belong to the input method.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { CircleHelp, History, Search, X } from "lucide-vue-next";

import type { ListQueryState } from "@/composables/useListQuery";
import { completeQuery, type Completion } from "@/lib/query/complete";
import type { FieldType, QueryFieldInfo } from "@/lib/query/engine";
import { cn } from "@/lib/utils";

export interface ListQueryExample {
  query: string;
  /** What it finds, already translated. */
  note: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** The page's query (useListQuery). */
    query: ListQueryState;
    /** Rows kept and rows in the list; the count shows when given. */
    count?: { shown: number; total: number };
    /** Accessible name for the field. */
    label: string;
    placeholder?: string;
    /** Names this page's recent queries in local storage. */
    storageKey: string;
    /** Queries worth showing in the help, for this page. */
    examples?: readonly ListQueryExample[];
    testid?: string;
  }>(),
  { count: undefined, placeholder: undefined, examples: () => [], testid: "list-query" },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const { t, te } = useI18n();

const input = ref<HTMLInputElement>();
const uid = `lq-${Math.random().toString(36).slice(2, 8)}`;
const listId = `${uid}-list`;
const statusId = `${uid}-status`;

const fields = computed<readonly QueryFieldInfo[]>(() => props.query.fields.value);
const shownError = computed(() => props.query.shownError.value);

/* ------------------------------ recent ------------------------------ */

const RECENT_MAX = 6;
/** A query left in the field this long, with rows to show, counts as one worth keeping. */
const RECENT_SETTLE_MS = 2000;
const recentKey = computed(() => `lattice.query.recent.${props.storageKey}`);

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(recentKey.value);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string" && !!q.trim()).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

const recent = ref<string[]>(readRecent());

function remember(query: string): void {
  const text = query.trim();
  if (!text || props.query.error.value) return;
  const next = [text, ...recent.value.filter((q) => q !== text)].slice(0, RECENT_MAX);
  recent.value = next;
  try {
    localStorage.setItem(recentKey.value, JSON.stringify(next));
  } catch {
    /* storage may be refused; the list lives for this visit */
  }
}

/** When the text last changed, so leaving the field keeps only a query that stood. */
let editedAt = 0;
watch(
  () => props.modelValue,
  () => {
    editedAt = Date.now();
  },
);

/** Leaving the field keeps a query that stood for a moment and found something; half-typed words do not. */
function rememberSettled(): void {
  if (Date.now() - editedAt < RECENT_SETTLE_MS) return;
  if (props.count && props.count.shown === 0) return;
  remember(props.modelValue);
}

/* ------------------------------- menu ------------------------------- */

interface MenuItem {
  key: string;
  label: string;
  /** Completion: replace start..end with insert. Recent: replace the whole field. */
  insert: string;
  start: number;
  end: number;
  kind: Completion["kind"] | "recent";
  hint?: string;
  type?: FieldType;
}

const open = ref(false);
/** The marked item; -1 until the operator arrows into the menu. */
const active = ref(-1);
const items = ref<MenuItem[]>([]);

function caretOf(): number {
  return input.value?.selectionStart ?? props.modelValue.length;
}

/** Fill the menu for the caret; on an empty field, with the recent queries when asked. */
function refresh(withRecent = false): void {
  const text = props.modelValue;
  if (!text.trim()) {
    items.value = withRecent
      ? recent.value.map((query, i) => ({ key: `recent-${i}`, label: query, insert: query, start: 0, end: text.length, kind: "recent" }))
      : [];
  } else {
    const caret = caretOf();
    const result = completeQuery(text, caret, fields.value);
    const typed = text.slice(result.start, caret).toLowerCase();
    items.value = result.items
      // A value, flag or sort key already typed in full has nothing left to complete.
      .filter((item) => !(item.insert.trimEnd().toLowerCase() === typed && text.slice(caret, result.end) === ""))
      .map((item, i) => ({ key: `${item.kind}-${i}-${item.label}`, ...item, start: result.start, end: result.end }));
  }
  active.value = -1;
  open.value = items.value.length > 0;
}

function close(): void {
  open.value = false;
  active.value = -1;
}

async function accept(item: MenuItem): Promise<void> {
  const text = props.modelValue;
  const next = item.kind === "recent" ? item.insert : text.slice(0, item.start) + item.insert + text.slice(item.end);
  const caret = item.kind === "recent" ? next.length : item.start + item.insert.length;
  emit("update:modelValue", next);
  await nextTick();
  input.value?.focus();
  input.value?.setSelectionRange(caret, caret);
  // A field name opens straight onto its values; a value or a recent query closes the menu.
  if (item.kind === "field" || (item.kind === "flag" && item.label === "is:") || (item.kind === "sort" && item.label === "sort:")) refresh();
  else close();
}

function onInput(event: Event): void {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
  void nextTick(() => refresh());
}

function scrollActive(): void {
  void nextTick(() => document.getElementById(`${uid}-opt-${active.value}`)?.scrollIntoView({ block: "nearest" }));
}

function move(step: number): void {
  if (!open.value) {
    refresh(true);
    if (open.value) active.value = step > 0 ? 0 : items.value.length - 1;
    scrollActive();
    return;
  }
  const n = items.value.length;
  if (!n) return;
  active.value = active.value < 0 ? (step > 0 ? 0 : n - 1) : (active.value + step + n) % n;
  scrollActive();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  const marked = open.value && active.value >= 0 ? items.value[active.value] : undefined;
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      move(-1);
      break;
    case "Enter":
      event.preventDefault();
      if (marked) {
        void accept(marked);
      } else {
        close();
        props.query.reveal();
        remember(props.modelValue);
      }
      break;
    case "Tab":
      if (marked && !event.shiftKey) {
        event.preventDefault();
        void accept(marked);
      } else {
        close();
      }
      break;
    case "Escape":
      event.preventDefault();
      event.stopPropagation();
      if (open.value) close();
      else input.value?.blur();
      break;
  }
}

function onClick(): void {
  // A click on an empty field offers the recent queries; elsewhere it follows the caret.
  if (!props.modelValue.trim()) refresh(true);
  else if (open.value) refresh();
}

let blurTimer: ReturnType<typeof setTimeout> | undefined;
function onBlur(): void {
  // Pointer presses on the menu keep focus (mousedown.prevent); anything else closes it.
  blurTimer = setTimeout(close, 0);
  props.query.reveal();
  rememberSettled();
}
onBeforeUnmount(() => clearTimeout(blurTimer));

function clear(): void {
  emit("update:modelValue", "");
  close();
  void nextTick(() => input.value?.focus());
}

// The field can change under the bar (Back, a link, a chip): the menu follows the text, not the other way round.
watch(
  () => props.modelValue,
  () => {
    if (document.activeElement !== input.value) close();
  },
);

const activeId = computed(() => (open.value && active.value >= 0 ? `${uid}-opt-${active.value}` : undefined));

const TYPE_KEY: Record<FieldType, string> = {
  string: "text",
  list: "list",
  enum: "enum",
  bool: "bool",
  number: "number",
  duration: "duration",
  time: "time",
  version: "version",
};

function hintText(item: { hint?: string; type?: FieldType; kind: MenuItem["kind"] }): string {
  if (item.kind === "recent" || item.kind === "value") return "";
  if (item.hint && te(item.hint)) return t(item.hint);
  if (item.kind === "flag") return t("common.listQuery.menu.flags");
  if (item.kind === "sort") return t("common.listQuery.menu.sort");
  return item.type ? t(`common.listQuery.types.${TYPE_KEY[item.type]}`) : "";
}

/* ------------------------------- count ------------------------------ */

const countShort = computed(() => (props.count && !shownError.value ? `${props.count.shown}/${props.count.total}` : ""));
const countLong = computed(() => (props.count ? t("common.listQuery.count", { shown: props.count.shown, total: props.count.total }) : ""));
/** Room at the field's end for the clear and help buttons, and the count when it shows. */
const endPadding = computed(() => (countShort.value ? `calc(${countShort.value.length + 1}ch + 4rem)` : "3.75rem"));

/* ------------------------------- error ------------------------------ */

const SNIPPET_RADIUS = 28;

const errorMessage = computed(() => {
  const error = shownError.value;
  if (!error) return "";
  const params = { ...(error.params ?? {}) } as Record<string, string | number>;
  let key = `common.listQuery.errors.${error.code}`;
  if (error.code === "badNumber") key = `common.listQuery.errors.badNumber.${params.unit ?? "plain"}`;
  else if (params.suggestion) key = `${key}Suggest`;
  return t(key, params);
});

/** The query around the error, the bad characters marked; long queries are cut to a window. */
const snippet = computed(() => {
  const error = shownError.value;
  if (!error) return undefined;
  const text = props.modelValue;
  const from = Math.max(0, error.start - SNIPPET_RADIUS);
  const to = Math.min(text.length, error.end + SNIPPET_RADIUS);
  return {
    lead: from > 0 ? "..." : "",
    before: text.slice(from, error.start),
    bad: text.slice(error.start, error.end),
    after: text.slice(error.end, to),
    trail: to < text.length ? "..." : "",
    column: error.start + 1,
  };
});

/** The name the error suggests, ready to put in place of the bad one. */
const suggestion = computed(() => {
  const error = shownError.value;
  const name = error?.params?.suggestion;
  if (!error || typeof name !== "string" || !name) return undefined;
  const bad = props.modelValue.slice(error.start, error.end);
  return bad.startsWith("-") ? `-${name}` : name;
});

async function useSuggestion(): Promise<void> {
  const error = shownError.value;
  if (!error || !suggestion.value) return;
  const text = props.modelValue;
  const next = text.slice(0, error.start) + suggestion.value + text.slice(error.end);
  const caret = error.start + suggestion.value.length;
  emit("update:modelValue", next);
  await nextTick();
  input.value?.focus();
  input.value?.setSelectionRange(caret, caret);
}

/** What the list on screen answers while the text does not read. */
const staleText = computed(() => {
  if (!props.query.stale.value) return "";
  const running = props.query.active.value;
  if (running.empty) return t("common.listQuery.staleAll");
  if (props.count) return t("common.listQuery.staleFor", { shown: props.count.shown, total: props.count.total, query: running.source.trim() });
  return t("common.listQuery.stale");
});

/* ------------------------------- help ------------------------------- */

const helpOpen = ref(false);

const SYNTAX: readonly { query: string; key: string }[] = [
  { query: "edge", key: "word" },
  { query: "tag:edge", key: "contains" },
  { query: "name:=hk-1", key: "exact" },
  { query: "name:hk*", key: "wildcard" },
  { query: "status:offline,degraded", key: "anyOf" },
  { query: "cpu>80 mem>=90% rx>10MiB", key: "compare" },
  { query: "last_seen>10m uptime<1d", key: "age" },
  { query: "is:offline", key: "flag" },
  { query: "a b", key: "and" },
  { query: "a OR b    a | b", key: "or" },
  { query: "-tag:lab    NOT cap:root", key: "not" },
  { query: "(a OR b) c", key: "group" },
  { query: "sort:-cpu sort:name", key: "sort" },
  { query: '"two words"', key: "quote" },
];

const helpFields = computed(() => fields.value.filter((field) => !field.flag));
const helpFlags = computed(() => fields.value.filter((field) => field.flag).map((field) => field.key));

function fieldNames(field: QueryFieldInfo): string {
  return [field.key, ...field.aliases].join(", ");
}

async function pickExample(query: string): Promise<void> {
  // The query being replaced stays one keystroke away.
  remember(props.modelValue);
  emit("update:modelValue", query);
  helpOpen.value = false;
  await nextTick();
  input.value?.focus();
  input.value?.setSelectionRange(query.length, query.length);
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="min-w-0 space-y-1" :data-testid="testid">
    <div class="relative">
      <Search aria-hidden="true" class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref="input"
        type="text"
        role="combobox"
        :value="modelValue"
        :aria-label="label"
        :aria-expanded="open"
        :aria-controls="listId"
        aria-autocomplete="list"
        :aria-activedescendant="activeId"
        :aria-invalid="shownError ? 'true' : undefined"
        :aria-describedby="statusId"
        :placeholder="placeholder"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        data-page-search
        :data-testid="`${testid}-field`"
        :style="{ paddingInlineEnd: endPadding }"
        :class="cn(
          'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent py-1 ps-8 font-mono text-xs shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground dark:placeholder:text-muted-foreground/80',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          shownError && 'border-warning focus-visible:border-warning focus-visible:ring-warning/30',
        )"
        @input="onInput"
        @keydown="onKeydown"
        @click="onClick"
        @blur="onBlur"
      />
      <div class="absolute end-1 top-1/2 flex -translate-y-1/2 items-center">
        <span
          v-if="countShort"
          aria-hidden="true"
          class="pointer-events-none me-1.5 font-mono text-[11px] tabular text-muted-foreground"
          :title="countLong"
          :data-testid="`${testid}-count`"
        >{{ countShort }}</span>
        <button
          v-if="modelValue"
          type="button"
          class="touch-target inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="t('common.listQuery.clear')"
          :data-testid="`${testid}-clear`"
          @click="clear"
        >
          <X aria-hidden="true" class="size-4" />
        </button>
        <PopoverRoot v-model:open="helpOpen">
          <PopoverTrigger as-child>
            <button
              type="button"
              class="touch-target inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:text-foreground"
              :aria-label="t('common.listQuery.help.open')"
              :data-testid="`${testid}-help`"
            >
              <CircleHelp aria-hidden="true" class="size-4" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              :side-offset="6"
              align="end"
              :collision-padding="12"
              class="z-50 max-h-[min(34rem,var(--reka-popover-content-available-height))] w-[min(30rem,calc(100vw-24px))] overflow-y-auto rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
              :data-testid="`${testid}-help-card`"
            >
              <p class="font-medium">{{ t('common.listQuery.help.title') }}</p>

              <template v-if="examples.length">
                <p class="mt-2 text-xs font-medium text-muted-foreground">{{ t('common.listQuery.help.examples') }}</p>
                <ul class="mt-1 space-y-1.5 text-xs">
                  <li v-for="example in examples" :key="example.query" class="flex min-w-0 flex-col">
                    <button
                      type="button"
                      class="self-start rounded-sm text-start font-mono text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      @click="pickExample(example.query)"
                    >{{ example.query }}</button>
                    <span class="text-muted-foreground">{{ example.note }}</span>
                  </li>
                </ul>
              </template>

              <p class="mt-3 text-xs font-medium text-muted-foreground">{{ t('common.listQuery.help.syntaxTitle') }}</p>
              <dl class="mt-1 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <template v-for="row in SYNTAX" :key="row.key">
                  <dt class="whitespace-pre font-mono text-foreground">{{ row.query }}</dt>
                  <dd class="text-muted-foreground">{{ t(`common.listQuery.help.syntax.${row.key}`) }}</dd>
                </template>
              </dl>
              <p class="mt-2 text-xs text-muted-foreground">{{ t('common.listQuery.help.precedence') }}</p>
              <p class="mt-1 text-xs text-muted-foreground">{{ t('common.listQuery.help.missing', { negated: '-cpu<50', plain: 'cpu>=50' }) }}</p>

              <p class="mt-3 text-xs font-medium text-muted-foreground">{{ t('common.listQuery.help.fields') }}</p>
              <dl class="mt-1 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                <template v-for="field in helpFields" :key="field.key">
                  <dt class="font-mono text-foreground">{{ fieldNames(field) }}</dt>
                  <dd class="text-muted-foreground">{{ hintText({ hint: field.hint, type: field.type, kind: 'field' }) }}</dd>
                </template>
              </dl>
              <p v-if="helpFlags.length" class="mt-2 text-xs text-muted-foreground">
                <span class="font-medium">{{ t('common.listQuery.help.flags') }}</span>
                <span class="font-mono text-foreground"> is:{{ helpFlags.join(' is:') }}</span>
              </p>
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
      </div>

      <ul
        v-show="open"
        :id="listId"
        role="listbox"
        :aria-label="label"
        class="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        :data-testid="`${testid}-menu`"
      >
        <li v-if="items[0]?.kind === 'recent'" role="presentation" class="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">
          {{ t('common.listQuery.menu.recent') }}
        </li>
        <li
          v-for="(item, index) in items"
          :id="`${uid}-opt-${index}`"
          :key="item.key"
          role="option"
          :aria-selected="index === active"
          :class="cn(
            'flex h-8 cursor-pointer items-center gap-3 rounded-sm px-2 text-xs',
            index === active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-muted/60',
          )"
          @mousedown.prevent="accept(item)"
        >
          <History v-if="item.kind === 'recent'" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 truncate font-mono">{{ item.label }}</span>
          <span v-if="hintText(item)" class="ms-auto min-w-0 truncate text-[11px] text-muted-foreground">{{ hintText(item) }}</span>
        </li>
      </ul>
    </div>

    <div :id="statusId" class="min-w-0 text-xs empty:hidden" aria-live="polite" :data-testid="`${testid}-status`">
      <template v-if="shownError && snippet">
        <p class="text-warning-text" :data-testid="`${testid}-error`">
          {{ errorMessage }}
          <span class="text-muted-foreground">{{ t('common.listQuery.column', { n: snippet.column }) }}</span>
          <button
            v-if="suggestion"
            type="button"
            class="ms-1 rounded-sm font-mono font-medium text-foreground underline underline-offset-2 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            :data-testid="`${testid}-suggestion`"
            @click="useSuggestion"
          >{{ t('common.listQuery.useSuggestion', { name: suggestion }) }}</button>
        </p>
        <p class="truncate font-mono text-muted-foreground" aria-hidden="true">
          {{ snippet.lead }}<span class="whitespace-pre">{{ snippet.before }}</span><mark
            class="rounded-sm bg-warning/25 px-px text-foreground underline decoration-warning decoration-wavy underline-offset-2"
          ><span class="whitespace-pre">{{ snippet.bad || ' ' }}</span></mark><span class="whitespace-pre">{{ snippet.after }}</span>{{ snippet.trail }}
        </p>
        <p v-if="staleText" class="text-muted-foreground" :data-testid="`${testid}-stale`">{{ staleText }}</p>
      </template>
    </div>
    <!-- The count, said for a screen reader; out of the flow, so the page never moves when it appears. -->
    <p v-if="countLong && !shownError" class="sr-only" aria-live="polite">{{ countLong }}</p>
  </div>
</template>
