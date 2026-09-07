import type { PluginView, PublishingRecord, SubscriptionShareView } from "@/lib/api";
import type { QueryValue } from "@/components/common/tableUrlState";

/**
 * The publishing plane answers one question for the whole console: what URL is
 * this content visible at, and who may read it. A route decides the URL, an
 * origin decides where the bytes come from.
 *
 * These are pure so the rules that decide whether a route is actually serving
 * live in one place and can be tested without rendering a page.
 */

/** Display order. It matches the server's, so the table does not reshuffle. */
export const PUBLISHING_ORIGINS = ["kv", "static", "plugin"] as const;

// ── the origin lens ──────────────────────────────────────────────────────────

/**
 * The lens the page is looking through, carried in the URL as `origin=`.
 *
 * `all` is the plane as the table has always shown it. The three others narrow
 * the table to one origin and open that origin's management pane under it:
 * the storage forms for kv and static, the share pane for share. The lens is
 * named `share` rather than `plugin`, the server's word for the origin,
 * because the record the operator manages on that lens is the share; the
 * plugin is only who renders it (DESIGN-PROGRAM-2026-09 §9, Decision A).
 */
export const PUBLISHING_LENSES = ["all", "kv", "static", "share"] as const;
export type PublishingLens = (typeof PUBLISHING_LENSES)[number];
export const PUBLISHING_LENS_PARAM = "origin";
export const PUBLISHING_DEFAULT_LENS: PublishingLens = "all";

/** Which server origin a lens shows, or undefined for the whole plane. */
export function lensOrigin(lens: PublishingLens): (typeof PUBLISHING_ORIGINS)[number] | undefined {
  switch (lens) {
    case "kv":
      return "kv";
    case "static":
      return "static";
    case "share":
      return "plugin";
    default:
      return undefined;
  }
}

/** The records a lens shows. `all` passes everything through, unknown origins included. */
export function recordsForLens(records: readonly PublishingRecord[], lens: PublishingLens): PublishingRecord[] {
  const origin = lensOrigin(lens);
  return origin ? records.filter((record) => record.origin === origin) : [...records];
}

// ── the share deep link and the old path ─────────────────────────────────────

/**
 * The Sub-Store frame sends the operator here with `?create=1&for=<record>`,
 * and the create dialog opens with that record chosen. The keys are the ones
 * the bridge allowlist declares for this path; a frame cannot hand the page
 * anything else.
 */
export const SHARE_CREATE_PARAM = "create";
export const SHARE_CREATE_FOR_PARAM = "for";

function firstString(raw: QueryValue | undefined): string {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : "";
}

/** Whether the query asks the page to open the create dialog. Only the exact marker counts. */
export function hasShareCreateDeepLink(query: Record<string, QueryValue | undefined>): boolean {
  return firstString(query[SHARE_CREATE_PARAM]) === "1";
}

/** The record the deep link names, or "" when it names none. */
export function shareCreateTarget(query: Record<string, QueryValue | undefined>): string {
  return firstString(query[SHARE_CREATE_FOR_PARAM]);
}

/**
 * The query to leave in the address bar once the deep link has been consumed.
 *
 * The create keys go, so a reload does not reopen the dialog, and the lens is
 * pinned to `share`: the dialog belongs to the share pane, and dropping the
 * keys without pinning the lens would unmount the pane under an open dialog
 * on a URL that named no lens.
 */
export function withoutShareDeepLink(
  query: Record<string, QueryValue | undefined>,
): Record<string, QueryValue> {
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === SHARE_CREATE_PARAM || key === SHARE_CREATE_FOR_PARAM || value === undefined) continue;
    next[key] = value;
  }
  next[PUBLISHING_LENS_PARAM] = "share";
  return next;
}

/**
 * Where the retired /network/subscription-shares path lands.
 *
 * Only `create` and `for` ride through: that is the pair the old bridge
 * allowlist declared for the path, so Sub-Store's existing deep link keeps
 * working with no plugin release, and nothing else the old URL might carry
 * (a stale lens, a filter the old page understood) lands in the new address
 * bar. The old bridge allowlist entry and this redirect go together once the
 * plugin points at the new path.
 */
export const SHARES_REDIRECT_PATH = "/platform/publishing";
const SHARES_REDIRECT_KEYS: ReadonlySet<string> = new Set([SHARE_CREATE_PARAM, SHARE_CREATE_FOR_PARAM]);

export function sharesRedirectTarget(
  query: Record<string, QueryValue | undefined>,
): { path: string; query: Record<string, QueryValue> } {
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || !SHARES_REDIRECT_KEYS.has(key)) continue;
    next[key] = value;
  }
  next[PUBLISHING_LENS_PARAM] = "share";
  return { path: SHARES_REDIRECT_PATH, query: next };
}

