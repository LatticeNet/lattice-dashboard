<script setup lang="ts">
/**
 * A status pill that can explain itself to somebody not using a mouse.
 *
 * The control plane sends a one-sentence `status_reason` with every node, and
 * for a while the console exposed it only as a `title` attribute on a plain
 * span. That is a hover affordance: a keyboard user could tab through the whole
 * fleet without ever learning why a node reads offline, and a screen reader
 * announced the word and nothing else.
 *
 * With a reason the pill becomes a real focusable trigger and the reason
 * becomes its tooltip, which reka wires to the trigger with `aria-describedby`
 * and opens on focus as well as hover. With no reason it stays an inert span,
 * because a control that carries nothing should not be in the tab order.
 *
 * Click and key events stop here: these pills sit inside rows and cards that
 * are themselves clickable, and reaching the explanation must not navigate.
 */
import type { HTMLAttributes } from "vue";

import { cn } from "@/lib/utils";
import type { BadgeVariant } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const props = defineProps<{
  /** The status word, already translated. */
  label: string;
  variant: BadgeVariant;
  /** The server's one-sentence account. Empty when it sent none. */
  reason?: string;
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <Tooltip v-if="props.reason">
    <TooltipTrigger as-child>
      <Badge
        as="button"
        type="button"
        :variant="props.variant"
        :class="cn('cursor-help focus-visible:outline-none', props.class)"
        @click.stop
        @keydown.enter.stop
        @keydown.space.stop
      >
        {{ props.label }}
      </Badge>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs text-pretty">{{ props.reason }}</TooltipContent>
  </Tooltip>
  <Badge v-else :variant="props.variant" :class="props.class">{{ props.label }}</Badge>
</template>
