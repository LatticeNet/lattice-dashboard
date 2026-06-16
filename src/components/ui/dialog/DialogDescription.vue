<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { DialogDescription, type DialogDescriptionProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<DialogDescriptionProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <DialogDescription
    data-slot="dialog-description"
    v-bind="forwarded"
    :class="cn('text-muted-foreground text-sm', props.class)"
  >
    <slot />
  </DialogDescription>
</template>
