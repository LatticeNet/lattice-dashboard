/**
 * What the operator is actually looking at on the publish surface.
 *
 * A share is core-owned plumbing. Slug, token, source binding, format. And
 * none of those words answer the question an operator opens the page with:
 * which of my subscriptions are live on the internet right now, and what does
 * each one serve? This module turns the server's records into that answer, and
 * keeps the derivation testable away from the view.
 */
import type { SubscriptionShareView } from "@/lib/api";

export type PublishedState = "live" | "paused" | "expired" | "expiring";

/** How soon an expiry counts as worth warning about. */
export const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A disabled share and an expired one both stop serving, but only one of them
 * is a decision someone made. Keeping them apart is the difference between
 * "you turned this off" and "this lapsed while you weren't looking".
 */
export function publishedState(share: SubscriptionShareView, now: number = Date.now()): PublishedState {
  if (!share.enabled) return "paused";
  if (share.expires_at) {
    const expiry = Date.parse(share.expires_at);
    if (Number.isFinite(expiry)) {
      if (expiry <= now) return "expired";
      if (expiry - now <= EXPIRING_SOON_MS) return "expiring";
    }
  }
  return "live";
}

/** Only a live URL is worth handing to a client. */
export function isServing(share: SubscriptionShareView, now: number = Date.now()): boolean {
  const state = publishedState(share, now);
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

/** The path half of a share URL. The origin is whatever the browser is on. */
export function sharePath(share: SubscriptionShareView): string {
  return `/sub/${share.slug}/${share.token}`;
}

/**
 * A URL pinned to one client.
 *
 * Without ?target= the served bytes are chosen from the fetching client's
 * User-Agent, which is a guess that fails for curl, a downloader, or any client
 * the server has never seen. Naming the client makes the URL say what it
 * produces.
 */
export function clientUrl(origin: string, share: SubscriptionShareView, target: string): string {
  return `${origin}${sharePath(share)}?target=${encodeURIComponent(target)}`;
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
