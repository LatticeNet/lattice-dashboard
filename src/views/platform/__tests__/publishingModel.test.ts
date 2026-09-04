import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WORKERS_REDIRECT_TO,
  accessLegend,
  accessMode,
  arrivedFromWorkers,
  isFirstRun,
  isServing,
  originTarget,
  publishingState,
  recordsForShare,
  routeLabel,
  routePath,
  showOriginPrimer,
  sortRecords,
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

test("the origin primer does not tell an operator the plane is empty when they may not look at it", () => {
  // The server returns origins: [] when the caller holds none of kv:admin,
  // kv:read, static:admin or static:read, and the record list is empty for the
  // same reason. Gated on the records alone, the primer rendered its "nothing
  // is published yet" heading and taught three origins the operator has no
  // access to, directly above the card saying they cannot see any origin.
  assert.equal(
    showOriginPrimer({ loaded: true, visibleOrigins: [], records: [] }),
    false,
  );

  // A plane the operator can see, with nothing on it, is the run the primer
  // exists for.
  assert.equal(
    showOriginPrimer({ loaded: true, visibleOrigins: ["kv", "static", "plugin"], records: [] }),
    true,
  );
  assert.equal(
    showOriginPrimer({ loaded: true, visibleOrigins: ["static"], records: [] }),
    true,
  );

  // A route on the plane, reserved or not, means it has been published to.
  assert.equal(
    showOriginPrimer({
      loaded: true,
      visibleOrigins: ["kv", "static", "plugin"],
      records: [record({ reserved: true })],
    }),
    false,
  );

  // A load that failed or has not returned says nothing at all; the table owns
  // the error and loading states.
  assert.equal(
    showOriginPrimer({ loaded: false, visibleOrigins: [], records: [] }),
    false,
  );
  assert.equal(
    showOriginPrimer({ loaded: false, visibleOrigins: ["kv"], records: [] }),
    false,
  );
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
