/**
 * The console's destinations as the sidebar and the command palette both
 * show them: the scope-visible NAV sections, with the official plugins'
 * pages placed into their console sections (VPN, Networking), and the
 * remaining plugin pages for the Extensions workspace (navigationModel says
 * which plugins move and why). One source, so a page the sidebar lists is a
 * page the palette finds, and neither can show one the principal may not
 * open.
 */
import { computed } from "vue";

import { useAuthStore } from "@/stores/auth";
import { CONSOLE_SECTION_ORDER, NAV, PLUGIN_HOST_SECTIONS, type NavItem, type NavSection } from "@/router/nav";
import { resolvePluginNavIcon, usePluginContributions } from "@/composables/usePluginContributions";
import { OFFICIAL_PLUGIN_SECTIONS, partitionPluginNav, placeHoistedItems } from "./navigationModel";

/** A plugin's page as a sidebar destination. */
export type PluginSidebarItem = NavItem & {
  plugin: { id: string; name: string };
  pluginId: string;
  pluginName: string;
  publisher: string;
  route: string;
  to: string;
};

function hostSection(id: string): NavSection | undefined {
  const section = NAV.find((entry) => entry.id === id) ?? PLUGIN_HOST_SECTIONS.find((entry) => entry.id === id);
  return section ? { ...section, items: [] } : undefined;
}

export function useConsoleNavigation() {
  const auth = useAuthStore();
  const { ready, navContributions } = usePluginContributions();

  const navSections = computed<NavSection[]>(() =>
    NAV.map((section) => ({
      ...section,
      items: section.items.filter((item) => auth.canAny(item.scopes ?? [])),
    })).filter((section) => section.items.length > 0),
  );

  /** Every plugin page this principal may open, already scope-filtered by the contributions read. */
  const pluginItems = computed<PluginSidebarItem[]>(() =>
    navContributions.value.map((entry) => ({
      name: `plugin:${entry.pluginId}:${entry.route}`,
      title: entry.title,
      path: entry.to,
      icon: resolvePluginNavIcon(entry.icon),
      scopes: entry.scopes,
      plugin: { id: entry.pluginId, name: entry.pluginName },
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      publisher: entry.publisher,
      route: entry.route,
      to: entry.to,
    })),
  );

  const partition = computed(() => partitionPluginNav(pluginItems.value));

  /** Console sections, official plugin pages placed in theirs. */
  const consoleSections = computed<NavSection[]>(() =>
    placeHoistedItems<NavItem, NavSection>(
      navSections.value,
      partition.value.hoisted.map(({ sectionId, entry }) => ({ sectionId, item: entry })),
      hostSection,
      CONSOLE_SECTION_ORDER,
    ),
  );

  /** Plugin pages that stay in the Extensions workspace. */
  const extensionItems = computed<PluginSidebarItem[]>(() => partition.value.extensions);

  /**
   * Plugins whose routes the console workspace owns. Until the contributions
   * read lands, a deep link to an official plugin's page is assumed to be
   * one (by id), so the sidebar does not flash to Extensions and back; the
   * read then settles it by publisher.
   */
  const consolePluginIds = computed<ReadonlySet<string>>(() =>
    new Set(ready.value ? partition.value.hoisted.map(({ entry }) => entry.pluginId) : Object.keys(OFFICIAL_PLUGIN_SECTIONS)),
  );

  return { ready, consoleSections, extensionItems, pluginItems, consolePluginIds };
}
