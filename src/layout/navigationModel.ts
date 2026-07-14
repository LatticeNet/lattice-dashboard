export type NavigationWorkspace = "console" | "extensions";

export interface ExtensionNavigationEntry {
  pluginId: string;
  pluginName: string;
  title: string;
  route: string;
  to: string;
}

export interface ExtensionNavigationPluginGroup<T extends ExtensionNavigationEntry = ExtensionNavigationEntry> {
  id: string;
  title: string;
  items: T[];
}

/** Routes owned by a plugin always live in the Extensions workspace. */
export function workspaceForRoute(path: string): NavigationWorkspace {
  return path === "/plugins" || path.startsWith("/plugins/") ? "extensions" : "console";
}

/**
 * A plugin-free installation has no extension chrome. A stale/deep plugin URL
 * keeps the workspace switch available so its not-available state is navigable.
 */
export function extensionWorkspaceVisible(entryCount: number, routePath: string): boolean {
  return entryCount > 0 || workspaceForRoute(routePath) === "extensions";
}

/** Toggle one section without collapsing its siblings or the active route owner. */
export function toggleExpandedSection(
  current: ReadonlySet<string>,
  sectionId: string,
  routeOwnerId = "",
): Set<string> {
  const next = new Set(current);
  if (next.has(sectionId)) {
    if (sectionId !== routeOwnerId) next.delete(sectionId);
  } else {
    next.add(sectionId);
  }
  return next;
}

/** Keep expansion state valid as routes and plugin contributions change. */
export function reconcileExpandedSections(
  current: ReadonlySet<string>,
  availableIds: readonly string[],
  routeOwnerId = "",
): Set<string> {
  const available = new Set(availableIds);
  const next = new Set([...current].filter((id) => available.has(id)));
  if (routeOwnerId && available.has(routeOwnerId)) next.add(routeOwnerId);
  if (next.size === 0 && availableIds[0]) next.add(availableIds[0]);
  return next;
}

/**
 * Keep package ownership visible even when several manifests contribute to the
 * same task section. Map preserves first-seen plugin and contribution order.
 */
export function buildExtensionPluginGroups<T extends ExtensionNavigationEntry>(
  entries: readonly T[],
): ExtensionNavigationPluginGroup<T>[] {
  const groups = new Map<string, ExtensionNavigationPluginGroup<T>>();

  for (const entry of entries) {
    let group = groups.get(entry.pluginId);
    if (!group) {
      group = {
        id: entry.pluginId,
        title: entry.pluginName.trim() || entry.pluginId,
        items: [],
      };
      groups.set(entry.pluginId, group);
    }
    group.items.push(entry);
  }

  return [...groups.values()];
}
