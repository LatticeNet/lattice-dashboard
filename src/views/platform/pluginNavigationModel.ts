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

export type PluginNavigateVerdict =
  /** Not a navigation message at all. Belongs to the bridge protocol. */
  | { kind: "not-navigation" }
  /** Navigation-shaped but malformed or non-internal. Drop it. */
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
  if (typeof route !== "string" || !isInternalDashboardRoute(route)) return { kind: "invalid" };
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
