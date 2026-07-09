<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { Blocks, ChevronDown, ChevronRight, Hexagon, PanelLeftClose, PanelLeftOpen, Search } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth";
import { useNavShortcutsStore } from "@/stores/navShortcuts";
import { NAV, type NavItem } from "@/router/nav";
import {
  pluginSectionLabel,
  resolvePluginNavIcon,
  resolvePluginNavSectionId,
  usePluginContributions,
} from "@/composables/usePluginContributions";
import SidebarItem from "./SidebarItem.vue";
import SidebarShortcut, { type ShortcutTarget } from "./SidebarShortcut.vue";

const props = defineProps<{
  collapsed: boolean;
  mobileOpen: boolean;
}>();

const emit = defineEmits<{
  (e: "update:collapsed", value: boolean): void;
  (e: "update:mobileOpen", value: boolean): void;
  (e: "open-command"): void;
}>();

const route = useRoute();
const auth = useAuthStore();
const { t } = useI18n();
const shortcuts = useNavShortcutsStore();

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
  pluginOwned?: boolean;
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
const pluginInsertBefore = new Set(["networking"]);

/**
 * Sections with their scope-visible static items, plus any plugin-contributed
 * items appended at the end. Empty sections (no static + no plugin items) drop.
 */
const visibleSections = computed<VisibleSection[]>(() => {
  const staticSections = NAV.map((section) => {
    const staticItems = section.items.filter((item) => auth.canAny(item.scopes ?? []));
    const pluginGroups = pluginGroupsBySection.value[section.id] ?? [];
    return { ...section, items: staticItems, pluginGroups, pluginOwned: false };
  }).filter((section) => section.items.length > 0 || section.pluginGroups.length > 0);
  const dynamicSections = Object.entries(pluginGroupsBySection.value)
    .filter(([id, groups]) => !staticSectionIds.has(id) && groups.length > 0)
    .map(([id, pluginGroups]) => ({
      id,
      title: pluginSectionTitles.value[id] ?? pluginSectionLabel(id),
      items: [],
      pluginGroups,
      pluginOwned: true,
    }));
  if (dynamicSections.length === 0) return staticSections;
  const out: VisibleSection[] = [];
  let inserted = false;
  for (const section of staticSections) {
    if (!inserted && pluginInsertBefore.has(section.id)) {
      out.push(...dynamicSections);
      inserted = true;
    }
    out.push(section);
  }
  if (!inserted) out.push(...dynamicSections);
  return out;
});

// ── Nav index: stable id → renderable shortcut target ─────────────────────────
// Flattens every currently-visible destination (static + plugin) so pinned/recent
// ids resolve to a title, path, and localized section label. Ids that no longer
// resolve (removed plugin, hidden by scope) simply fall out of the lists.
type IndexEntry = { item: NavItem; sectionId: string; sectionTitle: string };

function sectionLabelFor(sectionId: string, fallback: string): string {
  return staticSectionIds.has(sectionId) ? t("nav.sections." + sectionId) : fallback;
}

const navIndex = computed<Map<string, IndexEntry>>(() => {
  const index = new Map<string, IndexEntry>();
  for (const section of visibleSections.value) {
    const label = sectionLabelFor(section.id, section.title);
    for (const item of section.items) {
      index.set(item.name, { item, sectionId: section.id, sectionTitle: label });
    }
    for (const group of section.pluginGroups) {
      for (const item of group.items) {
        index.set(item.name, { item, sectionId: section.id, sectionTitle: group.title });
      }
    }
  }
  return index;
});

function itemLabel(entry: IndexEntry): string {
  return entry.item.name.startsWith("plugin:")
    ? entry.item.title
    : t("nav.items." + entry.item.name);
}

function toShortcutTarget(id: string): ShortcutTarget | null {
  const entry = navIndex.value.get(id);
  if (!entry) return null;
  return { id, title: itemLabel(entry), path: entry.item.path, section: entry.sectionTitle };
}

const pinnedTargets = computed<ShortcutTarget[]>(() =>
  shortcuts.pinned.map(toShortcutTarget).filter((x): x is ShortcutTarget => x !== null),
);
const recentTargets = computed<ShortcutTarget[]>(() =>
  shortcuts.recents.map(toShortcutTarget).filter((x): x is ShortcutTarget => x !== null),
);
const hasShortcuts = computed(() => pinnedTargets.value.length > 0 || recentTargets.value.length > 0);

// Track the active destination as a recent visit. Resolving through navIndex keeps
// out routes with no sidebar home (e.g. /login) and respects the plugin id scheme.
watch(
  () => route.name,
  () => {
    const name = route.name ? String(route.name) : "";
    if (name && navIndex.value.has(name)) shortcuts.recordVisit(name);
  },
  { immediate: true },
);

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

function isPluginBandStart(index: number): boolean {
  return visibleSections.value[index]?.pluginOwned === true && visibleSections.value[index - 1]?.pluginOwned !== true;
}

// ── Collapsible sections ──────────────────────────────────────────────────────
function sectionOpen(sectionId: string): boolean {
  return !shortcuts.isSectionCollapsed(sectionId);
}

/** Whether the current route lives inside a section — used to auto-open it. */
function sectionOwnsActive(section: VisibleSection): boolean {
  const name = route.name ? String(route.name) : "";
  if (!name) return false;
  if (section.items.some((item) => item.name === name)) return true;
  return section.pluginGroups.some((group) => group.items.some((item) => item.name === name));
}

