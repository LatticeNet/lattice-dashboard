<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { SelectLabel, type SelectLabelProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<SelectLabelProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <SelectLabel
    data-slot="select-label"
    v-bind="forwarded"
    :class="cn('text-muted-foreground px-2 py-1.5 text-xs', props.class)"
  >
    <slot />
  </SelectLabel>
</template>
