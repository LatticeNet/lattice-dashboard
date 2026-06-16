<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Primitive } from "reka-ui";
import { cn } from "@/lib/utils";
import { badgeVariants, type BadgeVariants } from "./badgeVariants";

const props = withDefaults(
  defineProps<{
    variant?: BadgeVariants["variant"];
    as?: string;
    asChild?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { as: "span" },
);
</script>

<template>
  <Primitive
    data-slot="badge"
    :as="as"
    :as-child="asChild"
    :class="cn(badgeVariants({ variant }), props.class)"
  >
    <slot />
  </Primitive>
</template>
