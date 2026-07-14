<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import {
  Blocks,
  ChevronDown,
  Hexagon,
  LayoutDashboard,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/auth";
import { useNavShortcutsStore } from "@/stores/navShortcuts";
import { NAV, type NavItem, type NavSection } from "@/router/nav";
import {
  resolvePluginNavIcon,
  usePluginContributions,
} from "@/composables/usePluginContributions";
import {
  buildExtensionPluginGroups,
  extensionWorkspaceVisible,
  reconcileExpandedSections,
  toggleExpandedSection,
  workspaceForRoute,
  type NavigationWorkspace,
} from "@/layout/navigationModel";
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
const {
  ready: contributionsReady,
  navContributions,
} = usePluginContributions();

type VisibleConsoleSection = NavSection & { items: NavItem[] };

type ExtensionSidebarItem = NavItem & {
  pluginId: string;
  pluginName: string;
  route: string;
  to: string;
};

const visibleConsoleSections = computed<VisibleConsoleSection[]>(() =>
  NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => auth.canAny(item.scopes ?? [])),
  })).filter((section) => section.items.length > 0),
);

const overviewItems = computed(() =>
  visibleConsoleSections.value.find((section) => section.id === "overview")?.items ?? [],
);

const consoleAccordionSections = computed(() =>
  visibleConsoleSections.value.filter((section) => section.id !== "overview"),
);

const extensionItems = computed<ExtensionSidebarItem[]>(() =>
  navContributions.value.map((entry) => ({
    name: `plugin:${entry.pluginId}:${entry.route}`,
    title: entry.title,
    path: entry.to,
    icon: resolvePluginNavIcon(entry.icon),
    scopes: entry.scopes,
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    route: entry.route,
    to: entry.to,
  })),
);

const extensionPluginGroups = computed(() => buildExtensionPluginGroups(extensionItems.value));
const extensionsVisible = computed(() =>
  extensionWorkspaceVisible(extensionItems.value.length, route.path),
);
// Desktop collapse is a rail preference, not a mobile navigation mode. Opening
// the mobile drawer always restores labels and full-size touch targets.
const effectiveCollapsed = computed(() => props.collapsed && !props.mobileOpen);

// Route ownership is authoritative. Manually switching the navigation workspace
// never causes an unexpected route change, but the next navigation selects its
// owning workspace again.
const workspace = ref<NavigationWorkspace>(workspaceForRoute(route.path));

watch(
  () => route.path,
  (path) => {
    workspace.value = workspaceForRoute(path);
  },
  { immediate: true },
);

watch(extensionsVisible, (visible) => {
  if (!visible && workspace.value === "extensions") workspace.value = "console";
});

function setWorkspace(value: string | number) {
  if (value !== "console" && value !== "extensions") return;
  if (value === "extensions" && !extensionsVisible.value) return;
  workspace.value = value;
}

// ── Pinned destinations ------------------------------------------------------
// The previous sidebar silently promoted every visit into "Shortcuts", creating
// a second copy of normal navigation. Only explicit pins render now. Removed or
// unauthorized destinations naturally fall out because the live index cannot
// resolve them.
type NavigationIndexEntry = {
  item: NavItem;
  sectionTitle: string;
  workspace: NavigationWorkspace;
  manifestLabel: boolean;
};

type WorkspaceShortcutTarget = ShortcutTarget & { workspace: NavigationWorkspace };

const navigationIndex = computed(() => {
  const index = new Map<string, NavigationIndexEntry>();
  for (const section of visibleConsoleSections.value) {
    for (const item of section.items) {
      index.set(item.name, {
        item,
        sectionTitle: t(`nav.sections.${section.id}`),
        workspace: "console",
        manifestLabel: false,
      });
    }
  }
  for (const group of extensionPluginGroups.value) {
    for (const item of group.items) {
      index.set(item.name, {
        item,
        sectionTitle: group.title,
        workspace: "extensions",
        manifestLabel: true,
      });
    }
  }
  return index;
});

function resolvePinnedTarget(id: string): WorkspaceShortcutTarget | null {
  const entry = navigationIndex.value.get(id);
  if (!entry) return null;
  return {
    id,
    title: entry.manifestLabel ? entry.item.title : t(`nav.items.${entry.item.name}`),
    path: entry.item.path,
    section: entry.sectionTitle,
    workspace: entry.workspace,
  };
}

