import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clientFamily,
  clientUrl,
  fetchFreshness,
  fleetRefusalKind,
  identityLinkSlug,
  identityLinkState,
  intervalFieldError,
  intervalFieldFor,
  intervalFieldValue,
  isServing,
  maskedSharePath,
  maskedUrl,
  placeholderReason,
  publishedState,
  renderBudgetTone,
  revealedUrl,
  shareFleetWarning,
  sourceLabel,
} from "../publishedModel.ts";

const NOW = Date.parse("2026-08-18T12:00:00Z");

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: "sh1",
    slug: "team",
    source: { kind: "plugin", plugin_id: "latticenet.sub-store", subscription_id: "home" },
    enabled: true,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  } as never;
}

test("a paused share is not confused with a lapsed one", () => {
  // Both stop serving; only one of them is a decision someone made.
  assert.equal(publishedState(share({ enabled: false }), NOW), "paused");
  assert.equal(publishedState(share({ expires_at: "2026-08-17T00:00:00Z" }), NOW), "expired");
  assert.equal(publishedState(share(), NOW), "live");
});

test("an expiry inside the warning window is called out before it bites", () => {
  assert.equal(publishedState(share({ expires_at: "2026-08-20T00:00:00Z" }), NOW), "expiring");
  assert.equal(publishedState(share({ expires_at: "2026-09-30T00:00:00Z" }), NOW), "live");
  // An unparseable expiry must not silently read as expired and hide a URL
  // that is in fact still serving.
  assert.equal(publishedState(share({ expires_at: "not-a-date" }), NOW), "live");
});

test("only a serving share is worth handing to a client", () => {
  assert.equal(isServing(share(), NOW), true);
  assert.equal(isServing(share({ expires_at: "2026-08-20T00:00:00Z" }), NOW), true);
  assert.equal(isServing(share({ enabled: false }), NOW), false);
  assert.equal(isServing(share({ expires_at: "2026-08-17T00:00:00Z" }), NOW), false);
});

const proxyShare = (overrides: Record<string, unknown> = {}) =>
  share({ source: { kind: "core.proxy_user", proxy_user_id: "pu-1" }, ...overrides });

test("a share pointing at a proxy user the server does not have is unresolved", () => {
  // The share API accepts any id, and the URL 404s like an unknown path, so
  // the row is the only place the dangling binding can be seen.
  assert.equal(publishedState(proxyShare(), NOW, new Set(["pu-2"])), "unresolved");
  assert.equal(publishedState(proxyShare(), NOW, new Set()), "unresolved");
  assert.equal(publishedState(proxyShare(), NOW, new Set(["pu-1", "pu-2"])), "live");
  assert.equal(isServing(proxyShare(), NOW, new Set(["pu-2"])), false);
  assert.equal(isServing(proxyShare(), NOW, new Set(["pu-1"])), true);
});

test("an unknown user list never produces unresolved", () => {
  // No set means the list was not read or failed to load. Live over a failed
  // read is the honest answer; unresolved would be a confident wrong one.
  assert.equal(publishedState(proxyShare(), NOW), "live");
  assert.equal(publishedState(proxyShare(), NOW, undefined), "live");
  assert.equal(isServing(proxyShare(), NOW, undefined), true);
});

test("a plugin share has no proxy user to resolve", () => {
  assert.equal(publishedState(share(), NOW, new Set()), "live");
  assert.equal(publishedState(share({ expires_at: "2026-08-20T00:00:00Z" }), NOW, new Set()), "expiring");
});

test("unresolved outranks the serving states and yields to the stopped ones", () => {
  const missing = new Set<string>();
  // Expiring claims the URL answers today; for a dangling share it does not.
  assert.equal(publishedState(proxyShare({ expires_at: "2026-08-20T00:00:00Z" }), NOW, missing), "unresolved");
  // Paused is the operator's own decision and expired already says it stopped.
  assert.equal(publishedState(proxyShare({ enabled: false }), NOW, missing), "paused");
  assert.equal(publishedState(proxyShare({ expires_at: "2026-08-17T00:00:00Z" }), NOW, missing), "expired");
});

test("the source says who produces the bytes, with the id kept", () => {
  assert.equal(sourceLabel(share()), "latticenet.sub-store · home");
  assert.equal(
    sourceLabel(share({ source: { kind: "core.proxy_user", proxy_user_id: "pu-1" } })),
    "proxy user · pu-1",
  );
});

test("a share shows its path without the token until it is revealed", () => {
  assert.equal(maskedSharePath(share()), "/sub/team/…");
  // Even a server from before the rule, which still sends a token, shows none.
  assert.equal(maskedSharePath(share({ token: "t".repeat(32) })), "/sub/team/…");
});

test("a revealed link uses the server's URL, else the browser's origin, and cuts the token for display", () => {
  const path = `/sub/team/${"t".repeat(32)}`;
  assert.equal(revealedUrl("https://host", { path }), `https://host${path}`);
  assert.equal(revealedUrl("https://host", { path, url: `https://edge.example${path}` }), `https://edge.example${path}`);
  assert.equal(maskedUrl(`https://host${path}`), "https://host/sub/team/tttt…tttt");
  assert.equal(maskedUrl("https://host/sub/team/short"), "https://host/sub/team/short");
});

test("the client URL names the client and survives odd targets", () => {
  const url = `https://host/sub/team/${"t".repeat(32)}`;
  assert.equal(clientUrl(url, "sing-box"), `${url}?target=sing-box`);
  assert.match(clientUrl(url, "Surge Mac"), /target=Surge%20Mac$/);
});

