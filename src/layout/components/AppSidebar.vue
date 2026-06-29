<script setup lang="ts">
import { computed } from "vue";
import { Hexagon, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth";
import { NAV, type NavItem } from "@/router/nav";
import {
  NAV_SECTION_TO_NAV_ID,
  resolvePluginNavIcon,
  usePluginContributions,
} from "@/composables/usePluginContributions";
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

// Active plugins' nav contributions, already scope-gated + allow-list-filtered.
// Reactive: when the registry refreshes, the sidebar updates.
const { navContributions } = usePluginContributions();

/**
 * Plugin nav entries grouped by their TARGET static NavSection id ("plugins"
 * contribution-section → "platform"; "proxy" → "proxy"). Each becomes a synthetic
 * NavItem so it renders through the exact same SidebarItem markup as static items.
 */
const pluginItemsBySection = computed<Record<string, NavItem[]>>(() => {
  const map: Record<string, NavItem[]> = {};
  for (const c of navContributions.value) {
    const targetId = NAV_SECTION_TO_NAV_ID[c.section];
    if (!targetId) continue;
    (map[targetId] ??= []).push({
      name: `plugin:${c.pluginId}:${c.route}`,
      title: c.title,
      path: c.to,
      icon: resolvePluginNavIcon(c.icon),
      scopes: c.scopes,
    });
  }
  return map;
});

/**
 * Sections with their scope-visible static items, plus any plugin-contributed
 * items appended at the end. Empty sections (no static + no plugin items) drop.
 */
const visibleSections = computed(() =>
  NAV.map((section) => {
    const staticItems = section.items.filter((item) => auth.canAny(item.scopes ?? []));
    const pluginItems = pluginItemsBySection.value[section.id] ?? [];
    return { ...section, items: [...staticItems, ...pluginItems] };
  }).filter((section) => section.items.length > 0),
);

/** Plugin-contributed items carry a synthetic `plugin:<id>:<route>` name. */
function isPluginItem(item: NavItem): boolean {
  return item.name.startsWith("plugin:");
}

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
    <nav :aria-label="$t('shell.sidebar.primaryNav')" class="flex-1 space-y-4 overflow-y-auto px-2 py-3">
      <div v-for="section in visibleSections" :key="section.id" class="space-y-1">
        <p
          v-if="!collapsed"
          class="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
        >
          {{ $t('nav.sections.' + section.id) }}
        </p>
        <SidebarItem
          v-for="item in section.items"
          :key="item.name"
          :item="item"
          :collapsed="collapsed"
          :plugin="isPluginItem(item)"
          @click="closeMobile"
        />
      </div>
    </nav>

    <!-- Collapse toggle -->
    <div class="hidden shrink-0 border-t border-sidebar-border p-2 md:block">
      <Button
        variant="ghost"
        :aria-label="$t('shell.sidebar.toggle')"
        :class="cn('w-full justify-start gap-3 text-sidebar-foreground/80', collapsed && 'justify-center')"
        @click="toggleCollapse"
      >
        <PanelLeftClose v-if="!collapsed" class="size-4" aria-hidden="true" />
        <PanelLeftOpen v-else class="size-4" aria-hidden="true" />
        <span v-if="!collapsed">{{ $t('shell.sidebar.collapse') }}</span>
      </Button>
    </div>
  </aside>
</template>

<style scoped>
/*
 * CSS-only active-nav indicator. SidebarItem applies `bg-sidebar-accent` to the
 * active link via its own (exact-for-root, prefix-otherwise) router logic, so we
 * key off that authoritative marker rather than vue-router's `.router-link-active`
 * (which would also match "/" on every route). We animate a left-edge accent bar
 * that grows in on activation — no JS, no motion library. The bar scales from its
 * vertical center using the sidebar primary token. Reduced-motion collapses the
 * transition to none.
 */
nav :deep(a) {
  position: relative;
  transition: background-color 200ms ease, color 200ms ease;
}

nav :deep(a)::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  height: 1.25rem;
  width: 3px;
  border-radius: 9999px;
  background-color: var(--color-sidebar-primary);
  transform: translateY(-50%) scaleY(0);
  transform-origin: center;
  opacity: 0;
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease;
}

nav :deep(a.bg-sidebar-accent)::before {
  transform: translateY(-50%) scaleY(1);
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  nav :deep(a),
  nav :deep(a)::before {
    transition: none;
  }
}
</style>
