<script setup lang="ts">
/**
 * TableColumnManager — toolbar button + small anchored panel for toggling a
 * table's optional columns. State lives with the caller (which persists it);
 * this component only renders the catalog and re-emits toggles. No popover
 * primitive exists in components/ui, so the panel is a locally positioned
 * card with click-outside and Escape dismissal, matching the app's other
 * hand-rolled anchored panels.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Columns3 } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const props = defineProps<{
  /** Optional columns in display order: id + already-translated label. */
  columns: { id: string; label: string }[];
  /** Ids currently hidden. */
  hidden: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  (e: "toggle", id: string): void;
  (e: "reset"): void;
}>();

const open = ref(false);
const root = ref<HTMLElement>();

function onDocumentPointerDown(event: PointerEvent) {
  if (!open.value) return;
  if (root.value && event.target instanceof Node && !root.value.contains(event.target)) {
    open.value = false;
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});

const anyHidden = () => props.columns.some((c) => props.hidden.has(c.id));
</script>

<template>
  <div ref="root" class="relative">
    <Button
      variant="outline"
      size="sm"
      :aria-expanded="open"
      :aria-label="$t('common.table.columns')"
      @click="open = !open"
    >
      <Columns3 class="size-4" aria-hidden="true" />
      <span class="hidden sm:inline">{{ $t('common.table.columns') }}</span>
    </Button>

    <div
      v-if="open"
      class="absolute right-0 z-30 mt-1 w-56 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md"
      role="group"
      :aria-label="$t('common.table.columns')"
    >
      <label
        v-for="column in columns"
        :key="column.id"
        class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60"
      >
        <Checkbox
          :model-value="!hidden.has(column.id)"
          @update:model-value="emit('toggle', column.id)"
        />
        <span class="truncate">{{ column.label }}</span>
      </label>
      <div class="mt-1 border-t border-border pt-1">
        <Button
          variant="ghost"
          size="sm"
          class="w-full justify-start text-muted-foreground"
          :disabled="!anyHidden()"
          @click="emit('reset')"
        >
          {{ $t('common.table.showAll') }}
        </Button>
      </div>
    </div>
  </div>
</template>