// ── who renders a share ──────────────────────────────────────────────────────

/**
 * Whether the plugin that renders a share is there to do it.
 *
 * A proxy-user share is server-native and has no renderer to be missing. A
 * plugin share names its plugin, and /api/plugins lists every plugin the
 * server has loaded with its lifecycle status, so the answer is read from the
 * same list the create picker reads. `unknown` is the honest answer while that
 * list has not arrived or failed: claiming "not installed" over a failed load
 * would be a confident wrong answer about a share that may be fine.
 *
 * `inactive` is kept apart from `missing` because they are different operator
 * problems (enable it on Plugins, or install it), and because the gateway
 * refuses calls to an inactive plugin just as it refuses calls to an absent
 * one, so refresh is unavailable in both.
 */
export type ShareRendererState = "native" | "ready" | "inactive" | "missing" | "unknown";

export function shareRendererState(
  share: Pick<SubscriptionShareView, "source">,
  plugins: readonly Pick<PluginView, "id" | "active">[] | undefined,
): ShareRendererState {
  const source = share.source;
  if (source.kind !== "plugin") return "native";
  if (!plugins) return "unknown";
  const plugin = plugins.find((entry) => entry.id === source.plugin_id);
  if (!plugin) return "missing";
  return plugin.active === false ? "inactive" : "ready";
}

/** Refresh reaches the plugin's provider, so only a ready renderer can do it. */
export function shareRefreshable(state: ShareRendererState): boolean {
  return state === "ready" || state === "unknown";
}

/**
 * Plugins that can back a new share: the `subscription:serve` capability is
 * what lets a plugin produce a body the core serves, and the gateway only
 * calls an active plugin. A plugin the server has not said is inactive is
 * offered, so a server predating the flag still lists its plugins.
 */
export function publishablePlugins<T extends Pick<PluginView, "capabilities" | "active">>(
  plugins: readonly T[] | undefined,
): T[] {
  return (plugins ?? []).filter(
    (plugin) => (plugin.capabilities ?? []).includes("subscription:serve") && plugin.active !== false,
  );
}

export type PublishingState = "serving" | "disabled" | "expired";

/**
 * Whether a route is answering right now.
 *
 * Expiry is reported separately from disabled because they are different
 * operator problems: one was turned off on purpose, the other ran out while
 * nobody was looking.
 */
export function publishingState(record: PublishingRecord, now: Date = new Date()): PublishingState {
  if (!record.enabled) return "disabled";
  if (record.expires_at && new Date(record.expires_at).getTime() <= now.getTime()) {
    return "expired";
  }
  return "serving";
}

export function isServing(record: PublishingRecord, now: Date = new Date()): boolean {
  return publishingState(record, now) === "serving";
}

/** The path a route answers on, always rooted and without a trailing slash. */
export function routePath(record: PublishingRecord): string {
  const prefix = (record.path_prefix ?? "").replace(/^\/+|\/+$/g, "");
  return prefix ? `/${prefix}` : "/";
}

/**
 * The route as one readable string. A route with no hostname answers on every
 * host, which has to read as a deliberate fact rather than as missing data.
 */
export function routeLabel(record: PublishingRecord, anyHostLabel = "*"): string {
  const host = record.any_host || !record.hostname ? anyHostLabel : record.hostname;
  const path = routePath(record);
  return path === "/" ? host : `${host}${path}`;
}

/**
 * What the origin points at. For kv and static that is a bucket; for a plugin
 * route it is the share that owns it, and the bucket field carries the share id
 * rather than a bucket name.
 */
export function originTarget(record: PublishingRecord): string {
  return record.origin === "plugin" ? (record.share_id ?? record.bucket) : record.bucket;
}

/** Sort: origin first in display order, then host, then path. */
export function sortRecords(records: PublishingRecord[]): PublishingRecord[] {
  const rank = (origin: string) => {
    const index = (PUBLISHING_ORIGINS as readonly string[]).indexOf(origin);
    return index === -1 ? PUBLISHING_ORIGINS.length : index;
  };
  return [...records].sort((a, b) => {
    if (rank(a.origin) !== rank(b.origin)) return rank(a.origin) - rank(b.origin);
    if (a.hostname !== b.hostname) return a.hostname.localeCompare(b.hostname);
    return routePath(a).localeCompare(routePath(b));
  });
}

/**
 * The routes belonging to one share.
 *
 * The subscription page uses this so the URL it shows comes from the publishing
 * plane rather than from a second private idea of where a share lives.
 */
