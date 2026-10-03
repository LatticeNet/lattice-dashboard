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

/* ------------------------------------------------------------------ */
/* Official plugins in console sections (r1-ux item 11)                 */
/* ------------------------------------------------------------------ */

/**
 * The project's own publisher. The server only loads a manifest naming a
 * publisher when its signature verifies against the key it trusts under
 * that name (lattice-server internal/plugin VerifyManifest), and the trust
 * banner announces any publisher besides this one. So `publisher ===
 * "latticenet"` on a loaded plugin means signed by the project's key.
 */
export const OFFICIAL_PLUGIN_PUBLISHER = "latticenet";

/**
 * Where each official plugin's pages sit in the console. VPN work is the
 * operator's daily work, and keeping it in a second workspace behind a
 * toggle cost a workspace switch on every visit and kept pins and search
 * apart. Third-party plugins stay in Extensions: design 10 keeps sandboxed
 * UI visibly separate, and the publisher check plus the plugin mark on each
 * row keep that signal for the four that move.
 */
export const OFFICIAL_PLUGIN_SECTIONS: Readonly<Record<string, string>> = {
  "latticenet.vpn-core": "vpn",
  "latticenet.sub-store": "vpn",
  "latticenet.netguard": "networking",
  "latticenet.wireguard": "networking",
};

/** The console section a plugin's pages belong in, or null for Extensions. */
export function consoleSectionForPlugin(pluginId: string, publisher: string | undefined): string | null {
  if ((publisher ?? "").trim() !== OFFICIAL_PLUGIN_PUBLISHER) return null;
  return OFFICIAL_PLUGIN_SECTIONS[pluginId] ?? null;
}

export interface PluginNavCandidate {
  pluginId: string;
  publisher?: string;
}

const OFFICIAL_PLUGIN_ORDER = Object.keys(OFFICIAL_PLUGIN_SECTIONS);

/**
 * Plugin pages split into those that move into a console section and the
 * Extensions remainder. Placed pages follow the table's plugin order
 * (vpn-core's daily pages before Sub-Store's, NetGuard before WireGuard),
 * whatever order the server listed the plugins in, and keep each plugin's
 * own page order; Extensions keeps contribution order.
 */
export function partitionPluginNav<T extends PluginNavCandidate>(
  entries: readonly T[],
): { hoisted: { sectionId: string; entry: T }[]; extensions: T[] } {
  const hoisted: { sectionId: string; entry: T; at: number }[] = [];
  const extensions: T[] = [];
  entries.forEach((entry, at) => {
    const sectionId = consoleSectionForPlugin(entry.pluginId, entry.publisher);
    if (sectionId) hoisted.push({ sectionId, entry, at });
    else extensions.push(entry);
  });
  const rank = (pluginId: string) => OFFICIAL_PLUGIN_ORDER.indexOf(pluginId);
  hoisted.sort((a, b) => rank(a.entry.pluginId) - rank(b.entry.pluginId) || a.at - b.at);
  return { hoisted: hoisted.map(({ sectionId, entry }) => ({ sectionId, entry })), extensions };
}

/**
 * Console sections with the hoisted plugin pages appended to theirs, after
 * the section's own destinations. A section the operator could not see
 * before (VPN always, Networking for a principal holding only a plugin's
 * scope) is created from `makeSection` and placed by `order`; sections not
 * named in `order` keep their place after the named ones.
 */
export function placeHoistedItems<I, S extends { id: string; items: I[] }>(
  sections: readonly S[],
  hoisted: readonly { sectionId: string; item: I }[],
  makeSection: (id: string) => S | undefined,
  order: readonly string[],
): S[] {
  const byId = new Map<string, S>();
  for (const section of sections) byId.set(section.id, { ...section, items: [...section.items] });
  for (const { sectionId, item } of hoisted) {
    let section = byId.get(sectionId);
    if (!section) {
      const made = makeSection(sectionId);
      if (!made) continue;
      section = { ...made, items: [...made.items] };
      byId.set(sectionId, section);
    }
    section.items.push(item);
  }
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  };
  const original = sections.map((section) => section.id);
  return [...byId.values()].sort((a, b) => {
    const diff = rank(a.id) - rank(b.id);
    if (diff !== 0) return diff;
    return original.indexOf(a.id) - original.indexOf(b.id);
  });
}

/** The plugin id a route belongs to, or null for a console route. */
export function pluginIdOfRoute(path: string): string | null {
  if (!path.startsWith("/plugins/")) return null;
  const id = path.slice("/plugins/".length).split("/")[0] ?? "";
  return id || null;
}

const NO_CONSOLE_PLUGINS: ReadonlySet<string> = new Set();

/**
 * Which workspace owns a route. Plugin routes live in Extensions, except the
 * pages of plugins placed in console sections.
 */
export function workspaceForRoute(
  path: string,
  consolePluginIds: ReadonlySet<string> = NO_CONSOLE_PLUGINS,
): NavigationWorkspace {
  if (path === "/plugins") return "extensions";
  const pluginId = pluginIdOfRoute(path);
  if (pluginId === null) return "console";
  return consolePluginIds.has(pluginId) ? "console" : "extensions";
}

/**
 * A plugin-free installation has no extension chrome, and neither does one
 * whose only plugins are the official ones placed in console sections. A
 * stale/deep plugin URL keeps the workspace switch available so its
 * not-available state is navigable.
 */
export function extensionWorkspaceVisible(
  entryCount: number,
  routePath: string,
  consolePluginIds: ReadonlySet<string> = NO_CONSOLE_PLUGINS,
): boolean {
  return entryCount > 0 || workspaceForRoute(routePath, consolePluginIds) === "extensions";
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