// Never leave the active page hidden inside a collapsed section (after a deep link
// or a plugin adding the section) — force its owning section open.
watch(
  [() => route.name, visibleSections],
  () => {
    for (const section of visibleSections.value) {
      if (sectionOwnsActive(section) && shortcuts.isSectionCollapsed(section.id)) {
        shortcuts.setSectionCollapsed(section.id, false);
      }
    }
  },
  { immediate: true },
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

    <!-- Quick search trigger (opens the command palette; ⌘K also works globally) -->
    <div class="shrink-0 px-2 pt-3">
      <button
        type="button"
        :class="
          cn(
            'flex h-8 w-full items-center rounded-md border border-sidebar-border bg-sidebar-accent/30 text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
            collapsed ? 'md:justify-center md:px-0' : 'gap-2 px-2.5',
          )
        "
        :aria-label="$t('shell.command.open')"
        @click="emit('open-command')"
      >
        <Search class="size-4 shrink-0" aria-hidden="true" />
        <template v-if="!collapsed">
          <span class="text-xs">{{ $t('shell.command.search') }}</span>
          <kbd
            class="pointer-events-none ml-auto inline-flex h-5 select-none items-center rounded border border-sidebar-border bg-sidebar px-1.5 font-mono text-[10px] font-medium text-sidebar-foreground/60"
          >
            {{ $t('shell.command.shortcut') }}
          </kbd>
        </template>
      </button>
    </div>

    <!-- Nav -->
    <nav :aria-label="$t('shell.sidebar.primaryNav')" class="flex-1 space-y-4 overflow-y-auto px-2 py-3">
      <!-- Pinned + Recents shortcuts (hidden in the collapsed rail) -->
      <div v-if="!collapsed && hasShortcuts" class="space-y-1">
        <p class="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {{ $t('shell.sidebar.shortcuts') }}
        </p>
        <div class="relative space-y-px pl-3">
          <span class="absolute inset-y-1 left-[7px] w-px bg-sidebar-border" aria-hidden="true" />
          <SidebarShortcut
            v-for="target in pinnedTargets"
            :key="`pin-${target.id}`"
            :target="target"
            :pinned="true"
            @toggle-pin="shortcuts.togglePin"
            @navigate="closeMobile"
          />
          <SidebarShortcut
            v-for="target in recentTargets"
            :key="`recent-${target.id}`"
            :target="target"
            :pinned="false"
            @toggle-pin="shortcuts.togglePin"
            @navigate="closeMobile"
          />
        </div>
      </div>

      <div
        v-for="(section, idx) in visibleSections"
        :key="section.id"
        :class="cn('space-y-1', section.pluginOwned && !collapsed && 'rounded-lg border border-sidebar-primary/20 bg-sidebar-primary/[0.045] p-1.5')"
      >
        <p
          v-if="!collapsed && isPluginBandStart(idx)"
          class="mb-1 flex items-center gap-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-wider text-sidebar-primary"
        >
          <Blocks class="size-3.5" aria-hidden="true" />
          {{ $t('nav.pluginExtensions') }}
        </p>
        <!-- Section header doubles as a collapse toggle. In the 16px rail we skip
             the header entirely and keep every item visible as an icon. -->
        <button
          v-if="!collapsed"
          type="button"
          :class="
            cn(
              'group/section flex w-full items-center gap-1 rounded-md px-3 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              section.pluginOwned && 'bg-sidebar-primary/[0.055] text-sidebar-accent-foreground hover:bg-sidebar-primary/10',
            )
          "
          :aria-expanded="sectionOpen(section.id)"
          @click="shortcuts.toggleSection(section.id)"
        >
          <span
            :class="
              cn(
                'text-[11px] font-medium uppercase tracking-wider',
                section.pluginOwned ? 'text-sidebar-foreground/85' : 'text-muted-foreground',
              )
            "
          >
            {{ staticSectionIds.has(section.id) ? $t('nav.sections.' + section.id) : section.title }}
          </span>
          <span
            v-if="section.pluginOwned"
            class="ml-auto rounded-full border border-sidebar-primary/25 bg-sidebar-primary/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-sidebar-primary"
          >
            {{ $t('nav.pluginBadge') }}
          </span>
          <ChevronDown
            :class="
              cn(
                'size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 group-hover/section:text-muted-foreground',
                !section.pluginOwned && 'ml-auto',
                sectionOpen(section.id) ? 'rotate-0' : '-rotate-90',
              )
            "
            aria-hidden="true"
          />
        </button>

        <!-- Animated collapse region (grid-rows 0fr↔1fr; always open in the rail). -->
        <div
          class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
          :class="collapsed || sectionOpen(section.id) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
        >
          <div class="space-y-1 overflow-hidden">
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
                :class="
                  cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-3 text-xs font-medium text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
                    section.pluginOwned && 'border border-sidebar-primary/15 bg-sidebar/50 text-sidebar-foreground/85 hover:bg-sidebar-primary/10',
                  )
                "
                @click="togglePluginGroup(section.id, group.id)"
              >
                <ChevronDown
                  v-if="isPluginGroupOpen(section.id, group.id)"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <ChevronRight v-else class="size-3.5 shrink-0" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-left">{{ group.title }}</span>
                <span
                  v-if="section.pluginOwned"
                  class="rounded-full bg-sidebar-primary/12 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-sidebar-primary"
                >
                  {{ $t('nav.pluginBadge') }}
                </span>
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

/*
 * The shortcut rows are <div>-wrapped RouterLinks (title + section subtitle), so
 * the accent bar above (scoped to bare <a>) intentionally does not apply to them
 * — their active state is the text-color treatment from SidebarShortcut instead.
 */

@media (prefers-reduced-motion: reduce) {
  nav :deep(a),
  nav :deep(a)::before {
    transition: none;
  }
}
</style>
