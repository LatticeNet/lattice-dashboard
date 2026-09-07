import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PUBLISHING_LENSES,
  SHARES_REDIRECT_PATH,
  WORKERS_REDIRECT_TO,
  accessLegend,
  accessMode,
  arrivedFromWorkers,
  hasShareCreateDeepLink,
  isFirstRun,
  isServing,
  lensOrigin,
  originTarget,
  originTargetLabel,
  publishablePlugins,
  publishingPlaneEmpty,
  publishingState,
  recordsForLens,
  recordsForShare,
  routeLabel,
  routePath,
  shareCreateTarget,
  shareRefreshable,
  shareRendererState,
  sharesRedirectTarget,
  sortRecords,
  withoutShareDeepLink,
} from "../publishingModel.ts";

const NOW = new Date("2026-08-19T12:00:00Z");

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "bind_1",
    origin: "static",
    bucket: "site",
    hostname: "site.example",
    any_host: false,
    enabled: true,
    reserved: false,
    admin_scope: "static:admin",
    ...overrides,
  } as never;
}

test("a route turned off is not the same problem as one that lapsed", () => {
  assert.equal(publishingState(record({ enabled: false }), NOW), "disabled");
  assert.equal(publishingState(record({ expires_at: "2026-08-18T00:00:00Z" }), NOW), "expired");
  assert.equal(publishingState(record({ expires_at: "2026-08-20T00:00:00Z" }), NOW), "serving");
  assert.equal(publishingState(record(), NOW), "serving");
});

test("expiry is exclusive at the boundary, matching the server", () => {
  // The server refuses to serve once now is no longer before the expiry, so a
  // route whose expiry is exactly now reads as expired here too.
  assert.equal(publishingState(record({ expires_at: NOW.toISOString() }), NOW), "expired");
  assert.equal(isServing(record({ expires_at: NOW.toISOString() }), NOW), false);
});

test("a path is always rooted and never carries a trailing slash", () => {
  assert.equal(routePath(record()), "/");
  assert.equal(routePath(record({ path_prefix: "docs" })), "/docs");
  assert.equal(routePath(record({ path_prefix: "/docs/" })), "/docs");
  assert.equal(routePath(record({ path_prefix: "sub/cd-self" })), "/sub/cd-self");
});

test("a route on every host says so rather than showing an empty hostname", () => {
  // A blank cell would read as missing data. Answering on every host is a fact
  // about the route, and the subscription mount depends on it.
  assert.equal(
    routeLabel(record({ any_host: true, hostname: "", path_prefix: "sub/cd-self" }), "any host"),
    "any host/sub/cd-self",
  );
  assert.equal(routeLabel(record({ path_prefix: "docs" })), "site.example/docs");
  assert.equal(routeLabel(record()), "site.example");
});

test("a plugin route points at its share, not at a bucket name", () => {
  assert.equal(originTarget(record({ origin: "plugin", bucket: "share_1", share_id: "share_1" })), "share_1");
  assert.equal(originTarget(record()), "site");
});

test("a plugin route is named by its share's slug the way the Shares lens names it", () => {
  const route = record({ origin: "plugin", bucket: "share_1", share_id: "share_1" });
  const slugs = new Map([["share_1", "team-nodes"]]);
  assert.equal(originTargetLabel(route, slugs), "/team-nodes");
  // No list, or an id the list does not have: the id, not a guess.
  assert.equal(originTargetLabel(route), "share_1");
  assert.equal(originTargetLabel(route, new Map([["share_2", "other"]])), "share_1");
  // Buckets are never renamed by the share list.
  assert.equal(originTargetLabel(record(), new Map([["site", "nope"]])), "site");
});

