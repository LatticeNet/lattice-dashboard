<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { DialogTitle, type DialogTitleProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<DialogTitleProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <DialogTitle
    data-slot="dialog-title"
    v-bind="forwarded"
    :class="cn('text-lg leading-none font-semibold', props.class)"
  >
    <slot />
  </DialogTitle>
</template>
