/**
 * What the operator is actually looking at on the publish surface.
 *
 * A share is core-owned plumbing. Slug, token, source binding, format. And
 * none of those words answer the question an operator opens the page with:
 * which of my subscriptions are live on the internet right now, and what does
 * each one serve? This module turns the server's records into that answer, and
 * keeps the derivation testable away from the view.
 */
import type {
  FleetFeedRefusalBody,
  IdentityLinkStatus,
  PublishingRecord,
  ShareRenderBudget,
  ShareRevealResponse,
  SubscriptionShareView,
} from "@/lib/api";

export type PublishedState = "live" | "paused" | "expired" | "expiring" | "unresolved";

/** How soon an expiry counts as worth warning about. */
export const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A disabled share and an expired one both stop serving, but only one of them
 * is a decision someone made. Keeping them apart is the difference between
 * "you turned this off" and "this lapsed while you weren't looking".
 *
 * `unresolved` is a share whose proxy user the server does not have. The share
 * API accepts any non-empty id, and the URL of such a share answers the same
 * empty 404 a prober gets, so this console is the only place the fact can
 * show. It is claimed only against `knownProxyUsers`, the set of ids the
 * caller actually read from the server: with no set the list is unknown or
 * failed to load, and calling a share broken over a failed read would be the
 * confident wrong answer this page exists to avoid. It outranks expiring as
 * well as live, because both of those say the URL answers today and it does
 * not; paused and expired still win, since they already say it does not.
 */
export function publishedState(
  share: SubscriptionShareView,
  now: number = Date.now(),
  knownProxyUsers?: ReadonlySet<string>,
): PublishedState {
  if (!share.enabled) return "paused";
  const expiry = share.expires_at ? Date.parse(share.expires_at) : Number.NaN;
  const expires = Number.isFinite(expiry);
  if (expires && expiry <= now) return "expired";
  if (
    knownProxyUsers &&
    share.source.kind === "core.proxy_user" &&
    !knownProxyUsers.has(share.source.proxy_user_id)
  ) {
    return "unresolved";
  }
  if (expires && expiry - now <= EXPIRING_SOON_MS) return "expiring";
  return "live";
}

/** Only a live URL is worth handing to a client. */
export function isServing(
  share: SubscriptionShareView,
  now: number = Date.now(),
  knownProxyUsers?: ReadonlySet<string>,
): boolean {
  const state = publishedState(share, now, knownProxyUsers);
  return state === "live" || state === "expiring";
}

/**
 * Who produces the bytes. A plugin-sourced share names the record inside that
 * plugin; a core one names the proxy user. The id is kept beside the label
 * because two records can carry the same display name.
 */
export function sourceLabel(share: SubscriptionShareView): string {
  const source = share.source;
  if (source.kind === "plugin") {
    return `${source.plugin_id ?? "plugin"} · ${source.subscription_id ?? "?"}`;
  }
  return `proxy user · ${source.proxy_user_id ?? "?"}`;
}

/**
 * The path a share is served under, with the token left out. The share views
 * carry no token (it is a credential, revealed only after step-up), so this
 * is all a list or a sheet can show until the operator reveals it.
 */
export function maskedSharePath(share: Pick<SubscriptionShareView, "slug">): string {
  return `/sub/${share.slug}/…`;
}

/**
 * The full URL of a revealed link: the server's own when it knows its public
 * address, else the path on the origin the browser is on, which is the origin
 * the console and the /sub/ mount share.
 */
export function revealedUrl(origin: string, reveal: Pick<ShareRevealResponse, "path" | "url">): string {
  return reveal.url || `${origin}${reveal.path}`;
}

