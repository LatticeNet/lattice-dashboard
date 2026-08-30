<script setup lang="ts">
/**
 * FilterPanel: one toolbar button that owns every filter past the obvious ones.
 *
 * A list view accumulates filters faster than it accumulates anything else, and
 * the cheapest place to put a new one is another row under the toolbar. Do that
 * five times and the fleet list opens on five rows of controls with the first
 * data row below the fold - which is what the Nodes page had: a search row, a
 * capability chip row, three expression inputs, a fourteen-chip tag row, and a
 * count. Everything was reachable and nothing was scannable.
 *
 * The rule this encodes: the toolbar holds what an operator touches on most
 * visits (search, status, grouping, view). Everything else lives behind this
 * button, which carries a count so a filtered list can never look unfiltered.
 * Applied filters are then echoed as removable chips by the caller, so what is
 * on shows in the page, not only inside a panel nobody has open.
 *
 * State ownership stays with the caller. This renders a trigger, a panel, and
 * the dismissal behaviour; the slot decides what a filter is.
 *
 * No popover primitive exists in components/ui, so this is a locally positioned
 * card with click-outside and Escape dismissal, matching TableColumnManager and
 * the app's other hand-rolled anchored panels.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { SlidersHorizontal } from "lucide-vue-next";

import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    /** How many filters are currently applied. Drives the badge and the reset. */
    activeCount?: number;
    /** Accessible name for the trigger and the panel. */
    label: string;
    /** Label for the reset control; omitted when the caller has no reset. */
    clearLabel?: string;
  }>(),
  { activeCount: 0, clearLabel: undefined },
);

const emit = defineEmits<{ (e: "clear"): void }>();

const open = ref(false);
const root = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const trigger = ref<InstanceType<typeof Button>>();

function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) return;
  if (root.value && event.target instanceof Node && !root.value.contains(event.target)) {
    open.value = false;
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !open.value) return;
  open.value = false;
  // Escape from inside the panel must land somewhere predictable. Without this
  // the focus ring is left on a node that just left the document and the next
  // Tab restarts from the top of the page.
  const el = root.value?.querySelector<HTMLElement>("[data-filter-trigger]");
  el?.focus();
}

async function toggle() {
  open.value = !open.value;
  if (!open.value) return;
  // The panel is mostly inputs; opening it and leaving focus on the trigger
  // means a keyboard operator has to tab back through the whole toolbar.
  await nextTick();
  panel.value?.querySelector<HTMLElement>("input, button, [tabindex]")?.focus();
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div ref="root" class="relative">
    <Button
      ref="trigger"
      data-filter-trigger
      variant="outline"
      size="sm"
      :aria-expanded="open"
      :aria-label="label"
      @click="toggle"
    >
      <SlidersHorizontal class="size-4" aria-hidden="true" />
      <span class="hidden sm:inline">{{ label }}</span>
      <!-- The count is the whole point of collapsing the filters: a panel that
           hides an active filter without saying so turns an empty result into a
           mystery. -->
      <span
        v-if="activeCount > 0"
        class="ms-1 inline-flex min-w-4 items-center justify-center rounded-sm bg-primary px-1 text-[11px] font-medium tabular-nums text-primary-foreground"
      >{{ activeCount }}</span>
    </Button>

    <div
      v-if="open"
      ref="panel"
      class="absolute end-0 z-30 mt-1 max-h-[min(28rem,70vh)] w-80 space-y-3 overflow-y-auto rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-(--shadow-overlay)"
      role="group"
      :aria-label="label"
    >
      <slot />

      <div v-if="clearLabel" class="border-t border-border pt-2">
        <Button
          variant="ghost"
          size="sm"
          class="w-full justify-start text-muted-foreground"
          :disabled="activeCount === 0"
          @click="emit('clear')"
        >
          {{ clearLabel }}
        </Button>
      </div>
    </div>
  </div>
</template>
