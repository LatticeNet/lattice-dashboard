<script setup lang="ts">
import { computed } from "vue";
import { Hexagon, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth";
import { NAV } from "@/router/nav";
import SidebarItem from "./SidebarItem.vue";

const props = defineProps<{
  collapsed: boolean;
  mobileOpen: boolean;
}>();

const emit = defineEmits<{
  (e: "update:collapsed", value: boolean): void;
  (e: "update:mobileOpen", value: boolean): void;
}>();

const auth = useAuthStore();

/** Sections with their scope-visible items; empty sections are dropped. */
const visibleSections = computed(() =>
  NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => auth.canAny(item.scopes ?? [])),
  })).filter((section) => section.items.length > 0),
);

function toggleCollapse() {
  emit("update:collapsed", !props.collapsed);
}

function closeMobile() {
  emit("update:mobileOpen", false);
}
</script>

<template>
  <!-- Mobile scrim -->
  <div
    v-show="mobileOpen"
    class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden"
    @click="closeMobile"
  />

  <aside
    :class="
      cn(
        'z-50 flex h-screen flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-200',
        collapsed ? 'md:w-16' : 'md:w-60',
        'fixed inset-y-0 left-0 w-60 md:static md:translate-x-0',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
      )
    "
  >
    <!-- Brand lockup -->
    <div
      :class="
        cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4',
          collapsed && 'md:justify-center md:px-0',
        )
      "
    >
      <div
        class="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground"
      >
        <Hexagon class="size-4" aria-hidden="true" />
      </div>
      <span v-if="!collapsed" class="text-sm font-semibold tracking-tight">Lattice</span>
    </div>

    <!-- Nav -->
    <nav aria-label="Primary" class="flex-1 space-y-4 overflow-y-auto px-2 py-3">
      <div v-for="section in visibleSections" :key="section.id" class="space-y-1">
        <p
          v-if="!collapsed"
          class="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          {{ section.title }}
        </p>
        <SidebarItem
          v-for="item in section.items"
          :key="item.name"
          :item="item"
          :collapsed="collapsed"
          @click="closeMobile"
        />
      </div>
    </nav>

    <!-- Collapse toggle -->
    <div class="hidden shrink-0 border-t border-sidebar-border p-2 md:block">
      <Button
        variant="ghost"
        aria-label="Toggle sidebar"
        :class="cn('w-full justify-start gap-3 text-sidebar-foreground/80', collapsed && 'justify-center')"
        @click="toggleCollapse"
      >
        <PanelLeftClose v-if="!collapsed" class="size-4" aria-hidden="true" />
        <PanelLeftOpen v-else class="size-4" aria-hidden="true" />
        <span v-if="!collapsed">Collapse</span>
      </Button>
    </div>
  </aside>
</template>
