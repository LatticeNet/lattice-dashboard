<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Primitive, type PrimitiveProps } from "reka-ui";
import { cn } from "@/lib/utils";
import { buttonVariants, type ButtonVariants } from ".";

interface Props extends PrimitiveProps {
  variant?: ButtonVariants["variant"];
  size?: ButtonVariants["size"];
  class?: HTMLAttributes["class"];
}

const props = withDefaults(defineProps<Props>(), { as: "button" });
</script>

<template>
  <!-- data-button-size lets the coarse-pointer rule in app.css find a text
       button by its size (44 px on touch) from the base layer, under every
       utility. Not data-slot: a menu or dialog trigger wrapping the button
       with as-child writes its own data-slot over it. -->
  <Primitive
    :as="as"
    :as-child="asChild"
    :data-button-size="size ?? 'default'"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
