<script setup lang="ts">
/**
 * A node, by name (design 23, section 3.10). Never the raw `node_...` id
 * where the page knows the name: Approvals targets and Audit rows printed ids
 * while every other page printed names.
 *
 * The name comes from the `nodes` prop or from the page's node directory
 * (provideNodeDirectory). An id the page does not know shows shortened, in
 * mono, with the full id in its title, so it still reads as an identifier
 * rather than a name. `link` makes it a link to the node's page.
 */
import { computed } from "vue";
import { RouterLink } from "vue-router";

import { useNodeDirectory } from "@/composables/useNodeDirectory";
import { cn } from "@/lib/utils";
import { nodeDisplay, type NodeRef } from "./chassisModel";

const props = withDefaults(
  defineProps<{
    id: string;
    nodes?: readonly NodeRef[];
    link?: boolean;
    class?: string;
  }>(),
  { nodes: undefined, link: false, class: undefined },
);

const directory = useNodeDirectory();
const display = computed(() => nodeDisplay(props.id, props.nodes ?? directory?.value));
const title = computed(() => (display.value.text === props.id ? undefined : props.id));
</script>

<template>
  <RouterLink
    v-if="link && id"
    :to="{ name: 'node-detail', params: { id } }"
    :title="title"
    :class="cn('min-w-0 truncate rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring', !display.known && 'font-mono text-muted-foreground', props.class)"
    data-testid="node-label"
  >
    {{ display.text }}
  </RouterLink>
  <span
    v-else
    :title="title"
    :class="cn('min-w-0 truncate', !display.known && 'font-mono text-muted-foreground', props.class)"
    data-testid="node-label"
  >
    {{ display.text }}
  </span>
</template>
