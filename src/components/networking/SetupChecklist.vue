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
 * The summary counts ready items over all items, so "1 of 2" with one item
 * not checked never claims the second is missing; the item says so itself.
 */
import { computed } from "vue";
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

const ready = computed(() => props.items.filter((item) => item.ready === true).length);
const total = computed(() => props.items.length);
</script>

<template>
  <section class="space-y-4 rounded-xl border border-dashed border-border p-4 sm:p-6" data-testid="setup-checklist">
    <div class="space-y-1">
      <h2 class="text-base font-medium text-foreground">{{ title }}</h2>
      <div v-if="$slots.description" class="max-w-prose text-sm text-muted-foreground"><slot name="description" /></div>
      <p v-else-if="description" class="max-w-prose text-sm text-muted-foreground">{{ description }}</p>
    </div>
    <div class="space-y-2">
      <p class="text-xs font-medium text-muted-foreground" data-testid="setup-summary">{{ $t('networking.setup.summary', { ready, total }, total) }}</p>
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
