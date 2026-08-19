<script setup lang="ts">
/**
 * The scope picker, shared by the token and user forms.
 *
 * It replaces a flat two-column checkbox grid of forty-seven scope strings,
 * duplicated in both views, with no search and no grouping. That grid could be
 * read but not reasoned about: nothing said what a scope granted, which scopes
 * belonged together, or which ones were dangerous, so the only way to issue a
 * correct token was to already know the answer.
 *
 * What changed, and why each part earns its place:
 *
 * - Grouped by resource, because scopes are chosen per resource ("this token
 *   handles DNS"), never alphabetically.
 * - One line per scope saying what it grants, so the picker answers the
 *   question the operator actually has.
 * - Search across scope, description and group, because forty-seven entries is
 *   past the point where scanning works.
 * - A running summary of what the selection can do, so the answer to "what can
 *   this token actually do" is visible before it is issued rather than after.
 * - Sensitive scopes marked, because "terminal:open" and "task:run" read as
 *   mild and are shell access on a node.
 * - The inconsistencies in the model itself surfaced rather than hidden, since
 *   a picker that quietly implies every resource has a read/admin pair is
 *   lying about six of them.
 */
import { computed, ref } from "vue";

import Badge from "@/components/ui/badge/Badge.vue";
import Checkbox from "@/components/ui/checkbox/Checkbox.vue";
import Input from "@/components/ui/input/Input.vue";
import { cn } from "@/lib/utils";
import { SCOPE_GROUPS, SCOPE_INDEX, SCOPE_MODEL_GAPS, type ScopeEntry } from "@/lib/scopes";

const props = defineProps<{
  /** Currently selected scopes. */
  modelValue: string[];
  /** Scopes this caller may actually grant. Anything outside is not offered. */
  grantable: readonly string[];
  /** Set when the form's own validation has failed, to tint the border. */
  invalid?: boolean;
}>();

const emit = defineEmits<{ (e: "update:modelValue", value: string[]): void }>();

const query = ref("");
const showGaps = ref(false);

const grantableSet = computed(() => new Set(props.grantable));
const selectedSet = computed(() => new Set(props.modelValue));

function matches(entry: ScopeEntry, group: { label: string; id: string }): boolean {
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.scope.toLowerCase().includes(q) ||
    entry.grants.toLowerCase().includes(q) ||
    (entry.note?.toLowerCase().includes(q) ?? false) ||
    group.label.toLowerCase().includes(q) ||
    group.id.includes(q)
  );
}

/** Groups reduced to the scopes this caller may grant and that match the search. */
const visibleGroups = computed(() =>
  SCOPE_GROUPS.map((group) => ({
    ...group,
    scopes: group.scopes.filter((entry) => grantableSet.value.has(entry.scope) && matches(entry, group)),
  })).filter((group) => group.scopes.length > 0),
);

const noResults = computed(() => visibleGroups.value.length === 0);

function toggle(scope: string) {
  const next = new Set(props.modelValue);
  if (next.has(scope)) next.delete(scope);
  else next.add(scope);
  emit("update:modelValue", [...next]);
}

function groupState(scopes: readonly ScopeEntry[]): "none" | "some" | "all" {
  const chosen = scopes.filter((entry) => selectedSet.value.has(entry.scope)).length;
  if (chosen === 0) return "none";
  return chosen === scopes.length ? "all" : "some";
}

/**
 * Select-all is per group and only ever touches the scopes currently shown, so
 * it can never quietly grant something filtered out of view by the search.
 */
function toggleGroup(scopes: readonly ScopeEntry[]) {
  const next = new Set(props.modelValue);
  if (groupState(scopes) === "all") {
    for (const entry of scopes) next.delete(entry.scope);
  } else {
    for (const entry of scopes) next.add(entry.scope);
  }
  emit("update:modelValue", [...next]);
}

