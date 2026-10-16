<script setup lang="ts">
/**
 * An http check's request headers (design 29 D1, D9): a name, a value and a
 * Secret switch per row, at most eight. A secret the server holds shows
 * "set" and Replace, never a value; Replace opens an empty password field
 * with Keep current. A saved header's name is fixed (a renamed secret would
 * need a value the console never held), so renaming is remove and add.
 *
 * The rule that surprises is said under the rows, not in a tooltip: secret
 * values go only to the origin they were saved for, over HTTPS, and never
 * follow a redirect.
 */
import { computed, nextTick, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, X } from "lucide-vue-next";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

import { keepCurrent, keptSecret, newHeaderRow, setSecret, startReplace, type HeaderProblems, type HeaderRow } from "./checkHeadersModel";
import { HEADERS_MAX } from "./checkRulesModel";
import { useTargetCopy } from "./checksCopy";

const props = defineProps<{
  problems: HeaderProblems;
  /** The origin secrets would be bound to, when the URL has one. */
  origin?: string;
  /** The save creates a check: saved secrets are not carried. */
  newCheck: boolean;
}>();
const rows = defineModel<HeaderRow[]>({ required: true });

const { t } = useI18n();
const { headerRowText, headersText } = useTargetCopy();
const id = useId();
let added = 0;
/** Fields the operator has left: an empty field says it needs a value only after that, not while it is being filled. */
const touched = ref(new Set<string>());
const touch = (row: HeaderRow, part: string) => (touched.value = new Set(touched.value).add(`${row.key}:${part}`));

function update(key: string, next: (row: HeaderRow) => HeaderRow): void {
  rows.value = rows.value.map((r) => (r.key === key ? next(r) : r));
}

/** Move focus to an element of the list once it is drawn. */
function focusLater(elementId: string): void {
  void nextTick(() => document.getElementById(elementId)?.focus());
}

function add(): void {
  added += 1;
  const row = newHeaderRow(`new-${id}-${added}`);
  rows.value = [...rows.value, row];
  focusLater(fieldId(row, "name"));
}

function remove(key: string): void {
  const at = rows.value.findIndex((r) => r.key === key);
  // The model hands the new list back on the parent's update, so read the rows left from this copy.
  const left = rows.value.filter((r) => r.key !== key);
  rows.value = left;
  // Focus stays in the list: the row that took this one's place, else the one before, else Add header.
  const next = left[at] ?? left[at - 1];
  focusLater(next ? fieldId(next, "remove") : `hdr-${id}-add`);
}

function replace(row: HeaderRow): void {
  update(row.key, startReplace);
  focusLater(fieldId(row, "value"));
}

function keep(row: HeaderRow): void {
  update(row.key, keepCurrent);
  focusLater(fieldId(row, "replace"));
}

const anySecret = computed(() => rows.value.some((r) => r.secret));
const fieldId = (row: HeaderRow, part: string) => `hdr-${id}-${row.key}-${part}`;
const problemsOf = (row: HeaderRow) => props.problems.rows[row.key] ?? [];
const shown = (row: HeaderRow, part: string, filled: boolean) => filled || touched.value.has(`${row.key}:${part}`);
const nameProblem = (row: HeaderRow) => (shown(row, "name", !!row.name || !!row.saved) ? problemsOf(row).find((p) => p.startsWith("name")) : undefined);
const valueProblem = (row: HeaderRow) => {
  const problem = problemsOf(row).find((p) => !p.startsWith("name"));
  return problem === "valueRequired" && !shown(row, "value", false) ? undefined : problem;
};
/** A saved secret a new check will not have: "not carried" rather than "set". */
const notCarried = (row: HeaderRow) => props.newCheck && !!row.saved?.secret;
</script>

