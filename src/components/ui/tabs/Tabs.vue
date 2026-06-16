<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { TabsRoot, type TabsRootEmits, type TabsRootProps, useForwardPropsEmits } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<TabsRootProps & { class?: HTMLAttributes["class"] }>();
const emits = defineEmits<TabsRootEmits>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <TabsRoot
    data-slot="tabs"
    v-bind="forwarded"
    :class="cn('flex flex-col gap-2', props.class)"
  >
    <slot />
  </TabsRoot>
</template>
