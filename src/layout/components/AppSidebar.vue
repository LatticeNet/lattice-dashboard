<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useMediaQuery } from "@vueuse/core";
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
  nextNavIndex,
  reconcileCollapsedSections,
  toggleCollapsedSection,
  workspaceForRoute,
  type NavigationWorkspace,
} from "@/layout/navigationModel";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DESKTOP_DEFAULT_WIDTH,
  SIDEBAR_DESKTOP_MAX_WIDTH,
  SIDEBAR_DESKTOP_MIN_WIDTH,
  SIDEBAR_MOBILE_WIDTH,
  nudgeSidebarDesktopWidth,
  pluginGroupAriaLabel,
  resizeSidebarDesktopWidth,
} from "@/layout/sidebarModel";
import SidebarItem from "./SidebarItem.vue";
import SidebarRailSection from "./SidebarRailSection.vue";
import { sectionSignal, formatBadge } from "../navSignals";
import { buildControlPlaneIdentity, controlPlaneInitials } from "../controlPlaneModel";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useNavSignals } from "../useNavSignals";
import SidebarShortcut, { type ShortcutTarget } from "./SidebarShortcut.vue";

const props = defineProps<{
  collapsed: boolean;
  desktopWidth: number;
  mobileOpen: boolean;
}>();

const emit = defineEmits<{
  (e: "update:collapsed", value: boolean): void;
  (e: "update:desktopWidth", value: number): void;
  (e: "update:mobileOpen", value: boolean): void;
  (e: "open-command"): void;
}>();

const route = useRoute();
const auth = useAuthStore();
const { t } = useI18n();
const shortcuts = useNavShortcutsStore();
const isDesktop = useMediaQuery("(min-width: 768px)");

/**
 * Live state on the nav: what is waiting, what is failing. A navigation that
 * only lists destinations makes an operator open four pages to find the one
 * that needs them.
 */
const { signals } = useNavSignals();

/**
 * Which control plane this is. An operator keeps a laptop copy and the real one
 * open at once, and until now only the address bar told them apart, thin
 * protection for a console whose buttons reconfigure machines.
 */
const buildQuery = useAsyncData(() => api.version(), { pollInterval: 300000 });
const controlPlane = computed(() =>
  buildControlPlaneIdentity({
    host: typeof window === "undefined" ? "" : window.location.host,
    serverVersion: buildQuery.data.value?.server_version,
  }),
);
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