export function recordsForShare(records: PublishingRecord[], shareId: string): PublishingRecord[] {
  return records.filter((record) => record.origin === "plugin" && record.share_id === shareId);
}

/**
 * Who may read a route. The three origins answer "who may fetch it" three
 * different ways on the server, and the table presented them as one kind of
 * thing until the column existed:
 *
 * - a KV route demands a storage token even on GET (serveKVBinding),
 * - a static route is anonymous public hosting (serveStaticBinding),
 * - a plugin route is a share, read with the bearer token in its URL.
 *
 * An origin this console has never heard of is reported as unknown rather
 * than guessed at: printing "anonymous" for a route that is not would be the
 * one wrong answer on this page an operator could not recover from.
 */
export type PublishingAccessMode = "anonymous" | "storage_token" | "share_token" | "unknown";

export function accessMode(record: Pick<PublishingRecord, "origin">): PublishingAccessMode {
  switch (record.origin) {
    case "kv":
      return "storage_token";
    case "static":
      return "anonymous";
    case "plugin":
      return "share_token";
    default:
      return "unknown";
  }
}

/**
 * The access modes, in the order the table groups its rows: kv, static, plugin,
 * and last the one the console could not read.
 */
export const PUBLISHING_ACCESS_MODES = [
  "storage_token",
  "anonymous",
  "share_token",
  "unknown",
] as const satisfies readonly PublishingAccessMode[];

/**
 * The access modes the table is actually showing, for the legend under it.
 *
 * The badge's sentence lives in a title attribute on a span nothing can focus,
 * so a keyboard or touch operator could not reach it, and the primer that
 * repeated it is only on an empty plane. The legend puts the same sentences
 * under the table permanently, and lists only the modes on screen so a fleet
 * with one kind of route does not read three explanations for it.
 */
export function accessLegend(
  records: readonly Pick<PublishingRecord, "origin">[],
): PublishingAccessMode[] {
  const present = new Set(records.map((record) => accessMode(record)));
  return PUBLISHING_ACCESS_MODES.filter((mode) => present.has(mode));
}

/**
 * A first run is a plane with no route on it at all.
 *
 * Reserved does not carve out an exception, and reading it as one was wrong:
 * the server sets reserved on every share record it builds, and there it means
 * "the operator cannot move or delete this route from this page", not "nobody
 * chose to publish it". A share exists because an operator created it in the
 * Publish dialog, so a plane holding one has been published to. Treating a
 * reserved route as no route printed the origin primer, headed "nothing is
 * published yet", directly above a share the table was showing as serving.
 */
export function isFirstRun(records: readonly unknown[]): boolean {
  return records.length === 0;
}

/**
 * Whether the plane is visibly empty, which is when the guide opens on its own.
 *
 * "Empty" is a claim about the plane and not about the caller. Gated on the
 * record list alone it was wrong, because the record list is empty for two
 * different reasons: nobody has published anything, or the operator holds
 * none of kv:admin, kv:read, static:admin or static:read and the server
 * returned no origin they may look at. In the second case the page asserted
 * the plane was empty directly above the card telling the same operator they
 * cannot see any origin, and only the second statement was true.
 *
 * So an operator who may see no origin gets a collapsed guide like everyone
 * else, and a load that failed or has not returned counts as not empty, for
 * the reason the table owns its own error and loading states.
 */
export function publishingPlaneEmpty(input: {
  loaded: boolean;
  visibleOrigins: readonly string[];
  records: readonly unknown[];
}): boolean {
  if (!input.loaded) return false;
  if (input.visibleOrigins.length === 0) return false;
  return isFirstRun(input.records);
}

/** The query key old Workers links carry so the page can say where they went. */
export const WORKERS_REDIRECT_QUERY = { from: "workers" } as const;

/**
 * Where /platform/workers now lands.
 *
 * Publishing, not Store: the job Workers was reserved for was "serve this
 * content at a URL", and Publishing is the page that owns it. Store answers a
 * different question (what is the control plane holding), which is why the
 * first redirect after the deletion pointed at the wrong page.
 */
export const WORKERS_REDIRECT_TO = {
  path: "/platform/publishing",
  query: WORKERS_REDIRECT_QUERY,
} as const;

/**
 * Whether this visit arrived through the old /platform/workers URL. Only the
 * exact marker counts; a bookmark that merely mentions workers in some other
 * parameter is not a redirect.
 */
export function arrivedFromWorkers(query: Record<string, unknown>): boolean {
  const raw = query.from;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === WORKERS_REDIRECT_QUERY.from;
}
