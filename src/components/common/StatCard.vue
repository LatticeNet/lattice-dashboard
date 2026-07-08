<script setup lang="ts">
import { computed, type Component, type HTMLAttributes } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { ArrowUpRight } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

type Tone = "default" | "success" | "warning" | "destructive";
type HintPlacement = "inline" | "bottom";

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    icon?: Component;
    hint?: string;
    tone?: Tone;
    hintPlacement?: HintPlacement;
    /** When set, the whole card becomes a drill-through link to this route. */
    to?: RouteLocationRaw;
    class?: HTMLAttributes["class"];
  }>(),
  {
    tone: "default",
    hintPlacement: "inline",
  },
);

const valueToneClass = computed(() => {
  switch (props.tone) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "destructive":
      return "text-destructive";
    default:
      return "text-foreground";
  }
});

const iconToneClass = computed(() => {
  switch (props.tone) {
    case "success":
      return "bg-success/10 text-success";
    case "warning":
      return "bg-warning/10 text-warning";
    case "destructive":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-accent text-accent-foreground";
  }
});

const hintAtBottom = computed(() => props.hintPlacement === "bottom");
</script>

<template>
  <component
    :is="to ? RouterLink : 'div'"
    :to="to"
    :class="cn(
      'group block',
      to && 'rounded-xl focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
    )"
  >
    <Card :class="cn('relative overflow-hidden', to && 'surface-interactive', props.class)">
      <CardContent :class="cn('flex items-start gap-3 p-4', hintAtBottom && 'h-full')">
        <div
          v-if="icon"
          :class="cn('flex shrink-0 items-center justify-center rounded-lg p-2', iconToneClass)"
        >
          <component :is="icon" class="size-4" />
        </div>
        <div :class="cn('min-w-0', hintAtBottom ? 'flex h-full flex-1 flex-col' : 'space-y-1')">
          <p class="text-sm text-muted-foreground">{{ label }}</p>
          <div v-if="!hintAtBottom" class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <p :class="cn('text-2xl font-semibold tabular leading-none', valueToneClass)">
              {{ value }}
            </p>
            <p v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</p>
          </div>
          <p v-else :class="cn('mt-1 truncate text-2xl font-semibold tabular leading-none', valueToneClass)">
            {{ value }}
          </p>
          <p v-if="hintAtBottom && hint" class="mt-auto truncate text-xs text-muted-foreground">{{ hint }}</p>
        </div>
        <ArrowUpRight
          v-if="to"
          class="absolute right-3 top-3 size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-70"
          aria-hidden="true"
        />
      </CardContent>
    </Card>
  </component>
</template>