/** The selection read back as capability, grouped, so it can be checked at a glance. */
const summary = computed(() => {
  const byGroup = new Map<string, { label: string; entries: ScopeEntry[] }>();
  for (const scope of props.modelValue) {
    const entry = SCOPE_INDEX.get(scope);
    if (!entry) continue;
    const bucket = byGroup.get(entry.groupId) ?? { label: entry.groupLabel, entries: [] };
    bucket.entries.push(entry);
    byGroup.set(entry.groupId, bucket);
  }
  return [...byGroup.values()].map((bucket) => ({
    label: bucket.label,
    entries: bucket.entries.sort((a, b) => a.scope.localeCompare(b.scope)),
  }));
});

const sensitiveChosen = computed(() =>
  props.modelValue.map((scope) => SCOPE_INDEX.get(scope)).filter((entry) => entry?.sensitive),
);
</script>

<template>
  <div class="grid gap-2">
    <Input
      v-model="query"
      type="search"
      placeholder="Search scopes, for example dns, terminal, or read"
      class="h-8"
      aria-label="Search scopes"
    />

    <div
      :class="
        cn(
          'max-h-80 overflow-auto rounded-md border border-border',
          invalid && 'border-destructive',
        )
      "
    >
      <p v-if="noResults" class="px-3 py-6 text-center text-xs text-muted-foreground">
        No grantable scope matches that search.
      </p>

      <section
        v-for="group in visibleGroups"
        :key="group.id"
        class="border-b border-border last:border-b-0"
      >
        <header
          class="sticky top-0 z-10 flex items-baseline justify-between gap-3 bg-muted/60 px-3 py-2 backdrop-blur-none"
        >
          <div class="min-w-0">
            <h4 class="text-xs font-semibold tracking-wide">{{ group.label }}</h4>
            <p class="truncate text-xs text-muted-foreground">{{ group.summary }}</p>
          </div>
          <button
            type="button"
            class="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            @click="toggleGroup(group.scopes)"
          >
            {{ groupState(group.scopes) === "all" ? "Clear" : "Select all" }}
          </button>
        </header>

        <label
          v-for="entry in group.scopes"
          :key="entry.scope"
          class="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-muted/40"
        >
          <Checkbox
            class="mt-0.5 shrink-0"
            :model-value="selectedSet.has(entry.scope)"
            @update:model-value="toggle(entry.scope)"
          />
          <span class="min-w-0">
            <span class="flex flex-wrap items-center gap-2">
              <code class="font-mono text-xs">{{ entry.scope }}</code>
              <Badge v-if="entry.sensitive" variant="outline" class="h-4 px-1 text-[10px] uppercase">
                Sensitive
              </Badge>
            </span>
            <span class="block text-xs text-muted-foreground">{{ entry.grants }}</span>
            <span v-if="entry.note" class="block text-xs text-muted-foreground/80">{{ entry.note }}</span>
          </span>
        </label>
      </section>
    </div>

    <!-- What the selection can actually do, before it is issued. -->
    <div v-if="summary.length" class="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p class="text-xs font-semibold">This grant allows</p>
      <ul class="mt-1 grid gap-1">
        <li v-for="bucket in summary" :key="bucket.label" class="text-xs">
          <span class="font-medium">{{ bucket.label }}:</span>
          <span class="text-muted-foreground">
            {{ bucket.entries.map((entry) => entry.grants).join(" ") }}
          </span>
        </li>
      </ul>
      <p v-if="sensitiveChosen.length" class="mt-2 text-xs">
        <span class="font-medium">{{ sensitiveChosen.length }} sensitive</span>
        <span class="text-muted-foreground">
          scope{{ sensitiveChosen.length === 1 ? "" : "s" }} selected:
          {{ sensitiveChosen.map((entry) => entry?.scope).join(", ") }}
        </span>
      </p>
    </div>

    <!-- The model's own inconsistencies, stated rather than left to be discovered. -->
    <div class="text-xs">
      <button
        type="button"
        class="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        @click="showGaps = !showGaps"
      >
        {{ showGaps ? "Hide" : "Show" }} where the read and admin split is not consistent
      </button>
      <ul v-if="showGaps" class="mt-1 grid gap-1 text-muted-foreground">
        <li v-for="gap in SCOPE_MODEL_GAPS" :key="gap">{{ gap }}</li>
      </ul>
    </div>
  </div>
</template>
