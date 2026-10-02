<script setup lang="ts" generic="T extends string">
/**
 * The page's one layer row (design 23, section 3.4; design 22, section 2,
 * rule 2), mirrored in `?view=` through useLayer, on its own line above the
 * toolbar.
 *
 * From 620 px up it is an underline tab row. Below 620 px it is a segmented
 * control: a filled track with the current layer raised on it, so the layer
 * reads as a choice between places rather than a row of links at phone
 * width (the wave 1 design review decision). Segmented pills inside a layer
 * (a lens, a group-by) stay smaller and unfilled, so a layer and a mode
 * never look alike. No icons in either form.
 *
 * When the layers do not fit, the row scrolls sideways inside its own strip,
 * edge to edge, and the strip scrolls sideways until the current layer sits
 * clear of the page gutter. The page itself never moves: a layer that
 * settles after a read must not scroll the operator away from the head.
 * Arrow keys move between layers and Enter opens one (manual
 * activation), so moving focus across the row does not push a history entry
 * per key press. On a coarse pointer every layer is at least 44 px tall.
 *
 * A count rides beside the label as a pill (10 px, weight 650), tinted only
 * when it asks for action.
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

/**
 * Scroll the strip, and only the strip, until the current layer sits clear of
 * its gutter. scrollIntoView would also scroll every scrolling ancestor: on a
 * phone, Approvals settles its default layer after the inbox is read, and
 * the reveal that followed moved the page's own scroller 686 px down, past
 * the title and the attention list.
 */
function revealActive(): void {
  const el = strip.value;
  const active = el?.querySelector<HTMLElement>('[data-state="active"]');
  if (!el || !active || el.scrollWidth <= el.clientWidth) return;
  const style = getComputedStyle(el);
  const padStart = parseFloat(style.scrollPaddingLeft) || 0;
  const padEnd = parseFloat(style.scrollPaddingRight) || 0;
  const box = el.getBoundingClientRect();
  const tab = active.getBoundingClientRect();
  const left = tab.left - box.left + el.scrollLeft;
  const right = left + tab.width;
  if (left - padStart < el.scrollLeft) el.scrollTo({ left: left - padStart });
  else if (right + padEnd > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right + padEnd - el.clientWidth });
}

onMounted(revealActive);
watch(model, () => nextTick(revealActive));

/*
 * A 10 px count sits on three grounds: the page (underline form), the
 * segmented track and the raised current segment. The theme's own inks
 * fell under 4.5:1 on at least one of them (light muted 4.3 on the track;
 * dark warning 4.2, destructive 3.2 and muted 3.3 on the lighter raised
 * segment), so each tone takes its own ink from the theme (--count-ink,
 * --count-ink-warning, --count-ink-destructive in app.css), measured on its
 * tint over all three: light 5.2 / 5.3 / 5.3, dark 5.3 / 5.5 / 5.1 at the
 * worst ground.
 */
const COUNT_TONE = {
  default: "bg-foreground/[0.07] text-count-ink",
  warning: "bg-warning/15 text-count-ink-warning",
  destructive: "bg-destructive/12 text-count-ink-destructive",
} as const;
</script>

<template>
  <TabsRoot v-model="model" activation-mode="manual" :class="props.class">
    <div ref="strip" class="-mx-4 relative scroll-px-4 overflow-x-auto px-4 sm:mx-0 sm:scroll-px-0 sm:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <TabsList
        :aria-label="label"
        :class="
          cn(
            'flex w-max min-w-full items-stretch gap-0.5 rounded-lg bg-muted p-0.5',
            'min-[620px]:gap-1 min-[620px]:rounded-none min-[620px]:border-b min-[620px]:border-border min-[620px]:bg-transparent min-[620px]:p-0',
          )
        "
        data-testid="layer-tabs"
      >
        <TabsTrigger
          v-for="tab in tabs"
          :key="tab.value"
          :value="tab.value"
          :class="
            cn(
              /* Segmented, below 620 px: equal shares of the track, the current one raised. */
              'relative inline-flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground outline-none transition-colors pointer-coarse:min-h-11',
              /* Four layers need about 370 px at full padding against 343 at 375; tighter segments fit them. */
              'max-[400px]:gap-1 max-[400px]:px-2',
              'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs',
              /* In dark mode --background is darker than the track, so the raised layer takes a lighter fill. */
              'dark:data-[state=active]:bg-input',
              /* Underline, from 620 px. */
              'min-[620px]:-mb-px min-[620px]:h-9 min-[620px]:flex-none min-[620px]:justify-start min-[620px]:rounded-none min-[620px]:border-b-2 min-[620px]:border-transparent',
              'min-[620px]:focus-visible:rounded-t-sm min-[620px]:focus-visible:ring-inset',
              'min-[620px]:data-[state=active]:border-primary min-[620px]:data-[state=active]:bg-transparent min-[620px]:dark:data-[state=active]:bg-transparent min-[620px]:data-[state=active]:shadow-none',
            )
          "
        >
          {{ tab.label }}
          <span
            v-if="tab.count !== undefined"
            :class="cn('inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1.5 text-[10px] leading-none font-[650] tabular-nums', COUNT_TONE[tab.tone ?? 'default'])"
            data-testid="layer-count"
          >{{ tab.count }}</span>
        </TabsTrigger>
      </TabsList>
    </div>
  </TabsRoot>
</template>
