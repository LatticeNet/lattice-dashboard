<script setup lang="ts" generic="T extends string">
/**
 * The page's one layer row (design 23, section 3.4; design 22, section 2,
 * rule 2): an underline tab row, one per page, mirrored in `?view=` through
 * useLayer. Segmented pills stay for modes inside a layer (a lens, a
 * group-by), so a layer and a mode never look alike.
 *
 * At phone width the row scrolls sideways inside its own strip, edge to
 * edge, and the current layer is scrolled into view. Arrow keys move between
 * layers and Enter opens one (manual activation), so moving focus across the
 * row does not push a history entry per key press.
 */
import { nextTick, onMounted, ref, watch } from "vue";
import { TabsList, TabsRoot, TabsTrigger } from "reka-ui";

import { cn } from "@/lib/utils";

export interface LayerTab<V extends string = string> {
  value: V;
  label: string;
  /** A count beside the label ("Needs you 3"); shown only when defined. */
  count?: number | string;
  /** Tints the count when it asks for action. */
  tone?: "default" | "warning" | "destructive";
}

const props = defineProps<{
  tabs: LayerTab<T>[];
  /** Accessible name for the row ("Evidence layers"). */
  label: string;
  class?: string;
}>();

const model = defineModel<T>({ required: true });

const strip = ref<HTMLElement | null>(null);

function revealActive(): void {
  const active = strip.value?.querySelector<HTMLElement>('[data-state="active"]');
  active?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

onMounted(revealActive);
watch(model, () => nextTick(revealActive));

const COUNT_TONE = { default: "text-muted-foreground", warning: "text-warning-text", destructive: "text-destructive" } as const;
</script>

<template>
  <TabsRoot v-model="model" activation-mode="manual" :class="props.class">
    <div ref="strip" class="-mx-4 relative overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <TabsList
        :aria-label="label"
        class="flex w-max min-w-full items-stretch gap-1 border-b border-border"
        data-testid="layer-tabs"
      >
        <TabsTrigger
          v-for="tab in tabs"
          :key="tab.value"
          :value="tab.value"
          :class="
            cn(
              'relative -mb-px inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground outline-none transition-colors',
              'hover:text-foreground focus-visible:rounded-t-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              'data-[state=active]:border-primary data-[state=active]:text-foreground',
            )
          "
        >
          {{ tab.label }}
          <span v-if="tab.count !== undefined" :class="cn('font-mono text-xs tabular', COUNT_TONE[tab.tone ?? 'default'])">{{ tab.count }}</span>
        </TabsTrigger>
      </TabsList>
    </div>
  </TabsRoot>
</template>