const overviewItems = computed(
  () => visibleConsoleSections.value.find((section) => section.id === "overview")?.items ?? [],
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

type WorkspaceShortcutTarget = ShortcutTarget & {
  workspace: NavigationWorkspace;
  item: NavItem;
};

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
    item: entry.item,
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

/**
 * Sections are open unless the operator shut them, and the shut set persists.
 * The old model stored what was OPEN, so a fresh console rendered exactly one
 * expanded section and hid the rest of the product behind disclosures.
 */
const collapsedConsoleSectionIds = computed(() => shortcuts.collapsedSections);
const collapsedExtensionPluginIds = ref<Set<string>>(new Set());

const isDraggingResizeHandle = ref(false);
const dragState = ref<{
  startX: number;
  startWidth: number;
  pointerId: number;
  target: HTMLElement;
} | null>(null);
const previousBodyCursor = ref("");
const previousBodyUserSelect = ref("");

function consoleSectionOwnsRoute(section: VisibleConsoleSection): boolean {
  const routeName = route.name ? String(route.name) : "";
  return section.items.some((item) => item.name === routeName);
}

function extensionPluginOwnsRoute(group: (typeof extensionPluginGroups.value)[number]): boolean {
  return group.items.some((item) => item.path === route.path);
}

const activeConsoleSectionId = computed(
  () => consoleAccordionSections.value.find(consoleSectionOwnsRoute)?.id ?? "",
);

watch(
  [() => route.name, consoleAccordionSections],
  () => {
    shortcuts.setCollapsedSections(
      reconcileCollapsedSections(
        shortcuts.collapsedSections,
        consoleAccordionSections.value.map((section) => section.id),
        activeConsoleSectionId.value,
      ),
    );
  },
  { immediate: true },
);

watch(
  [() => route.path, extensionPluginGroups],
  () => {
    const owner = extensionPluginGroups.value.find(extensionPluginOwnsRoute);
    collapsedExtensionPluginIds.value = reconcileCollapsedSections(
      collapsedExtensionPluginIds.value,
      extensionPluginGroups.value.map((group) => group.id),
      owner?.id,
    );
  },
  { immediate: true },
);

function isConsoleSectionOpen(id: string): boolean {
  return !collapsedConsoleSectionIds.value.has(id);
}

function isExtensionGroupOpen(id: string): boolean {
  return !collapsedExtensionPluginIds.value.has(id);
}

function toggleConsoleSection(section: VisibleConsoleSection) {
  shortcuts.setCollapsedSections(
    toggleCollapsedSection(shortcuts.collapsedSections, section.id),
  );
}

function toggleExtensionPlugin(group: (typeof extensionPluginGroups.value)[number]) {
  collapsedExtensionPluginIds.value = toggleCollapsedSection(
    collapsedExtensionPluginIds.value,
    group.id,
  );
}

function toggleCollapse() {
  emit("update:collapsed", !props.collapsed);
}

function setDesktopWidth(next: number) {
  emit("update:desktopWidth", next);
}

function endResizeInteraction() {
  const state = dragState.value;
  dragState.value = null;
  isDraggingResizeHandle.value = false;
  if (state?.target.hasPointerCapture?.(state.pointerId)) {
    state.target.releasePointerCapture(state.pointerId);
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("pointermove", onResizePointerMove);
    window.removeEventListener("pointerup", onResizePointerEnd);
    window.removeEventListener("pointercancel", onResizePointerEnd);
    window.removeEventListener("blur", endResizeInteraction);
  }
  if (typeof document !== "undefined") {
    document.body.style.cursor = previousBodyCursor.value;
    document.body.style.userSelect = previousBodyUserSelect.value;
  }
}

function onResizePointerMove(event: PointerEvent) {
  if (!dragState.value || event.pointerId !== dragState.value.pointerId) return;
  setDesktopWidth(
    resizeSidebarDesktopWidth(
      dragState.value.startWidth,
      event.clientX - dragState.value.startX,
    ),
  );
}

function onResizePointerEnd(event: PointerEvent) {
  if (!dragState.value || event.pointerId !== dragState.value.pointerId) return;
  endResizeInteraction();
}

function beginResize(event: PointerEvent) {
  if (props.collapsed || event.button !== 0) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  dragState.value = {
    startX: event.clientX,
    startWidth: props.desktopWidth,
    pointerId: event.pointerId,
    target,
  };
  target.setPointerCapture(event.pointerId);
  isDraggingResizeHandle.value = true;
  if (typeof document !== "undefined") {
    previousBodyCursor.value = document.body.style.cursor;
    previousBodyUserSelect.value = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pointermove", onResizePointerMove);
    window.addEventListener("pointerup", onResizePointerEnd);
    window.addEventListener("pointercancel", onResizePointerEnd);
    window.addEventListener("blur", endResizeInteraction);
  }
}

function onResizeKeydown(event: KeyboardEvent) {
  const next = nudgeSidebarDesktopWidth(props.desktopWidth, event.key);
  if (next === props.desktopWidth) return;
  event.preventDefault();
  setDesktopWidth(next);
}

function resetDesktopWidth() {
  setDesktopWidth(SIDEBAR_DESKTOP_DEFAULT_WIDTH);
}

const asideStyle = computed(() => ({
  "--app-sidebar-mobile-width": `${SIDEBAR_MOBILE_WIDTH}px`,
  "--app-sidebar-desktop-width": `${
    effectiveCollapsed.value ? SIDEBAR_COLLAPSED_WIDTH : props.desktopWidth
  }px`,
}));

onBeforeUnmount(() => {
  endResizeInteraction();
});

function closeMobile() {
  emit("update:mobileOpen", false);
}

/* ── Mobile drawer: escape, focus, and staying out of the tab order ────────── */

const aside = ref<HTMLElement | null>(null);

/**
 * Off-canvas but still focusable is a real trap: Tab from the header walks into
 * a drawer nobody can see. `inert` is the only thing that takes the whole
 * subtree out of both the tab order and the accessibility tree.
 */
const hidden = computed(() => !isDesktop.value && !props.mobileOpen);

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.mobileOpen) {
    event.preventDefault();
    closeMobile();
  }
}

