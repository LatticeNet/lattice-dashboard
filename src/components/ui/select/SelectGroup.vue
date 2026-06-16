<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { SelectGroup, type SelectGroupProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<SelectGroupProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <SelectGroup
    data-slot="select-group"
    v-bind="forwarded"
    :class="cn('p-1', props.class)"
  >
    <slot />
  </SelectGroup>
</template>
