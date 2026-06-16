<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { SelectScrollUpButton, type SelectScrollUpButtonProps, useForwardProps } from "reka-ui";
import { ChevronUp } from "lucide-vue-next";
import { cn } from "@/lib/utils";

const props = defineProps<SelectScrollUpButtonProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <SelectScrollUpButton
    data-slot="select-scroll-up-button"
    v-bind="forwarded"
    :class="cn('flex cursor-default items-center justify-center py-1', props.class)"
  >
    <slot>
      <ChevronUp class="size-4" />
    </slot>
  </SelectScrollUpButton>
</template>
