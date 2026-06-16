<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { TabsContent, type TabsContentProps, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<TabsContentProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
  <TabsContent
    data-slot="tabs-content"
    v-bind="forwarded"
    :class="cn('flex-1 outline-none', props.class)"
  >
    <slot />
  </TabsContent>
</template>
