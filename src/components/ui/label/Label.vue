<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { Label, type LabelProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<LabelProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <Label
    data-slot="label"
    v-bind="forwarded"
    :class="
      cn(
        'flex select-none items-center gap-2 text-sm font-medium leading-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        props.class,
      )
    "
  >
    <slot />
  </Label>
</template>
