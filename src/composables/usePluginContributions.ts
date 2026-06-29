// usePluginContributions — the dashboard side of "VPN is a plugin end-to-end"
// (design-10). Fetches the plugin registry ONCE (module-level cache shared by
// the sidebar and every plugin page), then exposes the active plugins' declared
// nav + view contributions, defensively filtered against the dashboard's FIXED
// allow-lists. The dashboard owns the view primitives; plugins contribute DATA
// only. Unknown enum values are treated as inert (skipped) — never thrown on.

import { computed, ref, shallowRef, type Component } from "vue";
import {
  Blocks,
  Boxes,
  DoorOpen,
  Gauge,
  Link,
  Radar,
  ServerCog,
  Store,
  Users,
} from "lucide-vue-next";
import { api, type PluginView, type PluginViewContribution } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

// ── Allow-lists (mirror the server; anything else is inert / skipped) ─────────
/** nav.section ∈ here; mapped to the dashboard's static NavSection ids. */
const NAV_SECTIONS = new Set(["plugins", "proxy"]);
/** nav.icon ∈ here (lucide-vue-next names). "" is allowed (default icon). */
const NAV_ICON_COMPONENTS: Record<string, Component> = {
  Radar,
  Boxes,
  Store,
  ServerCog,
  DoorOpen,
  Users,
  Link,
  Gauge,
  Blocks,
};
/** view.kind ∈ here. */
const VIEW_KINDS = new Set(["table", "detail", "form", "kv", "markdown"]);
/** column.render ∈ here. */
const COLUMN_RENDERS = new Set(["", "copy-secret", "bytes", "relative-time", "badge", "code"]);
/** form field.kind ∈ here. */
const FORM_FIELD_KINDS = new Set(["text", "int", "select"]);
/** nav.route / view.route slug shape. */
const ROUTE_RE = /^[a-z0-9][a-z0-9/_-]{0,64}$/;

/** "plugins" contribution-section → "platform" NavSection; "proxy" → "proxy". */
export const NAV_SECTION_TO_NAV_ID: Record<string, string> = {
  plugins: "platform",
  proxy: "proxy",
};

/** Resolve an allow-listed icon name to a lucide component (Blocks fallback). */
export function resolvePluginNavIcon(name?: string): Component {
  return NAV_ICON_COMPONENTS[name ?? ""] ?? Blocks;
}

export function isAllowedColumnRender(render?: string): boolean {
  return COLUMN_RENDERS.has(render ?? "");
}

export function isAllowedFieldKind(kind?: string): boolean {
  return FORM_FIELD_KINDS.has(kind ?? "");
}

export function isAllowedViewKind(kind?: string): boolean {
  return VIEW_KINDS.has(kind ?? "");
}

// ── Module-level cache (one fetch, shared everywhere) ─────────────────────────
const plugins = shallowRef<PluginView[]>([]);
const ready = ref(false);
let inflight: Promise<void> | null = null;

function load(force = false): Promise<void> {
  if (inflight) return inflight;
  if (ready.value && !force) return Promise.resolve();
  inflight = api.plugins
    .list()
    .then((list) => {
      plugins.value = Array.isArray(list) ? list : [];
      ready.value = true;
    })
    .catch(() => {
      // Keep last-good; a registry blip just means the sidebar shows no plugin
      // items and pages fall back to their "view not available" empty state.
      ready.value = true;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** A single plugin-contributed sidebar destination, fully resolved + gated. */
export interface PluginNavEntry {
  pluginId: string;
  section: string;
  title: string;
  route: string;
  icon: string;
  scopes: string[];
  /** Absolute dashboard path: /plugins/<pluginId>/<route>. */
  to: string;
}

export function usePluginContributions() {
  const auth = useAuthStore();

  // Lazily kick off the cached fetch on first use.
  if (!ready.value) void load();

  const activePlugins = computed(() =>
    plugins.value.filter((p) => p.active === true || p.status === "active"),
  );

  const navContributions = computed<PluginNavEntry[]>(() => {
    const out: PluginNavEntry[] = [];
    for (const plugin of activePlugins.value) {
      const nav = plugin.ui?.nav;
      if (!Array.isArray(nav)) continue;
      for (const entry of nav) {
        if (!entry || typeof entry !== "object") continue;
        // Skip anything that fails an allow-list — inert, never throw.
        if (!NAV_SECTIONS.has(entry.section)) continue;
        if (entry.icon && !(entry.icon in NAV_ICON_COMPONENTS)) continue;
        if (typeof entry.route !== "string" || !ROUTE_RE.test(entry.route)) continue;
        const scopes = Array.isArray(entry.scopes) ? entry.scopes : [];
        if (!auth.canAny(scopes)) continue;
        out.push({
          pluginId: plugin.id,
          section: entry.section,
          title: entry.title || entry.route,
          route: entry.route,
          icon: entry.icon ?? "",
          scopes,
          to: `/plugins/${plugin.id}/${entry.route}`,
        });
      }
    }
    return out;
  });

  function findPlugin(pluginId: string): PluginView | undefined {
    return plugins.value.find((p) => p.id === pluginId);
  }

  function findView(pluginId: string, route: string): PluginViewContribution | undefined {
    const views = findPlugin(pluginId)?.ui?.views;
    if (!Array.isArray(views)) return undefined;
    return views.find((v) => v?.route === route);
  }

  return {
    plugins,
    ready,
    navContributions,
    findPlugin,
    findView,
    refresh: () => load(true),
  };
}
