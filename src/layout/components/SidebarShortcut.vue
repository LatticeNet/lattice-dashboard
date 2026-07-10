<script setup lang="ts">
import { RouterLink } from "vue-router";
import { PinOff } from "lucide-vue-next";

/** A live, authorized destination explicitly pinned by the operator. */
export type ShortcutTarget = {
  id: string;
  title: string;
  path: string;
  section: string;
};

defineProps<{ target: ShortcutTarget }>();

const emit = defineEmits<{
  (e: "toggle-pin", id: string): void;
  (e: "navigate"): void;
}>();
</script>

<template>
  <div class="group/shortcut relative flex items-center rounded-md hover:bg-sidebar-accent/60">
    <RouterLink
      :to="target.path"
      :exact-active-class="target.path === '/' ? 'text-sidebar-accent-foreground' : ''"
      :active-class="target.path === '/' ? '' : 'text-sidebar-accent-foreground'"
      class="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-1.5 pl-3 pr-9 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      @click="emit('navigate')"
    >
      <span class="truncate text-sm font-medium text-sidebar-foreground/90">{{ target.title }}</span>
      <span v-if="target.section" class="truncate text-[10.5px] font-medium text-sidebar-foreground/45">
        {{ target.section }}
      </span>
    </RouterLink>
    <button
      type="button"
      class="absolute right-0 grid size-9 place-items-center rounded text-sidebar-foreground/60 opacity-70 outline-none transition-opacity hover:opacity-100 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50 md:right-1.5 md:size-6"
      :aria-label="$t('shell.sidebar.unpin')"
      :title="$t('shell.sidebar.unpin')"
      @click.stop="emit('toggle-pin', target.id)"
    >
      <PinOff class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
