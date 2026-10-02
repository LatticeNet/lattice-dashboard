import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessDdns,
  ddnsCounts,
  ddnsInterval,
  ddnsMatchesShow,
  ddnsRunPreview,
  ddnsTime,
  parseDdnsShow,
  type DdnsProfileInput,
} from "../ddnsModel.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;

function profile(over: Partial<DdnsProfileInput> = {}): DdnsProfileInput {
  return {
    id: "ddns_1",
    node_id: "node_1",
    enable_ipv4: true,
    enable_ipv6: false,
    interval_seconds: 300,
    last_ipv4: "203.0.113.10",
    last_run_at: new Date(NOW - 120 * DAY).toISOString(),
    created_at: new Date(NOW - 200 * DAY).toISOString(),
    ...over,
  };
}

const up = { public_ip: "203.0.113.10", down: false };

test("a profile whose address held still is current however long ago it last ran", () => {
  const result = assessDdns(profile(), up, NOW);
  assert.equal(result.state, "current");
  assert.deepEqual(result.moved, []);
});

test("an address the sweep has not written for twice the interval is stale", () => {
  const moved = { public_ip: "203.0.113.44", down: false };
  assert.equal(assessDdns(profile(), moved, NOW).state, "stale");
  const result = assessDdns(profile({ last_run_at: new Date(NOW - 4 * MIN).toISOString() }), moved, NOW);
  assert.equal(result.state, "waiting");
  assert.deepEqual(result.moved, [{ family: "v4", published: "203.0.113.10", current: "203.0.113.44" }]);
});

test("the server default interval applies when a profile sets none", () => {
  assert.equal(ddnsInterval({ interval_seconds: 0 }), 300);
  assert.equal(ddnsInterval({}), 300);
  assert.equal(ddnsInterval({ interval_seconds: 3600 }), 3600);
  const moved = { public_ip: "203.0.113.44", down: false };
  // 11 minutes without a run: past 2 x 5 min.
  const recent = profile({ interval_seconds: 0, last_run_at: new Date(NOW - 11 * MIN).toISOString() });
  assert.equal(assessDdns(recent, moved, NOW).state, "stale");
});

test("a failing write outranks everything else", () => {
  const result = assessDdns(profile({ last_error: "A home.roobli.org: 401 Unauthorized" }), up, NOW);
  assert.equal(result.state, "failing");
});

test("a profile that never wrote is waiting, then stale", () => {
  const fresh = profile({ last_run_at: undefined, last_ipv4: "", created_at: new Date(NOW - 3 * MIN).toISOString() });
  assert.equal(assessDdns(fresh, up, NOW).state, "waiting");
  const old = profile({ last_run_at: "0001-01-01T00:00:00Z", last_ipv4: "", created_at: new Date(NOW - DAY).toISOString() });
  assert.equal(assessDdns(old, up, NOW).state, "stale");
  const nothing = assessDdns(old, { down: false }, NOW);
  assert.equal(nothing.state, "stale");
  assert.equal(nothing.noAddress, true);
});

test("an offline node and an unknown node are flagged, not guessed", () => {
  assert.equal(assessDdns(profile(), { ...up, down: true }, NOW).nodeDown, true);
  const unknown = assessDdns(profile(), undefined, NOW);
  assert.equal(unknown.nodeUnknown, true);
  assert.equal(unknown.state, "unchecked");
  assert.equal(assessDdns(profile({ last_error: "x" }), undefined, NOW).state, "failing");
});

test("counts partition the profiles and count down nodes on the side", () => {
  const list = [
    assessDdns(profile(), up, NOW),
    assessDdns(profile({ last_error: "boom" }), up, NOW),
    assessDdns(profile(), { public_ip: "203.0.113.44", down: true }, NOW),
  ];
  assert.deepEqual(ddnsCounts(list), { total: 3, current: 1, failing: 1, stale: 1, waiting: 0, unchecked: 0, nodeDown: 1 });
  assert.equal(ddnsMatchesShow(list[1]!, "failing"), true);
  assert.equal(ddnsMatchesShow(list[0]!, "failing"), false);
  assert.equal(ddnsMatchesShow(list[2]!, "down"), true);
});

test("show reads only the subsets it knows", () => {
  assert.equal(parseDdnsShow("stale"), "stale");
  assert.equal(parseDdnsShow(["down"]), "down");
  assert.equal(parseDdnsShow("bogus"), "all");
  assert.equal(parseDdnsShow(undefined), "all");
});

test("the run preview lists every record a run writes, skipping a family with no address", () => {
  const preview = ddnsRunPreview(
    { ...profile({ enable_ipv6: true, last_ipv6: "" }), domains: ["home.roobli.org", "nas.roobli.org"] },
    { public_ip: "203.0.113.44" },
  );
  assert.deepEqual(preview, [
    { domain: "home.roobli.org", type: "A", value: "203.0.113.44", previous: "203.0.113.10" },
    { domain: "nas.roobli.org", type: "A", value: "203.0.113.44", previous: "203.0.113.10" },
  ]);
});

test("zero and unparsable times read as never", () => {
  assert.equal(ddnsTime("0001-01-01T00:00:00Z"), null);
  assert.equal(ddnsTime("nope"), null);
  assert.equal(ddnsTime(undefined), null);
  assert.equal(ddnsTime("2026-09-30T12:00:00Z"), NOW);
});
