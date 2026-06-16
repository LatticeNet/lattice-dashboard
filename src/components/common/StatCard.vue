<script setup lang="ts">
import { computed, type Component, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

type Tone = "default" | "success" | "warning" | "destructive";

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    icon?: Component;
    hint?: string;
    tone?: Tone;
    class?: HTMLAttributes["class"];
  }>(),
  {
    tone: "default",
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
</script>

<template>
  <Card :class="cn('overflow-hidden', props.class)">
    <CardContent class="flex items-start gap-3 p-4">
      <div
        v-if="icon"
        :class="cn('flex shrink-0 items-center justify-center rounded-lg p-2', iconToneClass)"
      >
        <component :is="icon" class="size-4" />
      </div>
      <div class="min-w-0 space-y-1">
        <p class="text-sm text-muted-foreground">{{ label }}</p>
        <p :class="cn('text-2xl font-semibold tabular leading-none', valueToneClass)">
          {{ value }}
        </p>
        <p v-if="hint" class="text-xs text-muted-foreground">{{ hint }}</p>
      </div>
    </CardContent>
  </Card>
</template>
