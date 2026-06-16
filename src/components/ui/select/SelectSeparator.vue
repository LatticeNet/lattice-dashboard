<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { SelectSeparator, type SelectSeparatorProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<SelectSeparatorProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <SelectSeparator
    data-slot="select-separator"
    v-bind="forwarded"
    :class="cn('bg-border pointer-events-none -mx-1 my-1 h-px', props.class)"
  />
</template>