/** A revealed URL with its token cut to the ends, for showing beside Copy. */
export function maskedUrl(url: string): string {
  const at = url.lastIndexOf("/");
  const token = at >= 0 ? url.slice(at + 1) : "";
  if (token.length <= 10) return url;
  return `${url.slice(0, at + 1)}${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * A revealed URL pinned to one client.
 *
 * Without ?target= the served bytes are chosen from the fetching client's
 * User-Agent, which is a guess that fails for curl, a downloader, or any client
 * the server has never seen. Naming the client makes the URL say what it
 * produces.
 */
export function clientUrl(url: string, target: string): string {
  return `${url}?target=${encodeURIComponent(target)}`;
}

/** The refresh a share's link advertises, and whether it is the default. */
export const DEFAULT_UPDATE_INTERVAL_HOURS = 2;
export const MAX_UPDATE_INTERVAL_HOURS = 168;

/**
 * The interval field's error, or "": empty means the default, otherwise a
 * whole number of hours from 1 to 168, the server's bounds.
 */
export function intervalFieldError(value: string): "" | "range" {
  const text = value.trim();
  if (!text) return "";
  if (!/^\d+$/.test(text)) return "range";
  const hours = Number(text);
  return hours >= 1 && hours <= MAX_UPDATE_INTERVAL_HOURS ? "" : "range";
}

/** The interval field as the request carries it: 0 (the default) for empty. */
export function intervalFieldValue(value: string): number {
  const text = value.trim();
  return text ? Number(text) : 0;
}

/** The field's starting text: empty for the default, so saving it changes nothing. */
export function intervalFieldFor(share: Pick<SubscriptionShareView, "update_interval_hours">): string {
  const hours = share.update_interval_hours;
  return hours && hours !== DEFAULT_UPDATE_INTERVAL_HOURS ? String(hours) : "";
}

export type RenderBudgetTone = "none" | "quiet" | "warning" | "exhausted";

/**
 * How a share's render budget reads. Absent means the link has not rendered
 * since the server started, so its budget is full. Exhausted is the state
 * the operator has to see: new renders answer the decoy until it refills.
 */
export function renderBudgetTone(budget: ShareRenderBudget | undefined): RenderBudgetTone {
  if (!budget) return "none";
  if (budget.exhausted) return "exhausted";
  if (budget.refused > 0 || budget.remaining <= Math.max(1, Math.floor(budget.burst / 4))) return "warning";
  return "quiet";
}

/**
 * What a share's fleet-feed warning says, if anything. "flagged": published
 * with the flag on purpose. "detected": its record now reads vpn-core's
 * identity-less export and nobody confirmed it (the record changed after the
 * share was made). "unchecked": the server cannot read Sub-Store's record
 * list, so it cannot tell.
 */
export type ShareFleetWarning = "flagged" | "detected" | "unchecked";

export function shareFleetWarning(
  share: Pick<SubscriptionShareView, "publishes_fleet_credentials" | "fleet_feed_now">,
): ShareFleetWarning | undefined {
  if (share.publishes_fleet_credentials) return "flagged";
  if (share.fleet_feed_now === "fleet") return "detected";
  if (share.fleet_feed_now === "unknown") return "unchecked";
  return undefined;
}

/**
 * Which case a fleet_feed_flag_required refusal is, from the body the server
 * sends beside the error. A body without the field is an older server, whose
 * only case was a fleet feed.
 */
export function fleetRefusalKind(body: unknown): "fleet" | "unchecked" {
  const kind = body && typeof body === "object" ? (body as FleetFeedRefusalBody).fleet_feed : undefined;
  return kind === "unknown" ? "unchecked" : "fleet";
}

/* ------------------------------------------------------------------ */
/* Identity links, projected beside the shares                         */
/* ------------------------------------------------------------------ */

export type IdentityLinkState = "active" | "never" | "placeholder" | "empty" | "paused" | "expired" | "none";

/**
 * One word for what an identity's link answers now, from the server's status
 * (lattice-server identity_link.go). The route facts (paused, expired) come
 * before the identity's own state; an active link that was never fetched
 * since the server started is told apart, because a link nobody has added
 * to a client is the common reason a user says it does not work.
 */
export function identityLinkState(status: Pick<IdentityLinkStatus, "issued" | "answer" | "answer_reason" | "last_fetch">): IdentityLinkState {
  if (!status.issued || status.answer_reason === "not_issued") return "none";
  if (status.answer_reason === "link_disabled") return "paused";
  if (status.answer_reason === "link_expired") return "expired";
  if (status.answer === "placeholder") return "placeholder";
  if (status.answer === "decoy") return "empty";
  return status.last_fetch ? "active" : "never";
}

const UA_FAMILIES: Record<string, string> = {
  clashmeta: "mihomo",
  clash: "Clash",
  stash: "Stash",
  singbox: "sing-box",
  shadowrocket: "Shadowrocket",
  surge: "Surge",
  quantumultx: "Quantumult X",
  egern: "Egern",
  loon: "Loon",
};

/** The client family a fetch's User-Agent was classified into, or "" for an unknown one. */
export function clientFamily(uaClass: string | undefined): string {
  return UA_FAMILIES[uaClass ?? ""] ?? "";
}

export type PlaceholderReason = "disabled" | "suspended" | "expired" | "quota" | "noLines" | "other";

/** Why an identity's link serves the placeholder, from the server's answer_reason. */
export function placeholderReason(answerReason: string): PlaceholderReason {
  switch (answerReason) {
    case "disabled":
      return "disabled";
    case "operator":
      return "suspended";
    case "expiry":
      return "expired";
    case "quota":
      return "quota";
    case "no_lines":
      return "noLines";
    default:
      return "other";
  }
}

/**
 * The slug an identity link is served under: the status's when it was read,
 * else the last segment of the route the server projects for it
 * (`sub/<slug>`), which every principal who can see the route can read.
 */
export function identityLinkSlug(
  record: Pick<PublishingRecord, "path_prefix">,
  status?: Pick<IdentityLinkStatus, "link">,
): string {
  if (status?.link?.slug) return status.link.slug;
  const parts = (record.path_prefix ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export type FetchFreshness = "fresh" | "stale" | "never";

/**
 * Whether the link's last fetch is recent. Fresh means within twice the
 * refresh the link advertises: a client past that has missed at least one
 * refresh, so it is off, offline or failing. Never means not since the
 * server last started, because the server keeps the last fetch in memory.
 */
export function fetchFreshness(
  status: Pick<IdentityLinkStatus, "last_fetch" | "link">,
  now: number = Date.now(),
): FetchFreshness {
  const at = status.last_fetch ? Date.parse(status.last_fetch.at) : Number.NaN;
  if (!Number.isFinite(at)) return "never";
  const interval = (status.link?.update_interval_hours || DEFAULT_UPDATE_INTERVAL_HOURS) * 3_600_000;
  return now - at <= interval * 2 ? "fresh" : "stale";
}

/**
 * The clients the serve path accepts, mirroring the server's bounded allowlist.
 * The target enters the render cache key on an endpoint that answers without
 * authentication, which is why the set is closed rather than free text.
 */
export const SHARE_TARGETS: ReadonlyArray<{ id: string; label: string; produces: string }> = [
  { id: "URI", label: "Universal (URI)", produces: "text" },
  { id: "Stash", label: "Stash", produces: "yaml" },
  { id: "ClashMeta", label: "mihomo", produces: "yaml" },
  { id: "Clash", label: "Clash", produces: "yaml" },
  { id: "Egern", label: "Egern", produces: "yaml" },
  { id: "Surge", label: "Surge", produces: "conf" },
  { id: "SurgeMac", label: "Surge Mac", produces: "conf" },
  { id: "Surfboard", label: "Surfboard", produces: "conf" },
  { id: "Loon", label: "Loon", produces: "conf" },
  { id: "Shadowrocket", label: "Shadowrocket", produces: "conf" },
  { id: "QX", label: "Quantumult X", produces: "conf" },
  { id: "sing-box", label: "sing-box", produces: "json" },
  { id: "V2Ray", label: "V2Ray", produces: "text" },
  { id: "JSON", label: "JSON", produces: "json" },
];
