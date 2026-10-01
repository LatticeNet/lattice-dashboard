/**
 * Pure helpers for the Plugins page and the pages that link to a plugin
 * (design 23, section 4.5). Kept free of Vue so `node --test` covers them.
 */

/** The official plugins' ids, as their manifests declare them. */
export const NETGUARD_PLUGIN_ID = "latticenet.netguard";

interface PluginPages {
  id: string;
  ui?: {
    nav?: ReadonlyArray<{ route: string; title?: string }>;
    views?: ReadonlyArray<{ route: string; title?: string }>;
  };
}

export interface PluginPage {
  route: string;
  title: string;
  to: string;
}

/**
 * The pages a plugin contributes, nav entries first (what the sidebar shows),
 * then views no nav entry points at. A plugin that is not active carries no
 * `ui` (the server drops it), so it contributes nothing.
 */
export function pluginPages(plugin: PluginPages): PluginPage[] {
  const out: PluginPage[] = [];
  const seen = new Set<string>();
  const add = (route: string, title?: string) => {
    if (!route || seen.has(route)) return;
    seen.add(route);
    out.push({ route, title: title?.trim() || route, to: `/plugins/${plugin.id}/${route}` });
  };
  for (const entry of plugin.ui?.nav ?? []) add(entry.route, entry.title);
  for (const view of plugin.ui?.views ?? []) add(view.route, view.title);
  return out;
}

/** The plugin's first page, or null when it contributes none. */
export function pluginPagePath(plugin: PluginPages): string | null {
  return pluginPages(plugin)[0]?.to ?? null;
}
