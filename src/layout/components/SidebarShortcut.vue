<script setup lang="ts">
import { RouterLink } from "vue-router";
import { Pin, PinOff } from "lucide-vue-next";
import { cn } from "@/lib/utils";

/** A resolved pinned/recent destination (see AppSidebar's navIndex). */
export type ShortcutTarget = {
  id: string;
  title: string;
  path: string;
  section: string;
};

defineProps<{
  target: ShortcutTarget;
  pinned: boolean;
}>();

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
      :class="
        cn(
          'absolute right-1.5 grid size-6 place-items-center rounded text-sidebar-foreground/60 outline-none transition-opacity hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          pinned ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover/shortcut:opacity-60 hover:opacity-100 focus-visible:opacity-100',
        )
      "
      :aria-label="pinned ? $t('shell.sidebar.unpin') : $t('shell.sidebar.pin')"
      :title="pinned ? $t('shell.sidebar.unpin') : $t('shell.sidebar.pin')"
      @click.stop="emit('toggle-pin', target.id)"
    >
      <PinOff v-if="pinned" class="size-3.5" aria-hidden="true" />
      <Pin v-else class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
