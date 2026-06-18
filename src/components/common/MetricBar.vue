<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { formatBytes, formatPercent, ratio } from "@/lib/format";
import { Progress } from "@/components/ui/progress";

type Tone = "cpu" | "memory" | "disk" | "net" | "primary";

const props = withDefaults(
  defineProps<{
    label?: string;
    percent?: number;
    used?: number;
    total?: number;
    tone?: Tone;
    class?: HTMLAttributes["class"];
  }>(),
  {
    tone: "primary",
  },
);

const TONE_COLORS: Record<Tone, string> = {
  cpu: "var(--chart-2)",
  memory: "var(--chart-3)",
  disk: "var(--chart-4)",
  net: "var(--chart-5)",
  primary: "var(--primary)",
};

const pct = computed(() => {
  if (props.percent !== undefined && props.percent !== null) {
    return Math.min(100, Math.max(0, props.percent));
  }
  return ratio(props.used, props.total);
});

const hasBytes = computed(
  () => props.used !== undefined && props.total !== undefined,
);

const valueText = computed(() => {
  if (hasBytes.value) {
    return `${formatBytes(props.used)} / ${formatBytes(props.total)}`;
  }
  return formatPercent(pct.value);
});

const toneColor = computed(() => TONE_COLORS[props.tone]);
</script>

<template>
  <div :class="cn('space-y-1', props.class)">
    <div class="flex items-center justify-between gap-2">
      <span
        v-if="label"
        class="text-xs text-muted-foreground"
      >
        {{ label }}
      </span>
      <span class="ml-auto font-mono tabular text-xs text-foreground">
        {{ valueText }}
      </span>
    </div>
    <Progress
      :model-value="pct"
      :class="
        cn(
          'h-1.5',
          '[&_[data-slot=progress-indicator]]:[background:var(--tone)]',
        )
      "
      :style="{ '--tone': toneColor }"
    />
  </div>
</template>
