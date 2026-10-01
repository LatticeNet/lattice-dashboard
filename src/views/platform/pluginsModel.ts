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

/* ------------------------------------------------------------------ */
/* One list for every reader (design 23, section 4.5)                  */
/* ------------------------------------------------------------------ */

interface RuntimeLike {
  state: string;
  runner?: string;
  message?: string;
  started_at?: string;
  stopped_at?: string;
  updated_at?: string;
}

interface RegisteredLike extends PluginPages {
  name: string;
  type?: string;
  version?: string;
  publisher?: string;
  capabilities?: string[];
  status?: string;
  active?: boolean;
}

interface InstallLike {
  id: string;
  name: string;
  type?: string;
  version?: string;
  publisher?: string;
  capabilities?: string[];
  artifact_sha256?: string;
  available?: boolean;
  status: string;
  runtime?: RuntimeLike;
  verified_at?: string;
  installed_at?: string;
  activated_at?: string;
  disabled_at?: string;
}

export interface PluginRow {
  id: string;
  name: string;
  type?: string;
  version?: string;
  publisher?: string;
  capabilities: string[];
  /** Lifecycle status, when a read carried it. */
  status?: string;
  runtime?: RuntimeLike;
  /** Whether the bundle is in the plugin directory; only the lifecycle read knows. */
  available?: boolean;
  artifactSha256?: string;
  transitions: Array<{ key: "verified" | "installed" | "activated" | "disabled"; at: string }>;
  pages: PluginPage[];
  /** Whether the lifecycle read (plugin:admin) held this row: runtime and digest come only from it. */
  lifecycleRead: boolean;
}

/**
 * One row per plugin from whichever reads the session holds: the lifecycle
 * read (plugin:admin) has runtime, digest and transitions; the registered read
 * (audit:read) has the manifest and, for an active plugin, its pages; the
 * contributions read (anyone) lists active plugins and their pages. A reader
 * with only the last still sees every active plugin.
 */
export function mergePluginRows(
  registered: readonly RegisteredLike[] | undefined,
  lifecycle: readonly InstallLike[] | undefined,
  contributions: readonly RegisteredLike[] | undefined,
): PluginRow[] {
  const rows = new Map<string, PluginRow>();
  const row = (id: string, name: string): PluginRow => {
    let current = rows.get(id);
    if (!current) {
      current = { id, name: name || id, capabilities: [], transitions: [], pages: [], lifecycleRead: false };
      rows.set(id, current);
    }
    return current;
  };
  for (const install of lifecycle ?? []) {
    const current = row(install.id, install.name);
    Object.assign(current, {
      name: install.name || install.id,
      type: install.type,
      version: install.version,
      publisher: install.publisher,
      capabilities: install.capabilities ?? [],
      status: install.status,
      runtime: install.runtime,
      available: install.available,
      artifactSha256: install.artifact_sha256,
      lifecycleRead: true,
    });
    const transitions: PluginRow["transitions"] = [];
    if (install.verified_at) transitions.push({ key: "verified", at: install.verified_at });
    if (install.installed_at) transitions.push({ key: "installed", at: install.installed_at });
    if (install.activated_at) transitions.push({ key: "activated", at: install.activated_at });
    if (install.disabled_at) transitions.push({ key: "disabled", at: install.disabled_at });
    current.transitions = transitions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  for (const source of [registered ?? [], contributions ?? []]) {
    for (const plugin of source) {
      const current = row(plugin.id, plugin.name);
      current.type ??= plugin.type;
      current.version ??= plugin.version;
      current.publisher ??= plugin.publisher;
      if (!current.capabilities.length && plugin.capabilities?.length) current.capabilities = [...plugin.capabilities];
      current.status ??= plugin.status || (plugin.active ? "active" : undefined);
      if (!current.pages.length) current.pages = pluginPages(plugin);
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type PluginHealth = "running" | "failed" | "stopped" | "missing" | "disabled" | "pending" | "unknown";

/**
 * What a plugin amounts to right now. Only an active plugin whose runtime is
 * armed answers calls; a failed runtime or a bundle gone from the directory
 * is the red case; disabled is the operator's choice. Without the lifecycle
 * read an active plugin is listed as active, never as running.
 */
export function pluginHealth(row: Pick<PluginRow, "status" | "runtime" | "available" | "lifecycleRead">): PluginHealth {
  if (row.lifecycleRead && row.available === false) return "missing";
  if (row.status === "disabled") return "disabled";
  if (row.status === "verified" || row.status === "installed") return "pending";
  if (row.status !== "active") return "unknown";
  if (!row.lifecycleRead || !row.runtime) return "unknown";
  if (row.runtime.state === "failed") return "failed";
  if (row.runtime.state === "armed") return "running";
  return "stopped";
}

export type PluginLifecycleTarget = "installed" | "active" | "disabled";

/** The lifecycle states a plugin can move to from where it is. */
export function nextLifecycleStates(status: string | undefined): PluginLifecycleTarget[] {
  switch (status) {
    case "verified":
      return ["installed"];
    case "installed":
      return ["active"];
    case "active":
      return ["disabled"];
    case "disabled":
      return ["active"];
    default:
      return [];
  }
}