<template>
  <div class="grid gap-2" data-testid="header-rows">
    <p class="text-xs font-medium">{{ t('fleet.monitoring.checks.editor.headers.title') }}</p>
    <ul v-if="rows.length" class="divide-y divide-border rounded-md border border-border">
      <li v-for="row in rows" :key="row.key" class="grid gap-2 p-2.5" :data-header-row="row.saved ? 'saved' : 'new'">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <template v-if="row.saved">
              <span class="sr-only">{{ t('fleet.monitoring.checks.editor.headers.name') }}</span>
              <span class="block font-mono text-xs font-medium break-all" :id="fieldId(row, 'name')">{{ row.name }}</span>
            </template>
            <template v-else>
              <label :for="fieldId(row, 'name')" class="sr-only">{{ t('fleet.monitoring.checks.editor.headers.name') }}</label>
              <Input
                :id="fieldId(row, 'name')"
                :model-value="row.name"
                class="h-8 font-mono text-xs pointer-coarse:h-11"
                :placeholder="t('fleet.monitoring.checks.editor.headers.namePlaceholder')"
                autocomplete="off"
                spellcheck="false"
                :aria-invalid="!!nameProblem(row) || undefined"
                :aria-describedby="nameProblem(row) ? fieldId(row, 'name-error') : undefined"
                @update:model-value="(v) => update(row.key, (r) => ({ ...r, name: String(v) }))"
                @blur="touch(row, 'name')"
              />
            </template>
            <p v-if="nameProblem(row)" :id="fieldId(row, 'name-error')" role="alert" class="mt-1 text-xs text-destructive">{{ headerRowText(nameProblem(row)!) }}</p>
          </div>
          <Button
            :id="fieldId(row, 'remove')"
            variant="ghost"
            size="icon"
            type="button"
            class="size-8 shrink-0 pointer-coarse:size-11"
            :aria-label="t('fleet.monitoring.checks.editor.headers.remove', { name: row.name || t('fleet.monitoring.checks.editor.headers.unnamed') })"
            @click="remove(row.key)"
          >
            <X class="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <!-- A secret the server holds: never shown, kept unless replaced. -->
          <template v-if="keptSecret(row)">
            <span
              :class="cn('rounded-sm px-1.5 py-0.5 font-mono text-xs', notCarried(row) ? 'bg-warning/10 text-warning-text' : 'bg-muted')"
              data-testid="header-set"
            >{{ notCarried(row) ? t('fleet.monitoring.checks.editor.headers.notCarriedChip') : t('fleet.monitoring.checks.editor.headers.set') }}</span>
            <Button :id="fieldId(row, 'replace')" variant="outline" size="sm" type="button" class="h-8 pointer-coarse:h-11" @click="replace(row)">{{ t('fleet.monitoring.checks.editor.headers.replace') }}</Button>
          </template>
          <template v-else>
            <label :for="fieldId(row, 'value')" class="sr-only">{{ t('fleet.monitoring.checks.editor.headers.value', { name: row.name }) }}</label>
            <Input
              :id="fieldId(row, 'value')"
              :model-value="row.value"
              :type="row.secret ? 'password' : 'text'"
              class="h-8 min-w-0 flex-1 basis-48 font-mono text-xs pointer-coarse:h-11"
              :placeholder="row.replacing ? t('fleet.monitoring.checks.editor.headers.newValue') : t('fleet.monitoring.checks.editor.headers.valuePlaceholder')"
              :autocomplete="row.secret ? 'new-password' : 'off'"
              spellcheck="false"
              :aria-invalid="!!valueProblem(row) || undefined"
              :aria-describedby="valueProblem(row) ? fieldId(row, 'value-error') : undefined"
              @update:model-value="(v) => update(row.key, (r) => ({ ...r, value: String(v) }))"
              @blur="touch(row, 'value')"
            />
            <Button v-if="row.replacing && row.saved?.secret" variant="outline" size="sm" type="button" class="h-8 pointer-coarse:h-11" @click="keep(row)">
              {{ t('fleet.monitoring.checks.editor.headers.keep') }}
            </Button>
          </template>
          <label class="ms-auto flex cursor-pointer items-center gap-1.5 text-xs pointer-coarse:min-h-11">
            <Checkbox :model-value="row.secret" @update:model-value="(v) => update(row.key, (r) => setSecret(r, v === true))" />
            {{ t('fleet.monitoring.checks.editor.headers.secret') }}
          </label>
        </div>
        <p v-if="valueProblem(row)" :id="fieldId(row, 'value-error')" role="alert" class="text-xs text-destructive">{{ headerRowText(valueProblem(row)!) }}</p>
      </li>
    </ul>
    <div class="flex flex-wrap items-center gap-2">
      <Button :id="`hdr-${id}-add`" variant="outline" size="sm" type="button" class="pointer-coarse:h-11" :disabled="rows.length >= HEADERS_MAX" data-testid="header-add" @click="add">
        <Plus class="size-4" aria-hidden="true" />
        {{ t('fleet.monitoring.checks.editor.headers.add') }}
      </Button>
      <span class="text-xs text-muted-foreground tabular">{{ t('fleet.monitoring.checks.editor.headers.count', { n: rows.length, max: HEADERS_MAX }) }}</span>
    </div>
    <p v-for="p in problems.list" :key="p" role="alert" class="text-xs text-destructive">{{ headersText(p) }}</p>
    <p :class="cn('text-xs', anySecret ? 'text-foreground' : 'text-muted-foreground')" data-testid="header-origin">
      {{ origin ? t('fleet.monitoring.checks.editor.headers.origin', { origin }) : t('fleet.monitoring.checks.editor.headers.originNone') }}
    </p>
    <p v-if="newCheck && origin && rows.some((r) => r.saved?.secret)" class="rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning-text" role="status">
      {{ t('fleet.monitoring.checks.editor.headers.notCarried') }}
    </p>
  </div>
</template>