watch(
  () => props.mobileOpen,
  async (open) => {
    if (typeof window === "undefined") return;
    if (open) {
      window.addEventListener("keydown", onWindowKeydown);
      await nextTick();
      aside.value?.querySelector<HTMLElement>("[data-nav-row], button")?.focus();
    } else {
      window.removeEventListener("keydown", onWindowKeydown);
    }
  },
);

onBeforeUnmount(() => {
  if (typeof window !== "undefined") window.removeEventListener("keydown", onWindowKeydown);
});

/**
 * Arrow keys walk the destination list. Tab still steps over the navigation in
 * one or two stops; inside it, Up/Down is what an operator reaches for.
 */
function onNavKeydown(event: KeyboardEvent) {
  const container = event.currentTarget;
  if (!(container instanceof HTMLElement)) return;
  const rows = [...container.querySelectorAll<HTMLElement>("[data-nav-row]")];
  const next = nextNavIndex(rows.length, rows.indexOf(document.activeElement as HTMLElement), event.key);
  if (next < 0) return;
  event.preventDefault();
  rows[next]?.focus();
}
</script>

<template>
  <!-- Plain scrim. A blurred backdrop is decoration that costs a compositor
       layer on the machines this console is actually opened from. -->
  <div
    v-show="mobileOpen"
    class="fixed inset-0 z-40 bg-foreground/40 md:hidden"
    aria-hidden="true"
    @click="closeMobile"
  />

  <aside
    ref="aside"
    class="app-sidebar"
    :style="asideStyle"
    :inert="hidden || undefined"
    :class="
      cn(
        'z-50 flex h-screen flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground',
        isDraggingResizeHandle ? 'transition-none' : 'transition-all duration-200',
        'fixed inset-y-0 left-0 md:static md:translate-x-0',
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
      <div v-if="!effectiveCollapsed" class="min-w-0">
        <span class="block text-sm font-semibold leading-tight tracking-tight">Lattice</span>
        <span class="flex items-center gap-1.5 text-[10px] leading-tight text-muted-foreground">
          <span class="truncate" :title="controlPlane.host">{{ controlPlane.host }}</span>
          <span
            v-if="controlPlane.kind === 'local'"
            class="shrink-0 rounded bg-warning/15 px-1 font-medium uppercase tracking-wide text-warning"
          >dev</span>
          <span
            v-else-if="controlPlane.version"
            class="shrink-0 truncate font-mono"
            :title="controlPlane.version"
          >{{ controlPlane.version }}</span>
        </span>
      </div>
      <!-- Collapsed, the identity survives as the one thing worth keeping: a
           marker taken from the host, so the rail cannot be mistaken for the
           other instance either. -->
      <span
        v-else
        class="text-[10px] font-medium uppercase tracking-wide"
        :class="controlPlane.kind === 'local' ? 'text-warning' : 'text-muted-foreground'"
        :title="`${controlPlane.host}${controlPlane.version ? ' (' + controlPlane.version + ')' : ''}`"
      >{{ controlPlaneInitials(controlPlane.host) }}</span>
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
          @keydown="onNavKeydown"
        >
          <!-- Collapsed rail: sections stay the unit, so the IA survives 64px. -->
          <template v-if="effectiveCollapsed">
            <div v-if="consolePinnedTargets.length" class="space-y-1">
              <SidebarItem
                v-for="target in consolePinnedTargets"
                :key="target.id"
                :item="target.item"
                :collapsed="true"
                :signal="signals[target.item.name]"
                :context="$t('shell.sidebar.pinned')"
                @click="closeMobile"
              />
              <div class="mx-2 h-px bg-sidebar-border" role="presentation" />
            </div>

            <div class="space-y-1">
              <SidebarItem
                v-for="item in overviewItems"
                :key="item.name"
                :item="item"
                :collapsed="true"
                :signal="signals[item.name]"
                :context="$t('nav.sections.overview')"
                @click="closeMobile"
              />
              <SidebarRailSection
                v-for="section in consoleAccordionSections"
                :id="section.id"
                :key="section.id"
                :label="$t('nav.sections.' + section.id)"
                :icon="section.icon"
                :items="section.items"
                :signals="signals"
                :signal="sectionSignal(signals, section.items.map((i) => i.name))"
                :active="activeConsoleSectionId === section.id"
                @navigate="closeMobile"
              />
            </div>
          </template>

          <template v-else>
            <div v-if="consolePinnedTargets.length" class="space-y-1">
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

            <SidebarItem
              v-for="item in overviewItems"
              :key="item.name"
              :item="item"
              :collapsed="false"
              :signal="signals[item.name]"
              :pinned="shortcuts.isPinned(item.name)"
              pinnable
              @toggle-pin="shortcuts.togglePin"
              @click="closeMobile"
            />

            <div v-for="section in consoleAccordionSections" :key="section.id" class="space-y-1">
              <button
                type="button"
                class="group/section flex h-9 w-full items-center gap-2 rounded-md px-3 text-left outline-none transition-colors hover:bg-sidebar-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7"
                :aria-expanded="isConsoleSectionOpen(section.id)"
                :aria-controls="`console-section-${section.id}`"
                @click="toggleConsoleSection(section)"
              >
                <component
                  :is="section.icon"
                  class="size-3.5 shrink-0 text-muted-foreground/70"
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {{ $t('nav.sections.' + section.id) }}
                </span>
                <!-- A shut section that stays quiet while something inside it
                     is failing is how the collapse becomes a place things go to
                     be forgotten. -->
                <span
                  v-if="!isConsoleSectionOpen(section.id) && sectionSignal(signals, section.items.map((i) => i.name))"
                  :class="cn(
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
                    sectionSignal(signals, section.items.map((i) => i.name))?.tone === 'attention'
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-warning/15 text-warning',
                  )"
                  :title="sectionSignal(signals, section.items.map((i) => i.name))?.label"
                >
                  {{ formatBadge(sectionSignal(signals, section.items.map((i) => i.name))!.count) }}
                </span>
                <ChevronDown
                  :class="cn('size-3.5 shrink-0 text-muted-foreground/50 transition-transform duration-200 motion-reduce:transition-none', !isConsoleSectionOpen(section.id) && '-rotate-90')"
                  aria-hidden="true"
                />
              </button>
              <div
                :id="`console-section-${section.id}`"
                class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
                :class="isConsoleSectionOpen(section.id) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
              >
                <div class="space-y-1 overflow-hidden">
                  <SidebarItem
                    v-for="item in section.items"
                    :key="item.name"
                    :item="item"
                    :collapsed="false"
                    :signal="signals[item.name]"
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
          @keydown="onNavKeydown"
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
            <div class="space-y-1">
              <SidebarRailSection
                v-for="group in extensionPluginGroups"
                :id="group.id"
                :key="group.id"
                :label="pluginGroupAriaLabel(group.title, group.id)"
                :icon="Package"
                :items="group.items"
                :active="extensionPluginOwnsRoute(group)"
                plugin
                @navigate="closeMobile"
              />
            </div>
          </template>

          <template v-else>
            <div
              v-for="group in extensionPluginGroups"
              :key="group.id"
              class="space-y-1 border-b border-sidebar-border/70 pb-2 last:border-b-0 last:pb-0"
            >
              <Tooltip :delay-duration="0">
                <TooltipTrigger as-child>
                  <button
                    type="button"
                    class="group/plugin flex h-11 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-sidebar-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50 md:h-10"
                    :data-plugin-id="group.id"
                    :aria-expanded="isExtensionGroupOpen(group.id)"
                    :aria-controls="`extension-plugin-${group.id}`"
                    :aria-label="pluginGroupAriaLabel(group.title, group.id)"
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
                      :class="cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 motion-reduce:transition-none', !isExtensionGroupOpen(group.id) && '-rotate-90')"
                      aria-hidden="true"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" class="max-w-72">
                  <div class="font-medium leading-5 break-words">{{ group.title }}</div>
                  <div class="font-mono text-[10px] leading-4 text-muted-foreground break-all">
                    {{ group.id }}
                  </div>
                </TooltipContent>
              </Tooltip>
              <div
                :id="`extension-plugin-${group.id}`"
                class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
                :class="isExtensionGroupOpen(group.id) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
              >
                <div class="ml-3 space-y-1 overflow-hidden border-l border-sidebar-border/70 pl-2 pt-1">
                  <SidebarItem
                    v-for="item in group.items"
                    :key="item.name"
                    :item="item"
                    :collapsed="false"
                    :signal="signals[item.name]"
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
      <Tooltip :delay-duration="400">
        <TooltipTrigger as-child>
          <Button
            variant="ghost"
            size="sm"
            :aria-label="$t('shell.sidebar.toggle')"
            :class="cn('w-full justify-start gap-3 text-sidebar-foreground/70', effectiveCollapsed && 'justify-center px-0')"
            @click="toggleCollapse"
          >
            <PanelLeftClose v-if="!effectiveCollapsed" class="size-4" aria-hidden="true" />
            <PanelLeftOpen v-else class="size-4" aria-hidden="true" />
            <span v-if="!effectiveCollapsed" class="text-xs">{{ $t('shell.sidebar.collapse') }}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{{ $t('shell.sidebar.toggle') }}</TooltipContent>
      </Tooltip>
    </div>

    <div
      v-if="!collapsed"
      role="separator"
      :aria-label="$t('shell.sidebar.resize')"
      aria-orientation="vertical"
      :aria-valuemin="SIDEBAR_DESKTOP_MIN_WIDTH"
      :aria-valuemax="SIDEBAR_DESKTOP_MAX_WIDTH"
      :aria-valuenow="desktopWidth"
      tabindex="0"
      class="absolute inset-y-0 right-0 z-10 hidden w-3 translate-x-1/2 cursor-col-resize items-stretch outline-none focus-visible:ring-2 focus-visible:ring-ring/60 md:flex"
      @dblclick="resetDesktopWidth"
      @keydown="onResizeKeydown"
      @lostpointercapture="endResizeInteraction"
      @pointerdown.prevent="beginResize"
    >
      <span
        class="pointer-events-none mx-auto my-2 w-px rounded-full bg-sidebar-border/80 transition-colors"
        :class="isDraggingResizeHandle && 'bg-sidebar-primary'"
        aria-hidden="true"
      />
    </div>
  </aside>
</template>

<style scoped>
.app-sidebar {
  width: var(--app-sidebar-mobile-width);
}

/*
 * The active marker is keyed to `data-active`, which SidebarItem sets from the
 * same computed that drives `aria-current`. It used to key off a utility class
 * in the active class string, so renaming that class silently deleted the
 * marker with nothing failing anywhere.
 */
nav :deep([data-nav-row]) {
  position: relative;
  transition: background-color 200ms ease, color 200ms ease;
}

nav :deep([data-nav-row])::before {
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

nav :deep([data-nav-row][data-active="true"])::before {
  transform: translateY(-50%) scaleY(1);
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  nav :deep([data-nav-row]),
  nav :deep([data-nav-row])::before {
    transition: none;
  }
}

@media (min-width: 768px) {
  .app-sidebar {
    width: var(--app-sidebar-desktop-width);
  }
}
</style>
