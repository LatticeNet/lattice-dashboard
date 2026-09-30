<script setup lang="ts">
/**
 * Attention (design 23, section 3.2; design 22, section 2, rule 1): what is
 * wrong, the row that proves it, and the action that clears it.
 *
 *   ! DMIT-4 offline 6d        last report 2026-09-24 03:10     [Open]
 *
 * Renders nothing when empty: a list that says "nothing needs attention"
 * above every page is a banner the operator learns to skip. Worst first;
 * beyond `max`, "Show all N". Information items are listed but never counted
 * (attentionModel).
 */
import { computed, ref } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { AlertTriangle, Info, OctagonAlert } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ATTENTION_DEFAULT_MAX, attentionView, type AttentionItem as ModelItem } from "./attentionModel";

export interface AttentionItem extends ModelItem {
  action?: { label: string; to?: RouteLocationRaw; run?: () => void };
}

const props = withDefaults(defineProps<{ items: AttentionItem[]; max?: number; title?: string }>(), {
  max: ATTENTION_DEFAULT_MAX,
  title: undefined,
});

const expanded = ref(false);
const view = computed(() => attentionView(props.items, props.max, expanded.value));

const ICON = { danger: OctagonAlert, warning: AlertTriangle, info: Info } as const;
const ICON_TONE = { danger: "text-destructive", warning: "text-warning-text", info: "text-muted-foreground" } as const;
</script>

<template>
  <section
    v-if="view.total > 0"
    class="overflow-hidden rounded-lg border border-border bg-card"
    :aria-label="title ?? $t('common.attention.title')"
    data-testid="attention-list"
  >
    <h2 class="border-b border-border px-3.5 py-2 text-xs font-medium text-muted-foreground">
      {{ title ?? $t('common.attention.title') }}
    </h2>
    <ul class="divide-y divide-border">
      <li
        v-for="item in view.shown"
        :key="item.key"
        class="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3"
        :data-tone="item.tone"
      >
        <div class="flex min-w-0 flex-1 items-start gap-2.5">
          <component :is="ICON[item.tone]" :class="cn('mt-0.5 size-4 shrink-0', ICON_TONE[item.tone])" aria-hidden="true" />
          <div class="min-w-0">
            <p class="text-sm text-foreground">
              <span class="sr-only">{{ $t(`common.attention.tone.${item.tone}`) }}: </span>{{ item.claim }}
            </p>
            <p v-if="item.proof" class="mt-0.5 break-words font-mono text-xs text-muted-foreground">{{ item.proof }}</p>
          </div>
        </div>
        <div v-if="item.action" class="shrink-0 ps-6.5 sm:ps-0">
          <Button v-if="item.action.to" variant="outline" size="sm" as-child>
            <RouterLink :to="item.action.to">{{ item.action.label }}</RouterLink>
          </Button>
          <Button v-else variant="outline" size="sm" type="button" @click="item.action.run?.()">
            {{ item.action.label }}
          </Button>
        </div>
      </li>
    </ul>
    <div v-if="view.hidden > 0 || expanded" class="border-t border-border px-3.5 py-1.5">
      <Button variant="ghost" size="sm" type="button" class="-ms-2" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? $t('common.attention.showFewer') : $t('common.attention.showAll', { n: view.total }) }}
      </Button>
    </div>
  </section>
</template>
