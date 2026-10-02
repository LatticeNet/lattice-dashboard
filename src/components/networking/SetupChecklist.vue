<script setup lang="ts">
/**
 * The empty state of a networking page that needs something in place first
 * (design 23, section 4.4): what is needed, checked against live state.
 *
 *   0 of 1 prerequisites ready
 *   x  A node that runs self-host DNS     no resolver is registered   [Self-host DNS]
 *
 * Each item is ready, missing, or not checked (its read failed or the
 * session cannot read it); a prerequisite that was not read never shows as
 * missing, and never as ready. The default slot holds the page's create
 * actions; a `description` slot replaces the description prop when the copy
 * carries markup (a path set as code).
 *
 * The summary counts ready items over the items that were checked and names
 * the ones that were not ("2 of 2 checked ready · 1 not checked"), so an
 * item the console cannot see or could not read is never counted as not
 * ready; with nothing checked it says only that.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { Check, CircleDashed, X } from "lucide-vue-next";

import { cn } from "@/lib/utils";

export interface SetupItem {
  key: string;
  label: string;
  /** true ready, false missing, null not checked. */
  ready: boolean | null;
  /** What the live read found ("32 of 34 nodes online", "no resolver is registered"). */
  detail?: string;
  /** Where the missing piece is made. */
  action?: { label: string; to: RouteLocationRaw };
}

const props = defineProps<{
  title: string;
  description?: string;
  items: SetupItem[];
}>();

const { t } = useI18n();

const ready = computed(() => props.items.filter((item) => item.ready === true).length);
const total = computed(() => props.items.length);
const unchecked = computed(() => props.items.filter((item) => item.ready === null).length);
const summary = computed(() => {
  if (!unchecked.value) return t("networking.setup.summary", { ready: ready.value, total: total.value }, total.value);
  if (unchecked.value === total.value) return t("networking.setup.summaryNone", { total: total.value }, total.value);
  const checked = total.value - unchecked.value;
  return t("networking.setup.summaryPartial", { ready: ready.value, checked, unchecked: unchecked.value });
});
</script>

<template>
  <section class="space-y-4 rounded-xl border border-dashed border-border p-4 sm:p-6" data-testid="setup-checklist">
    <div class="space-y-1">
      <h2 class="text-base font-medium text-foreground">{{ title }}</h2>
      <div v-if="$slots.description" class="max-w-prose text-sm text-muted-foreground"><slot name="description" /></div>
      <p v-else-if="description" class="max-w-prose text-sm text-muted-foreground">{{ description }}</p>
    </div>
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground" data-testid="setup-summary">{{ summary }}</p>
      <ul class="divide-y divide-border rounded-md border border-border">
        <li v-for="item in items" :key="item.key" class="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
          <component
            :is="item.ready === true ? Check : item.ready === false ? X : CircleDashed"
            :class="
              cn(
                'mt-0.5 size-4 shrink-0',
                item.ready === true ? 'text-success' : item.ready === false ? 'text-warning-text' : 'text-muted-foreground',
              )
            "
            aria-hidden="true"
          />
          <div class="min-w-[12rem] flex-1">
            <p class="text-foreground">
              {{ item.label }}
              <span class="sr-only">({{ $t(`networking.setup.${item.ready === true ? 'ready' : item.ready === false ? 'missing' : 'unchecked'}`) }})</span>
            </p>
            <p v-if="item.detail" class="text-xs text-muted-foreground">{{ item.detail }}</p>
          </div>
          <RouterLink
            v-if="item.action && item.ready !== true"
            :to="item.action.to"
            class="ms-7 text-xs text-primary underline-offset-4 hover:underline sm:ms-0"
          >
            {{ item.action.label }}
          </RouterLink>
        </li>
      </ul>
    </div>
    <div v-if="$slots.default" class="flex flex-wrap gap-2">
      <slot />
    </div>
  </section>
</template>
