/**
 * Each page remembers the view the operator left it in (r1-ux item 17).
 *
 * A page's view (layer, filter, group, sort, search, a table's page) already
 * lives in its address query, and the sidebar and the palette link to bare
 * paths, so going back to Nodes or Tasks dropped all of it. The router now
 * keeps the last view query of every console page and every plugin page,
 * and when an in-app navigation reaches one of them with an empty query
 * (a sidebar row, a palette page, a breadcrumb), it lands on that view
 * instead. The header then offers "Reset view" for as long as the page
 * still shows the restored view.
 *
 * Kept per tab in sessionStorage: closing the tab forgets, so tomorrow's
 * console never opens on a filter set yesterday and forgotten, and a new tab
 * starts from the default views. Every read and write is guarded; without
 * storage the console works as before. Only query keys are kept, never
 * anything the server sent, and keys that name an object or a one-shot
 * action (an open sheet, a create form, a sign-in code) are left out.
 *
 * Not restored: an address typed, pasted or reloaded (the first navigation
 * of a load is the operator's exact URL), a navigation that carries any
 * query of its own (a Home tile's "failed in 24h" means that, not the last
 * view), and a navigation within the same page (clearing a filter clears it).
 */
import { shallowRef } from "vue";
import type { LocationQuery, LocationQueryRaw, RouteLocationNormalized, Router } from "vue-router";

export type ViewQuery = Record<string, string | string[]>;

/** Keys that name an object or a one-shot action, never a view. */
export const TRANSIENT_VIEW_KEYS: ReadonlySet<string> = new Set([
  "open",
  "selected",
  "create",
  "for",
  "share",
  "redirect",
  "next",
  "code",
  "state",
  "token",
  "sso_error",
  "totp_challenge",
  "mfa",
]);

export const VIEW_MEMORY_KEY = "lattice.ui.views.v1";
export const VIEW_MEMORY_MAX = 40;
const MAX_VALUE_LENGTH = 512;

/** The view part of a query: string values only, transient keys and oversized values left out. */
export function viewQuery(query: LocationQuery | LocationQueryRaw): ViewQuery {
  const out: ViewQuery = {};
  for (const [key, raw] of Object.entries(query)) {
    if (TRANSIENT_VIEW_KEYS.has(key)) continue;
    if (typeof raw === "string") {
      if (raw.length <= MAX_VALUE_LENGTH) out[key] = raw;
    } else if (Array.isArray(raw)) {
      const values = raw.filter((value): value is string => typeof value === "string" && value.length <= MAX_VALUE_LENGTH);
      if (values.length) out[key] = values;
    }
  }
  return out;
}

export function viewQueriesEqual(a: ViewQuery, b: ViewQuery): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

/** Console destinations (the sidebar's paths, Overview aside) and plugin pages. */
export function isRememberedPath(path: string, consolePaths: ReadonlySet<string>): boolean {
  if (path === "/") return false;
  if (consolePaths.has(path)) return true;
  return /^\/plugins\/[^/]+\/.+/.test(path);
}

export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Stored = Record<string, { q: ViewQuery; at: number }>;

function readAll(storage: ViewStorage | null): Stored {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(VIEW_MEMORY_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Stored = {};
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { q?: unknown; at?: unknown } | null;
      if (!entry || typeof entry.q !== "object" || entry.q === null || typeof entry.at !== "number") continue;
      const q = viewQuery(entry.q as LocationQuery);
      if (Object.keys(q).length) out[path] = { q, at: entry.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(storage: ViewStorage | null, all: Stored) {
  if (!storage) return;
  try {
    storage.setItem(VIEW_MEMORY_KEY, JSON.stringify(all));
  } catch {
    /* Quota or disabled storage: the console just forgets, as it did before. */
  }
}

/** The remembered view of a page, or null. */
export function recallView(storage: ViewStorage | null, path: string): ViewQuery | null {
  return readAll(storage)[path]?.q ?? null;
}

/**
 * Keep `query`'s view as the page's last; an empty view forgets the page.
 * At most VIEW_MEMORY_MAX pages are kept, the least recently left dropped.
 */
export function rememberView(storage: ViewStorage | null, path: string, query: LocationQuery | LocationQueryRaw, now = Date.now()) {
  const all = readAll(storage);
  const view = viewQuery(query);
  const had = all[path];
  if (!Object.keys(view).length) {
    if (!had) return;
    delete all[path];
  } else {
    if (had && viewQueriesEqual(had.q, view)) return;
    all[path] = { q: view, at: now };
    const paths = Object.keys(all);
    if (paths.length > VIEW_MEMORY_MAX) {
      paths.sort((a, b) => all[a]!.at - all[b]!.at);
      for (const stale of paths.slice(0, paths.length - VIEW_MEMORY_MAX)) delete all[stale];
    }
  }
  writeAll(storage, all);
}

export function forgetView(storage: ViewStorage | null, path: string) {
  const all = readAll(storage);
  if (!all[path]) return;
  delete all[path];
  writeAll(storage, all);
}

/**
 * The view to land on instead of `to`, or null to go as asked: an in-app
 * navigation to a remembered page, from another page, carrying no query.
 */
export function viewToRestore(
  to: Pick<RouteLocationNormalized, "path" | "query">,
  from: Pick<RouteLocationNormalized, "path" | "matched">,
  remembered: ViewQuery | null,
  consolePaths: ReadonlySet<string>,
): ViewQuery | null {
  if (!remembered || !Object.keys(remembered).length) return null;
  if (from.matched.length === 0) return null;
  if (from.path === to.path) return null;
  if (Object.keys(to.query).length > 0) return null;
  if (!isRememberedPath(to.path, consolePaths)) return null;
  return remembered;
}

/** The view a navigation just restored, for the header's Reset view. */
export const restoredView = shallowRef<{ path: string; query: ViewQuery } | null>(null);

function sessionStore(): ViewStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function installViewMemory(router: Router, consolePaths: ReadonlySet<string>, storage: () => ViewStorage | null = sessionStore) {
  router.beforeEach((to, from) => {
    const view = viewToRestore(to, from, recallView(storage(), to.path), consolePaths);
    if (!view) return;
    restoredView.value = { path: to.path, query: view };
    return { path: to.path, query: view, hash: to.hash };
  });
  router.afterEach((to, _from, failure) => {
    if (failure || !isRememberedPath(to.path, consolePaths)) return;
    rememberView(storage(), to.path, to.query);
  });
}

/** Show the page's default view and forget the remembered one. */
export function resetRestoredView(router: Router, storage: () => ViewStorage | null = sessionStore) {
  const restored = restoredView.value;
  if (!restored) return;
  forgetView(storage(), restored.path);
  restoredView.value = null;
  if (router.currentRoute.value.path === restored.path) void router.replace({ path: restored.path });
}
