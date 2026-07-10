export type NavigationWorkspace = "console" | "extensions";

export interface ExtensionNavigationEntry {
  pluginId: string;
  section: string;
  sectionTitle?: string;
  title: string;
  route: string;
  to: string;
}

export interface ExtensionNavigationSection<T extends ExtensionNavigationEntry = ExtensionNavigationEntry> {
  id: string;
  title: string;
  items: T[];
}

function humanizeSectionId(section: string): string {
  return section
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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
 * Flatten package ownership into the signed manifest's task-oriented sections.
 * Map preserves first-seen section order and each manifest's contribution order.
 */
export function buildExtensionSections<T extends ExtensionNavigationEntry>(
  entries: readonly T[],
): ExtensionNavigationSection<T>[] {
  const sections = new Map<string, ExtensionNavigationSection<T>>();

  for (const entry of entries) {
    let section = sections.get(entry.section);
    if (!section) {
      section = {
        id: entry.section,
        title: entry.sectionTitle?.trim() || humanizeSectionId(entry.section),
        items: [],
      };
      sections.set(entry.section, section);
    }
    section.items.push(entry);
  }

  return [...sections.values()];
}
