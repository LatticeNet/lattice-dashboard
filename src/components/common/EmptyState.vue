<script setup lang="ts">
import { computed, useSlots, type Component, type HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
import { CheckCircle2 } from "lucide-vue-next";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    icon?: Component;
    title?: string;
    description?: string;
    /** Visual tone: 'default' keeps the neutral dashed look; 'positive' applies a subtle success treatment. */
    tone?: "default" | "positive";
    /**
     * Ordered prerequisites, rendered as a numbered list under the
     * description. A feature with nothing authored yet has an empty state that
     * either teaches the loop or wastes the screen; seeding fake data to make
     * it look busy is the alternative, and on a control plane that drives real
     * nodes it is the wrong one.
     */
    steps?: { title: string; detail: string }[];
    class?: HTMLAttributes["class"];
  }>(),
  {
    tone: "default",
  },
);

const slots = useSlots();
const { t } = useI18n();

/** Caller-provided title, falling back to the shared default. */
const resolvedTitle = computed(() => props.title ?? t("common.state.nothingHere"));

/** Whether the success treatment is active. */
const isPositive = computed(() => props.tone === "positive");

/** Icon to render: caller's icon wins, else a success check for the positive tone. */
const resolvedIcon = computed<Component | undefined>(
  () => props.icon ?? (isPositive.value ? CheckCircle2 : undefined),
);
</script>

<template>
  <div
    :class="
      cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center sm:p-10',
        isPositive ? 'border-success/30' : 'border-border',
        props.class,
      )
    "
  >
    <div
      v-if="resolvedIcon"
      :class="
        cn(
          'flex items-center justify-center rounded-full p-3',
          isPositive ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
        )
      "
    >
      <component :is="resolvedIcon" class="size-5" />
    </div>
    <div class="space-y-1">
      <p
        :class="
          cn(
            'text-sm font-medium',
            isPositive ? 'text-success' : 'text-foreground',
          )
        "
      >
        {{ resolvedTitle }}
      </p>
      <p v-if="description" class="text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <ol v-if="steps?.length" class="w-full max-w-xl space-y-3 text-left">
      <li v-for="(step, index) in steps" :key="step.title" class="flex gap-3">
        <span
          class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular text-muted-foreground"
          aria-hidden="true"
        >{{ index + 1 }}</span>
        <span>
          <span class="block text-sm font-medium text-foreground">{{ step.title }}</span>
          <span class="block text-sm text-muted-foreground">{{ step.detail }}</span>
        </span>
      </li>
    </ol>
    <div v-if="slots.default" class="mt-1 flex items-center gap-2">
      <slot />
    </div>
  </div>
</template>
