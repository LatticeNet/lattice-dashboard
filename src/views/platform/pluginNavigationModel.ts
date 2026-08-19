/**
 * Plugin-frame navigation requests. The one host-side privilege a plugin
 * frame is granted beyond the bridge protocol.
 *
 * The hosted iframe runs with `connect-src 'none'`, so postMessage is its
 * only outbound channel. A plugin that wants to send the operator somewhere
 * else in the dashboard (e.g. Sub-Store's "publish a share for this
 * subscription" button → /network/subscription-shares?create=1&for=…) cannot
 * navigate itself; it posts a `{type: "lattice:navigate", route}` message and
 * the host performs the route change. The worst a confused or malicious frame
 * can do here is move the host to another dashboard page, so the privilege is
 * safe to grant. But only for strictly internal routes, and only from the
 * live frame window.
 */

export const PLUGIN_NAVIGATE_MESSAGE_TYPE = "lattice:navigate";

/**
 * Internal dashboard routes only: a single leading slash, then a conservative
 * charset covering paths and query strings. No "://" can survive this regex
 * (it excludes ":"), but isInternalDashboardRoute also checks for it
 * explicitly so the rule survives a future regex edit that re-admits ":".
 * A leading "//" (protocol-relative URL, which this charset would otherwise
 * admit) is rejected for the same reason: it must be impossible to turn the
 * route into an off-app navigation.
 */
const INTERNAL_ROUTE_RE = /^\/[a-z0-9\-_/?=&%.]*$/i;

export function isInternalDashboardRoute(route: string): boolean {
  return INTERNAL_ROUTE_RE.test(route) && !route.includes("://") && !route.startsWith("//");
}

/**
 * Paths a plugin frame may hand query parameters to, and which parameters.
 *
 * Staying on internal routes was not enough. The privilege was justified on the
 * grounds that the worst outcome is landing on another dashboard page, and that
 * held only while no route did work on arrival. /terminal does: it reads
 * node_id and connect=1 out of the query and opens an interactive session with
 * no operator gesture, recorded as the operator's own. So a frame could pick a
 * node and get a shell on it.
 *
 * The rule is therefore about parameters, not paths. A frame may send the
 * operator to any internal page, because arriving somewhere is the privilege
 * that was granted. It may not hand that page an argument unless the argument
 * is declared here, because an argument is how a page is told to do something.
 *
 * Default-deny is the point: a route added tomorrow that acts on its query
 * cannot be driven from a frame until someone adds it to this map, and adding
 * to this map is the moment to ask whether it should act on arrival at all.
 *
 * Today this has one entry, which is the whole of the real usage: Sub-Store's
 * "publish a share for this subscription" button, whose route opens the create
 * form with a record pre-chosen. It opens a form; it does not submit one.
 */
const PLUGIN_PARAMETERIZED_ROUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["/network/subscription-shares", new Set(["create", "for"])],
]);

/**
 * Split a route into its path and its query keys, or null when the path is
 * something we refuse to reason about.
 *
 * The path is percent-decoded before its segments are inspected, so an encoded
 * dot segment or slash cannot smuggle the route past the map: a frame must not
 * be able to match an allowed entry and then arrive somewhere else. A trailing
 * slash is normalized so one entry covers both spellings.
 */
function splitPluginRoute(route: string): { path: string; params: string[] } | null {
  const queryAt = route.indexOf("?");
  const rawPath = queryAt === -1 ? route : route.slice(0, queryAt);
  const rawQuery = queryAt === -1 ? "" : route.slice(queryAt + 1);

  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  let params: string[] = [];
  if (rawQuery) {
    try {
      params = [...new URLSearchParams(rawQuery).keys()];
    } catch {
      return null;
    }
  }
  return { path, params };
}

/**
 * Whether a plugin frame may send the host to this exact route. Internal by
 * charset, no dot segments, and either parameterless or carrying only the
 * parameters declared for its path.
 */
export function isPluginNavigableRoute(route: string): boolean {
  if (!isInternalDashboardRoute(route)) return false;
  const parts = splitPluginRoute(route);
  if (!parts) return false;
  if (parts.params.length === 0) return true;
  const allowed = PLUGIN_PARAMETERIZED_ROUTES.get(parts.path);
  if (!allowed) return false;
  return parts.params.every((key) => allowed.has(key));
}

export type PluginNavigateVerdict =
  /** Not a navigation message at all. Belongs to the bridge protocol. */
  | { kind: "not-navigation" }
  /** Navigation-shaped but malformed, non-internal, or handing a parameter to
   *  a path a frame may not parameterize. Drop it. */
  | { kind: "invalid" }
  /** Well-formed internal navigation request. */
  | { kind: "navigate"; route: string };

/**
 * Shape-check a postMessage payload. This deliberately does NOT take the
 * event's source/origin: those are live values only the host component can
 * check against the armed frame window, and they stay in PluginFrameHost.
 */
export function classifyPluginNavigateMessage(data: unknown): PluginNavigateVerdict {
  if (typeof data !== "object" || data === null) return { kind: "not-navigation" };
  if ((data as { type?: unknown }).type !== PLUGIN_NAVIGATE_MESSAGE_TYPE) return { kind: "not-navigation" };
  const route = (data as { route?: unknown }).route;
  if (typeof route !== "string" || !isPluginNavigableRoute(route)) return { kind: "invalid" };
  return { kind: "navigate", route };
}

/**
 * The origin a genuine message from the hosted frame carries. The iframe is
 * sandboxed with `allow-scripts` and WITHOUT `allow-same-origin`, so the
 * framed document always runs in an opaque origin and its messages arrive
 * with the literal origin "null". Even though the frame URL itself is
 * same-origin (resolvePluginFrameURL rejects anything else). The host origin
 * is accepted too so the check stays correct if the sandbox ever gains
 * `allow-same-origin`. Pinning `event.source` to the armed frame window (the
 * caller's job) remains the real identity check; this is the belt to its
 * suspenders.
 */
export function isExpectedPluginFrameOrigin(origin: string, hostOrigin: string): boolean {
  return origin === "null" || origin === hostOrigin;
}