const pinnedTargets = computed(() =>
  shortcuts.pinned
    .map(resolvePinnedTarget)
    .filter((target): target is WorkspaceShortcutTarget => target !== null),
);

const consolePinnedTargets = computed(() =>
  pinnedTargets.value.filter((target) => target.workspace === "console"),
);

const extensionPinnedTargets = computed(() =>
  pinnedTargets.value.filter((target) => target.workspace === "extensions"),
);

// Each workspace owns independent expansion state. Route owners are kept open,
// while manual choices survive navigation and sibling toggles.
const openConsoleSectionIds = ref<Set<string>>(new Set());
const openExtensionPluginIds = ref<Set<string>>(new Set());

function consoleSectionOwnsRoute(section: VisibleConsoleSection): boolean {
  const routeName = route.name ? String(route.name) : "";
  return section.items.some((item) => item.name === routeName);
}

function extensionPluginOwnsRoute(group: (typeof extensionPluginGroups.value)[number]): boolean {
  return group.items.some((item) => item.path === route.path);
}

watch(
  [() => route.name, consoleAccordionSections],
  () => {
    const owner = consoleAccordionSections.value.find(consoleSectionOwnsRoute);
    openConsoleSectionIds.value = reconcileExpandedSections(
      openConsoleSectionIds.value,
      consoleAccordionSections.value.map((section) => section.id),
      owner?.id,
    );
  },
  { immediate: true },
);

watch(
  [() => route.path, extensionPluginGroups],
  () => {
    const owner = extensionPluginGroups.value.find(extensionPluginOwnsRoute);
    openExtensionPluginIds.value = reconcileExpandedSections(
      openExtensionPluginIds.value,
      extensionPluginGroups.value.map((group) => group.id),
      owner?.id,
    );
  },
  { immediate: true },
);

function toggleConsoleSection(section: VisibleConsoleSection) {
  const owner = consoleAccordionSections.value.find(consoleSectionOwnsRoute);
  openConsoleSectionIds.value = toggleExpandedSection(openConsoleSectionIds.value, section.id, owner?.id);
}

function toggleExtensionPlugin(group: (typeof extensionPluginGroups.value)[number]) {
  const owner = extensionPluginGroups.value.find(extensionPluginOwnsRoute);
  openExtensionPluginIds.value = toggleExpandedSection(openExtensionPluginIds.value, group.id, owner?.id);
}

function toggleCollapse() {
  emit("update:collapsed", !props.collapsed);
}

function closeMobile() {
  emit("update:mobileOpen", false);
}
</script>

