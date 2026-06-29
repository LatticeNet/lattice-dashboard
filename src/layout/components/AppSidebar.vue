<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, ChevronRight, Hexagon, PanelLeftClose, PanelLeftOpen } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth";
import { NAV, type NavItem } from "@/router/nav";
import {
  pluginSectionLabel,
  resolvePluginNavIcon,
  resolvePluginNavSectionId,
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

type PluginSidebarItem = NavItem & {
  pluginId: string;
  pluginName: string;
};

type PluginSidebarGroup = {
  id: string;
  title: string;
  items: PluginSidebarItem[];
};

type VisibleSection = {
  id: string;
  title: string;
  items: NavItem[];
  pluginGroups: PluginSidebarGroup[];
};

/**
 * Plugin nav entries grouped first by target NavSection id, then by plugin id.
 * "plugins" aliases to the built-in Platform section; any other safe section id
 * creates/joins a plugin section. Keeping plugin groups visible in the sidebar
 * makes ownership boundaries explicit inside shared areas such as VPN Manage.
 */
const pluginGroupsBySection = computed<Record<string, PluginSidebarGroup[]>>(() => {
  const grouped: Record<string, Record<string, PluginSidebarGroup>> = {};
  for (const c of navContributions.value) {
    const targetId = resolvePluginNavSectionId(c.section);
    if (!targetId) continue;
    const section = (grouped[targetId] ??= {});
    const group = (section[c.pluginId] ??= {
      id: c.pluginId,
      title: c.pluginName || c.pluginId,
      items: [],
    });
    group.items.push({
      name: `plugin:${c.pluginId}:${c.route}`,
      title: c.title,
      path: c.to,
      icon: resolvePluginNavIcon(c.icon),
      scopes: c.scopes,
      pluginId: c.pluginId,
      pluginName: c.pluginName,
    });
  }
  const out: Record<string, PluginSidebarGroup[]> = {};
  for (const [sectionId, groups] of Object.entries(grouped)) {
    out[sectionId] = Object.values(groups).sort((a, b) => a.title.localeCompare(b.title));
  }
  return out;
});

const pluginSectionTitles = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const c of navContributions.value) {
    const targetId = resolvePluginNavSectionId(c.section);
    if (!map[targetId]) map[targetId] = pluginSectionLabel(c.section, c.sectionTitle);
  }
  return map;
});

const staticSectionIds = new Set(NAV.map((section) => section.id));
const collapsedPluginGroups = ref<Record<string, boolean>>({});

/**
 * Sections with their scope-visible static items, plus any plugin-contributed
 * items appended at the end. Empty sections (no static + no plugin items) drop.
 */
const visibleSections = computed<VisibleSection[]>(() => {
  const staticSections = NAV.map((section) => {
    const staticItems = section.items.filter((item) => auth.canAny(item.scopes ?? []));
    const pluginGroups = pluginGroupsBySection.value[section.id] ?? [];
    return { ...section, items: staticItems, pluginGroups };
  }).filter((section) => section.items.length > 0 || section.pluginGroups.length > 0);
  const dynamicSections = Object.entries(pluginGroupsBySection.value)
    .filter(([id, groups]) => !staticSectionIds.has(id) && groups.length > 0)
    .map(([id, pluginGroups]) => ({
      id,
      title: pluginSectionTitles.value[id] ?? pluginSectionLabel(id),
      items: [],
      pluginGroups,
    }));
  return [...staticSections, ...dynamicSections];
});

/** Plugin-contributed items carry a synthetic `plugin:<id>:<route>` name. */
function isPluginItem(item: NavItem): boolean {
  return item.name.startsWith("plugin:");
}

function groupKey(sectionId: string, groupId: string): string {
  return `${sectionId}:${groupId}`;
}

function isPluginGroupOpen(sectionId: string, groupId: string): boolean {
  return collapsedPluginGroups.value[groupKey(sectionId, groupId)] !== true;
}

function togglePluginGroup(sectionId: string, groupId: string) {
  const key = groupKey(sectionId, groupId);
  collapsedPluginGroups.value = {
    ...collapsedPluginGroups.value,
    [key]: collapsedPluginGroups.value[key] !== true,
  };
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
          {{ staticSectionIds.has(section.id) ? $t('nav.sections.' + section.id) : section.title }}
        </p>
        <SidebarItem
          v-for="item in section.items"
          :key="item.name"
          :item="item"
          :collapsed="collapsed"
          :plugin="isPluginItem(item)"
          @click="closeMobile"
        />
        <div
          v-for="group in section.pluginGroups"
          :key="group.id"
          class="space-y-1"
        >
          <button
            v-if="!collapsed"
            type="button"
            class="flex h-8 w-full items-center gap-2 rounded-md px-3 text-xs font-medium text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            @click="togglePluginGroup(section.id, group.id)"
          >
            <ChevronDown
              v-if="isPluginGroupOpen(section.id, group.id)"
              class="size-3.5 shrink-0"
              aria-hidden="true"
            />
            <ChevronRight v-else class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-left">{{ group.title }}</span>
            <span class="rounded bg-sidebar-accent px-1.5 py-0.5 text-[10px] tabular text-sidebar-foreground/70">
              {{ group.items.length }}
            </span>
          </button>
          <div
            v-show="collapsed || isPluginGroupOpen(section.id, group.id)"
            :class="cn(!collapsed && 'ml-3 border-l border-sidebar-border/70 pl-2')"
          >
            <SidebarItem
              v-for="item in group.items"
              :key="item.name"
              :item="item"
              :collapsed="collapsed"
              plugin
              @click="closeMobile"
            />
          </div>
        </div>
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
