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

/**
 * Section state is stored as what the operator SHUT, not as what they opened.
 *
 * The previous model was the other way round, and the consequence was that a
 * fresh console opened with one section expanded and every other destination
 * hidden behind a disclosure. A navigation whose default answer to "where can I
 * go" is "expand things until you find out" has no information scent: the
 * operator has to remember the IA the sidebar is supposed to be showing them.
 *
 * Open is therefore the default and costs nothing to store; only a deliberate
 * collapse is remembered, which is also what makes the state worth persisting.
 */
export function toggleCollapsedSection(
  current: ReadonlySet<string>,
  sectionId: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(sectionId)) next.delete(sectionId);
  else next.add(sectionId);
  return next;
}

/**
 * Keep collapse state valid as routes and plugin contributions change.
 *
 * Two rules: a section that no longer exists stops being remembered, and the
 * section owning the current route is force-opened. The second matters because
 * the alternative is a sidebar showing no active item at all, which reads as a
 * navigation that has lost track of where you are.
 */
export function reconcileCollapsedSections(
  current: ReadonlySet<string>,
  availableIds: readonly string[],
  routeOwnerId = "",
): Set<string> {
  const available = new Set(availableIds);
  const next = new Set([...current].filter((id) => available.has(id)));
  if (routeOwnerId) next.delete(routeOwnerId);
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

/**
 * Roving focus inside a vertical list of nav rows.
 *
 * Tab should step over the navigation, not through twenty-five destinations, so
 * the list keeps one tab stop and the arrow keys move within it. Returns the
 * index to focus, or -1 when the key is not ours to handle.
 */
export function nextNavIndex(count: number, current: number, key: string): number {
  if (count <= 0) return -1;
  const at = current < 0 || current >= count ? 0 : current;
  switch (key) {
    case "ArrowDown":
      return (at + 1) % count;
    case "ArrowUp":
      return (at - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return -1;
  }
}