test("routes group by origin so the table does not interleave them", () => {
  const rows = sortRecords([
    record({ id: "c", origin: "plugin", hostname: "", any_host: true, path_prefix: "sub/b" }),
    record({ id: "a", origin: "static", hostname: "z.example" }),
    record({ id: "b", origin: "kv", hostname: "a.example" }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.origin),
    ["kv", "static", "plugin"],
  );
});

test("a share's routes come from the plane, not from a second idea of the URL", () => {
  const rows = [
    record({ id: "1", origin: "plugin", share_id: "share_1", path_prefix: "sub/one" }),
    record({ id: "2", origin: "plugin", share_id: "share_2", path_prefix: "sub/two" }),
    record({ id: "3", origin: "static", bucket: "site" }),
  ];
  const mine = recordsForShare(rows, "share_1");
  assert.equal(mine.length, 1);
  assert.equal(routePath(mine[0]), "/sub/one");
  assert.equal(recordsForShare(rows, "missing").length, 0);
});

test("each origin carries its own answer to who may read it", () => {
  // The three differ on the server and the table used to present them as one
  // kind of thing: a KV route runs authorizeStorageToken on GET, a static
  // route is anonymous public hosting, a share is a bearer token in the URL.
  assert.equal(accessMode(record({ origin: "kv" })), "storage_token");
  assert.equal(accessMode(record({ origin: "static" })), "anonymous");
  assert.equal(accessMode(record({ origin: "plugin" })), "share_token");
});

test("an origin this console has never heard of is not guessed at", () => {
  // Printing "anonymous" for a route that is not is the one wrong answer on
  // this page an operator could act on and not recover from.
  assert.equal(accessMode(record({ origin: "worker" })), "unknown");
  assert.equal(accessMode(record({ origin: "" })), "unknown");
});

test("a route that exists ends the first run, reserved or not", () => {
  // Reserved is the server saying the operator cannot move or delete this
  // route from this page: publishingRecordFromShare sets it on every share.
  // It is not a claim that nobody published anything, because a share only
  // exists because an operator created it in the Publish dialog. Production
  // runs exactly one record, a reserved share that is serving, and treating
  // reserved as "not published on purpose" printed "nothing is published yet"
  // directly above it.
  assert.equal(isFirstRun([]), true);
  assert.equal(isFirstRun([record({ reserved: true })]), false);
  assert.equal(isFirstRun([record({ reserved: false })]), false);
  assert.equal(isFirstRun([record({ reserved: true }), record({ reserved: false })]), false);
});

test("the plane does not read as empty to an operator who may not look at it", () => {
  // The server returns origins: [] when the caller holds none of kv:admin,
  // kv:read, static:admin or static:read, and the record list is empty for the
  // same reason. Gated on the records alone, the page claimed the plane was
  // empty directly above the card saying they cannot see any origin. The guide
  // opens on its own only when the plane really is empty.
  assert.equal(
    publishingPlaneEmpty({ loaded: true, visibleOrigins: [], records: [] }),
    false,
  );

  // A plane the operator can see, with nothing on it, is the run the guide
  // opens for.
  assert.equal(
    publishingPlaneEmpty({ loaded: true, visibleOrigins: ["kv", "static", "plugin"], records: [] }),
    true,
  );
  assert.equal(
    publishingPlaneEmpty({ loaded: true, visibleOrigins: ["static"], records: [] }),
    true,
  );

  // A route on the plane, reserved or not, means it has been published to.
  assert.equal(
    publishingPlaneEmpty({
      loaded: true,
      visibleOrigins: ["kv", "static", "plugin"],
      records: [record({ reserved: true })],
    }),
    false,
  );

  // A load that failed or has not returned says nothing at all; the table owns
  // the error and loading states.
  assert.equal(
    publishingPlaneEmpty({ loaded: false, visibleOrigins: [], records: [] }),
    false,
  );
  assert.equal(
    publishingPlaneEmpty({ loaded: false, visibleOrigins: ["kv"], records: [] }),
    false,
  );
});

test("each lens narrows the table to one origin, and all passes the plane through", () => {
  // The share lens is named for the record the operator manages there; the
  // server still calls the origin "plugin", and an origin the console has never
  // heard of stays visible on the whole plane rather than vanishing.
  const rows = [
    record({ id: "k", origin: "kv" }),
    record({ id: "s", origin: "static" }),
    record({ id: "p", origin: "plugin", share_id: "share_1" }),
    record({ id: "w", origin: "worker" }),
  ];
  assert.deepEqual(PUBLISHING_LENSES, ["all", "kv", "static", "share"]);
  assert.equal(lensOrigin("all"), undefined);
  assert.equal(lensOrigin("share"), "plugin");
  assert.deepEqual(recordsForLens(rows, "all").map((r) => r.id), ["k", "s", "p", "w"]);
  assert.deepEqual(recordsForLens(rows, "kv").map((r) => r.id), ["k"]);
  assert.deepEqual(recordsForLens(rows, "static").map((r) => r.id), ["s"]);
  assert.deepEqual(recordsForLens(rows, "share").map((r) => r.id), ["p"]);
});

test("the retired shares path lands on the share lens with its query intact", () => {
  // Sub-Store's "publish a share for this subscription" button still sends the
  // operator to /network/subscription-shares?create=1&for=<record>. The
  // redirect has to carry both keys, or the plugin needs a release for the
  // dialog to keep opening on the right record.
  assert.equal(SHARES_REDIRECT_PATH, "/platform/publishing");
  assert.deepEqual(sharesRedirectTarget({ create: "1", for: "openjobs-host" }), {
    path: "/platform/publishing",
    query: { create: "1", for: "openjobs-host", origin: "share" },
  });
  assert.deepEqual(sharesRedirectTarget({}), {
    path: "/platform/publishing",
    query: { origin: "share" },
  });
  // Only the deep-link pair rides through. A bookmark carrying its own lens is
  // corrected (the old page had one origin) and anything else the old URL held
  // is dropped rather than parked in the new address bar.
  assert.deepEqual(sharesRedirectTarget({ origin: "kv", q: "team", create: "1" }).query, {
    create: "1",
    origin: "share",
  });
});

test("the router wires the old path through the redirect helper", () => {
  // The helper above is only worth its test if the route table actually uses
  // it. Read the router source rather than boot Vue for one line.
  const router = readFileSync(new URL("../../../router/index.ts", import.meta.url), "utf8");
  assert.match(router, /path: "network\/subscription-shares"/);
  assert.match(router, /sharesRedirectTarget\(to\.query\)/);
});

test("the create deep link is recognised by its exact marker and consumed onto the share lens", () => {
  assert.equal(hasShareCreateDeepLink({ create: "1", for: "x" }), true);
  assert.equal(hasShareCreateDeepLink({ create: ["1"] }), true);
  assert.equal(hasShareCreateDeepLink({ create: "true" }), false);
  assert.equal(hasShareCreateDeepLink({ for: "x" }), false);
  assert.equal(hasShareCreateDeepLink({}), false);

  assert.equal(shareCreateTarget({ create: "1", for: " openjobs-host " }), "openjobs-host");
  assert.equal(shareCreateTarget({ create: "1" }), "");

  // Consuming the link drops both keys so a reload does not reopen the dialog,
  // and pins the lens so the pane that owns the dialog stays mounted.
  assert.deepEqual(withoutShareDeepLink({ create: "1", for: "x", q: "team" }), { q: "team", origin: "share" });
  assert.deepEqual(withoutShareDeepLink({ create: "1", origin: "all" }), { origin: "share" });
});

test("a share names whether its renderer is there, from the plugin list the picker reads", () => {
  const pluginShare = { source: { kind: "plugin", plugin_id: "latticenet.sub-store", subscription_id: "s1" } } as const;
  const userShare = { source: { kind: "core.proxy_user", proxy_user_id: "u1" } } as const;
  const installed = [{ id: "latticenet.sub-store", active: true }];
  const disabled = [{ id: "latticenet.sub-store", active: false }];
  const other = [{ id: "latticenet.vpn-core", active: true }];

  // A proxy-user share is server-native: no plugin renders it, so no plugin can
  // be missing for it, whatever the list says.
  assert.equal(shareRendererState(userShare, undefined), "native");
  assert.equal(shareRendererState(userShare, []), "native");

  assert.equal(shareRendererState(pluginShare, installed), "ready");
  assert.equal(shareRendererState(pluginShare, disabled), "inactive");
  assert.equal(shareRendererState(pluginShare, other), "missing");
  assert.equal(shareRendererState(pluginShare, []), "missing");
  // No list yet, or a failed load, is not evidence of absence.
  assert.equal(shareRendererState(pluginShare, undefined), "unknown");
  // A server predating the active flag still counts its plugins as present.
  assert.equal(shareRendererState(pluginShare, [{ id: "latticenet.sub-store" }]), "ready");
});

test("refresh needs a renderer that can answer", () => {
  // The gateway refuses a call to an absent or inactive plugin, so the button
  // is disabled with that reason instead of failing after the click. A native
  // share has no provider to refresh from at all.
  assert.equal(shareRefreshable("ready"), true);
  assert.equal(shareRefreshable("unknown"), true);
  assert.equal(shareRefreshable("inactive"), false);
  assert.equal(shareRefreshable("missing"), false);
  assert.equal(shareRefreshable("native"), false);
});

test("a new plugin share can only be created against an active plugin that declares subscription:serve", () => {
  const serve = { id: "latticenet.sub-store", capabilities: ["kv:read", "subscription:serve"], active: true };
  const disabledServe = { id: "old", capabilities: ["subscription:serve"], active: false };
  const noServe = { id: "latticenet.vpn-core", capabilities: ["proxy:admin"], active: true };
  const legacy = { id: "legacy", capabilities: ["subscription:serve"] };
  assert.deepEqual(publishablePlugins([serve, disabledServe, noServe, legacy]).map((p) => p.id), [
    "latticenet.sub-store",
    "legacy",
  ]);
  // Plugin absent: nothing to pick, so the dialog says why and offers only
  // proxy-user shares.
  assert.deepEqual(publishablePlugins([noServe]), []);
  assert.deepEqual(publishablePlugins(undefined), []);
});

test("the access column explains itself without a pointer", () => {
  // The badge carries its sentence in a title attribute on a span nothing can
  // focus, and the primer that repeats it is gone as soon as a route exists.
  // A keyboard or touch operator had no way left to learn what "Storage token"
  // means, so the legend under the table lists every mode the table is
  // actually showing, in the order the rows are grouped in.
  const rows = [
    record({ origin: "static" }),
    record({ origin: "plugin" }),
    record({ origin: "kv" }),
    record({ origin: "static", hostname: "other.example" }),
  ];
  assert.deepEqual(accessLegend(rows), ["storage_token", "anonymous", "share_token"]);
  assert.deepEqual(accessLegend([record({ origin: "static" })]), ["anonymous"]);
  assert.deepEqual(accessLegend([]), []);
});

test("an origin the console cannot read is explained too, and explained last", () => {
  // The unknown badge is the one an operator is most likely to stop at, so the
  // legend has to carry its line rather than leaving the odd row unexplained.
  assert.deepEqual(accessLegend([record({ origin: "worker" }), record({ origin: "kv" })]), [
    "storage_token",
    "unknown",
  ]);
});

test("old Workers links land on Publishing and say so", () => {
  // Store was the first redirect target and it answers a different question.
  // The job Workers was held for was serving content at a URL.
  assert.equal(WORKERS_REDIRECT_TO.path, "/platform/publishing");
  assert.equal(arrivedFromWorkers(WORKERS_REDIRECT_TO.query), true);
  assert.equal(arrivedFromWorkers({ from: ["workers"] }), true);
  assert.equal(arrivedFromWorkers({}), false);
  assert.equal(arrivedFromWorkers({ from: "store" }), false);
  assert.equal(arrivedFromWorkers({ q: "workers" }), false);
});