<template>
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
    <div
      :class="
        cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4',
          effectiveCollapsed && 'md:justify-center md:px-0',
        )
      "
    >
      <div
        class="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground"
      >
        <Hexagon class="size-4" aria-hidden="true" />
      </div>
      <span v-if="!effectiveCollapsed" class="text-sm font-semibold tracking-tight">Lattice</span>
    </div>

    <div class="shrink-0 px-2 pt-3">
      <button
        type="button"
        :class="
          cn(
            'flex h-9 w-full items-center rounded-md border border-sidebar-border bg-sidebar-accent/30 text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50 md:h-8',
            effectiveCollapsed ? 'md:justify-center md:px-0' : 'gap-2 px-2.5',
          )
        "
        :aria-label="$t('shell.command.open')"
        @click="emit('open-command')"
      >
        <Search class="size-4 shrink-0" aria-hidden="true" />
        <template v-if="!effectiveCollapsed">
          <span class="text-xs">{{ $t('shell.command.search') }}</span>
          <kbd
            class="pointer-events-none ml-auto inline-flex h-5 select-none items-center rounded border border-sidebar-border bg-sidebar px-1.5 font-mono text-[10px] font-medium text-sidebar-foreground/60"
          >
            {{ $t('shell.command.shortcut') }}
          </kbd>
        </template>
      </button>
    </div>

    <Tabs
      :model-value="workspace"
      class="min-h-0 flex-1 gap-0"
      @update:model-value="setWorkspace"
    >
      <div v-if="extensionsVisible" class="shrink-0 px-2 pt-2">
        <TabsList
          :class="
            cn(
              'w-full border border-sidebar-border bg-sidebar-accent/25',
              effectiveCollapsed && 'h-auto flex-col gap-1 rounded-md p-1',
            )
          "
        >
          <template v-if="effectiveCollapsed">
            <Tooltip :delay-duration="0">
              <TooltipTrigger as-child>
                <TabsTrigger
                  value="console"
                  class="h-8 w-full flex-none px-0 data-[state=active]:bg-sidebar-accent"
                  :aria-label="$t('shell.sidebar.console')"
                >
                  <LayoutDashboard class="size-4" aria-hidden="true" />
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">{{ $t('shell.sidebar.console') }}</TooltipContent>
            </Tooltip>
            <Tooltip :delay-duration="0">
              <TooltipTrigger as-child>
                <TabsTrigger
                  value="extensions"
                  class="h-8 w-full flex-none px-0 data-[state=active]:bg-sidebar-accent"
                  :aria-label="$t('shell.sidebar.extensions')"
                >
                  <Blocks class="size-4" aria-hidden="true" />
                </TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">{{ $t('shell.sidebar.extensions') }}</TooltipContent>
            </Tooltip>
          </template>
          <template v-else>
            <TabsTrigger value="console" class="h-9 text-xs md:h-7">
              <LayoutDashboard class="size-3.5" aria-hidden="true" />
              {{ $t('shell.sidebar.console') }}
            </TabsTrigger>
            <TabsTrigger value="extensions" class="h-9 text-xs md:h-7">
              <Blocks class="size-3.5" aria-hidden="true" />
              {{ $t('shell.sidebar.extensions') }}
            </TabsTrigger>
          </template>
        </TabsList>
      </div>

      <TabsContent value="console" class="mt-0 min-h-0 overflow-hidden data-[state=inactive]:hidden">
        <nav
          :aria-label="`${$t('shell.sidebar.primaryNav')}: ${$t('shell.sidebar.console')}`"
          class="h-full space-y-4 overflow-y-auto px-2 py-3"
        >
          <div v-if="!effectiveCollapsed && consolePinnedTargets.length" class="space-y-1">
            <p class="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {{ $t('shell.sidebar.pinned') }}
            </p>
            <div class="relative space-y-px pl-3">
              <span class="absolute inset-y-1 left-[7px] w-px bg-sidebar-border" aria-hidden="true" />
              <SidebarShortcut
                v-for="target in consolePinnedTargets"
                :key="target.id"
                :target="target"
                @toggle-pin="shortcuts.togglePin"
                @navigate="closeMobile"
              />
            </div>
          </div>

          <template v-if="effectiveCollapsed">
            <template v-for="section in visibleConsoleSections" :key="section.id">
              <SidebarItem
                v-for="item in section.items"
                :key="item.name"
                :item="item"
                :collapsed="true"
                :context="$t('nav.sections.' + section.id)"
                @click="closeMobile"
              />
            </template>
          </template>

          <template v-else>
            <SidebarItem
              v-for="item in overviewItems"
              :key="item.name"
              :item="item"
              :collapsed="false"
              :pinned="shortcuts.isPinned(item.name)"
              pinnable
              @toggle-pin="shortcuts.togglePin"
              @click="closeMobile"
            />

            <div v-for="section in consoleAccordionSections" :key="section.id" class="space-y-1">
              <button
                type="button"
                class="group/section flex h-9 w-full items-center gap-2 rounded-md px-3 text-left outline-none transition-colors hover:bg-sidebar-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7"
                :aria-expanded="openConsoleSectionIds.has(section.id)"
                :aria-controls="`console-section-${section.id}`"
                @click="toggleConsoleSection(section)"
              >
                <span class="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {{ $t('nav.sections.' + section.id) }}
                </span>
                <ChevronDown
                  :class="cn('size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200', !openConsoleSectionIds.has(section.id) && '-rotate-90')"
                  aria-hidden="true"
                />
              </button>
              <div
                :id="`console-section-${section.id}`"
                class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
                :class="openConsoleSectionIds.has(section.id) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
              >
                <div class="space-y-1 overflow-hidden">
                  <SidebarItem
                    v-for="item in section.items"
                    :key="item.name"
                    :item="item"
                    :collapsed="false"
                    :pinned="shortcuts.isPinned(item.name)"
                    pinnable
                    @toggle-pin="shortcuts.togglePin"
                    @click="closeMobile"
                  />
                </div>
              </div>
            </div>
          </template>
        </nav>
      </TabsContent>

      <TabsContent value="extensions" class="mt-0 min-h-0 overflow-hidden data-[state=inactive]:hidden">
        <nav
          :aria-label="`${$t('shell.sidebar.primaryNav')}: ${$t('shell.sidebar.extensions')}`"
          class="h-full space-y-4 overflow-y-auto px-2 py-3"
        >
          <div v-if="!effectiveCollapsed && extensionPinnedTargets.length" class="space-y-1">
            <p class="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {{ $t('shell.sidebar.pinned') }}
            </p>
            <div class="relative space-y-px pl-3">
              <span class="absolute inset-y-1 left-[7px] w-px bg-sidebar-border" aria-hidden="true" />
              <SidebarShortcut
                v-for="target in extensionPinnedTargets"
                :key="target.id"
                :target="target"
                @toggle-pin="shortcuts.togglePin"
                @navigate="closeMobile"
              />
            </div>
          </div>

          <div
            v-if="!contributionsReady"
            class="px-3 py-5 text-xs leading-5 text-muted-foreground"
          >
            {{ $t('shell.sidebar.extensionsLoading') }}
          </div>
          <div
            v-else-if="extensionPluginGroups.length === 0"
            class="mx-1 rounded-md border border-dashed border-sidebar-border px-3 py-4"
          >
            <p class="text-sm font-medium text-sidebar-foreground/90">
              {{ $t('shell.sidebar.extensionUnavailable') }}
            </p>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">
              {{ $t('shell.sidebar.extensionUnavailableHint') }}
            </p>
          </div>

          <template v-else-if="effectiveCollapsed">
            <template v-for="group in extensionPluginGroups" :key="group.id">
              <SidebarItem
                v-for="item in group.items"
                :key="item.name"
                :item="item"
                :collapsed="true"
                :context="group.title"
                plugin
                @click="closeMobile"
              />
            </template>
          </template>

          <template v-else>
            <div
              v-for="group in extensionPluginGroups"
              :key="group.id"
              class="space-y-1 border-b border-sidebar-border/70 pb-2 last:border-b-0 last:pb-0"
            >
              <button
                type="button"
                class="group/plugin flex h-11 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-sidebar-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50 md:h-10"
                :data-plugin-id="group.id"
                :aria-expanded="openExtensionPluginIds.has(group.id)"
                :aria-controls="`extension-plugin-${group.id}`"
                @click="toggleExtensionPlugin(group)"
              >
                <span
                  class="grid size-7 shrink-0 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent/35 text-sidebar-primary"
                  aria-hidden="true"
                >
                  <Package class="size-3.5" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-semibold text-sidebar-foreground/90">
                    {{ group.title }}
                  </span>
                  <span class="block truncate font-mono text-[10px] text-muted-foreground">
                    {{ group.id }}
                  </span>
                </span>
                <span
                  class="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-sidebar-accent px-1.5 text-[10px] font-medium tabular-nums text-sidebar-foreground/65"
                  :aria-label="String(group.items.length)"
                >
                  {{ group.items.length }}
                </span>
                <ChevronDown
                  :class="cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200', !openExtensionPluginIds.has(group.id) && '-rotate-90')"
                  aria-hidden="true"
                />
              </button>
              <div
                :id="`extension-plugin-${group.id}`"
                class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
                :class="openExtensionPluginIds.has(group.id) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
              >
                <div class="ml-3 space-y-1 overflow-hidden border-l border-sidebar-border/70 pl-2 pt-1">
                  <SidebarItem
                    v-for="item in group.items"
                    :key="item.name"
                    :item="item"
                    :collapsed="false"
                    :pinned="shortcuts.isPinned(item.name)"
                    :context="group.title"
                    pinnable
                    plugin
                    @toggle-pin="shortcuts.togglePin"
                    @click="closeMobile"
                  />
                </div>
              </div>
            </div>
          </template>
        </nav>
      </TabsContent>
    </Tabs>

    <div class="hidden shrink-0 border-t border-sidebar-border p-2 md:block">
      <Button
        variant="ghost"
        :aria-label="$t('shell.sidebar.toggle')"
        :class="cn('w-full justify-start gap-3 text-sidebar-foreground/80', effectiveCollapsed && 'justify-center')"
        @click="toggleCollapse"
      >
        <PanelLeftClose v-if="!effectiveCollapsed" class="size-4" aria-hidden="true" />
        <PanelLeftOpen v-else class="size-4" aria-hidden="true" />
        <span v-if="!effectiveCollapsed">{{ $t('shell.sidebar.collapse') }}</span>
      </Button>
    </div>
  </aside>
</template>

<style scoped>
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
