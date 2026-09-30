<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { DropdownMenuSeparator, type DropdownMenuSeparatorProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<DropdownMenuSeparatorProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <DropdownMenuSeparator
    data-slot="dropdown-menu-separator"
    v-bind="forwarded"
    :class="cn('bg-border -mx-1 my-1 h-px', props.class)"
  />
</template>
