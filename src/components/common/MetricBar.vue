<script setup lang="ts">
import { computed, ref, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { NO_VALUE, formatBytes, formatPercent, ratio } from "@/lib/format";
import { Progress } from "@/components/ui/progress";

type Tone = "cpu" | "memory" | "disk" | "net" | "primary";

const props = withDefaults(
  defineProps<{
    label?: string;
    percent?: number;
    used?: number;
    total?: number;
    tone?: Tone;
    /** Overrides the derived reading. Was passed by three call sites for a
     *  year while this component had no such prop and dropped it into
     *  `$attrs`, which is how a node with no sample printed "0%". */
    valueText?: string;
    /** The node is not in contact and never produced this sample. */
    unavailable?: boolean;
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

/**
 * Nothing was measured, so there is nothing to print.
 *
 * `ratio()` answers 0 for a missing used/total pair and `percent ?? 0` answers
 * 0 for a missing percent, so a node that has never reported used to read
 * "0% / 0% / 0%" next to a "-" for its network rate: three confident zeroes and
 * one honest blank for the same absence. A missing reading is `NO_VALUE`, the
 * same mark every other formatter in `@/lib/format` uses.
 */
const unavailable = computed(
  () =>
    props.unavailable === true ||
    (props.percent === undefined && props.used === undefined && props.total === undefined),
);

const pct = computed(() => {
  if (unavailable.value) return 0;
  if (props.percent !== undefined && props.percent !== null) {
    return Math.min(100, Math.max(0, props.percent));
  }
  return ratio(props.used, props.total);
});

const hasBytes = computed(
  () => props.used !== undefined && props.total !== undefined,
);

const valueText = computed(() => {
  if (unavailable.value) return NO_VALUE;
  if (props.valueText) return props.valueText;
  if (hasBytes.value) {
    return `${formatBytes(props.used)} / ${formatBytes(props.total)}`;
  }
  return formatPercent(pct.value);
});

const toneColor = computed(() => TONE_COLORS[props.tone]);

// The native tooltip is the escape hatch for a value too wide for its track,
// so it is bound only when the text is actually cut. Binding it always put a
// tooltip on every cell in the table repeating what was already on screen,
// and gave an unavailable cell a title of "-" that said nothing. Measured on
// hover rather than on render: the width that matters is the one the column
// has at that moment, and this component is used at several track widths.
const valueEl = ref<HTMLElement | null>(null);
const overflowing = ref(false);
const measureOverflow = () => {
  const el = valueEl.value;
  overflowing.value = el ? el.scrollWidth > el.clientWidth : false;
};
</script>

<template>
  <div :class="cn('space-y-1', props.class)">
    <div class="flex min-w-0 items-center justify-between gap-2">
      <span
        v-if="label"
        class="shrink-0 text-xs text-muted-foreground"
      >
        {{ label }}
      </span>
      <span
        ref="valueEl"
        :title="overflowing ? valueText : undefined"
        @mouseenter="measureOverflow"
        @focusin="measureOverflow"
        :class="
          cn(
            'ml-auto min-w-0 truncate whitespace-nowrap font-mono tabular text-xs',
            unavailable ? 'text-muted-foreground' : 'text-foreground',
          )
        "
      >
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