test("the refresh interval field keeps the server's bounds and empty means the default", () => {
  assert.equal(intervalFieldError(""), "");
  assert.equal(intervalFieldError("6"), "");
  assert.equal(intervalFieldError("168"), "");
  assert.equal(intervalFieldError("0"), "range");
  assert.equal(intervalFieldError("169"), "range");
  assert.equal(intervalFieldError("1.5"), "range");
  assert.equal(intervalFieldValue(""), 0);
  assert.equal(intervalFieldValue(" 12 "), 12);
  assert.equal(intervalFieldFor({ update_interval_hours: 2 }), "");
  assert.equal(intervalFieldFor({ update_interval_hours: 12 }), "12");
  assert.equal(intervalFieldFor({}), "");
});

test("a render budget reads full, quiet, low or exhausted", () => {
  assert.equal(renderBudgetTone(undefined), "none");
  assert.equal(renderBudgetTone({ remaining: 20, burst: 24, per_hour: 60, exhausted: false, refused: 0 }), "quiet");
  assert.equal(renderBudgetTone({ remaining: 3, burst: 24, per_hour: 60, exhausted: false, refused: 0 }), "warning");
  assert.equal(renderBudgetTone({ remaining: 20, burst: 24, per_hour: 60, exhausted: false, refused: 2 }), "warning");
  assert.equal(renderBudgetTone({ remaining: 0, burst: 24, per_hour: 60, exhausted: true, refused: 9 }), "exhausted");
});

test("a share's fleet warning puts the operator's flag first, then what the server finds now", () => {
  assert.equal(shareFleetWarning({}), undefined);
  assert.equal(shareFleetWarning({ publishes_fleet_credentials: true }), "flagged");
  assert.equal(shareFleetWarning({ publishes_fleet_credentials: true, fleet_feed_now: "fleet" }), "flagged");
  assert.equal(shareFleetWarning({ fleet_feed_now: "fleet" }), "detected");
  assert.equal(shareFleetWarning({ fleet_feed_now: "unknown" }), "unchecked");
});

test("a fleet refusal is unchecked only when the server says it could not read the records", () => {
  assert.equal(fleetRefusalKind({ error: { code: "fleet_feed_flag_required" }, fleet_feed: "fleet", via: "Everyone" }), "fleet");
  assert.equal(fleetRefusalKind({ error: { code: "fleet_feed_flag_required" }, fleet_feed: "unknown" }), "unchecked");
  // An older server sends no verdict; its only refusal was a fleet feed.
  assert.equal(fleetRefusalKind({ error: { code: "fleet_feed_flag_required" } }), "fleet");
  assert.equal(fleetRefusalKind(undefined), "fleet");
});

test("an identity link's state puts the route facts first and tells never-fetched apart", () => {
  const base = { issued: true, answer: "nodes", answer_reason: "active" };
  assert.equal(identityLinkState({ ...base, last_fetch: { at: "2026-08-18T11:00:00Z", ua_class: "clashmeta", answer: "nodes" } }), "active");
  assert.equal(identityLinkState(base), "never");
  assert.equal(identityLinkState({ ...base, answer: "placeholder", answer_reason: "quota" }), "placeholder");
  assert.equal(identityLinkState({ ...base, answer: "decoy", answer_reason: "transient_empty" }), "empty");
  assert.equal(identityLinkState({ ...base, answer: "decoy", answer_reason: "link_disabled" }), "paused");
  assert.equal(identityLinkState({ ...base, answer: "decoy", answer_reason: "link_expired" }), "expired");
  assert.equal(identityLinkState({ issued: false, answer: "decoy", answer_reason: "not_issued" }), "none");
  assert.equal(clientFamily("clashmeta"), "mihomo");
  assert.equal(clientFamily("other"), "");
});

test("a placeholder names why the identity is out of service", () => {
  assert.equal(placeholderReason("operator"), "suspended");
  assert.equal(placeholderReason("expiry"), "expired");
  assert.equal(placeholderReason("quota"), "quota");
  assert.equal(placeholderReason("disabled"), "disabled");
  assert.equal(placeholderReason("no_lines"), "noLines");
  assert.equal(placeholderReason("something_new"), "other");
});

test("an identity link's slug comes from its status, else from the route the server projects", () => {
  assert.equal(identityLinkSlug({ path_prefix: "sub/u-k3v9q2m7xa" }), "u-k3v9q2m7xa");
  assert.equal(identityLinkSlug({ path_prefix: "/sub/u-k3v9q2m7xa/" }), "u-k3v9q2m7xa");
  assert.equal(
    identityLinkSlug({ path_prefix: "sub/u-old" }, { link: { slug: "u-renamed", enabled: true, issued_at: "", update_interval_hours: 2 } }),
    "u-renamed",
  );
  assert.equal(identityLinkSlug({}), "");
});

test("a last fetch is fresh within twice the advertised refresh, and never means not since the server started", () => {
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
  const link = (hours: number) => ({ slug: "u-a", enabled: true, issued_at: "", update_interval_hours: hours });
  assert.equal(fetchFreshness({ link: link(2) }, NOW), "never");
  assert.equal(fetchFreshness({ link: link(2), last_fetch: { at: at(3.9), ua_class: "clashmeta", answer: "nodes" } }, NOW), "fresh");
  assert.equal(fetchFreshness({ link: link(2), last_fetch: { at: at(4.1), ua_class: "clashmeta", answer: "nodes" } }, NOW), "stale");
  assert.equal(fetchFreshness({ link: link(12), last_fetch: { at: at(20), ua_class: "stash", answer: "nodes" } }, NOW), "fresh");
  // No link summary (a revoked link): the default refresh applies.
  assert.equal(fetchFreshness({ last_fetch: { at: at(5), ua_class: "other", answer: "decoy" } }, NOW), "stale");
});
