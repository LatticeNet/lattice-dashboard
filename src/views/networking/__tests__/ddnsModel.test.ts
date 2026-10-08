import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessDdns,
  ddnsCommentMode,
  ddnsCounts,
  ddnsErrorText,
  ddnsInterval,
  ddnsMatchesShow,
  ddnsRunPreview,
  ddnsTemplateProblem,
  ddnsTime,
  DDNS_COMMENT_MAX_CHARS,
  DDNS_COMMENT_PLACEHOLDERS,
  DDNS_DEFAULT_COMMENT_TEMPLATE,
  insertDdnsPlaceholder,
  parseDdnsShow,
  renderDdnsComment,
  type DdnsCommentVars,
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

const VARS: DdnsCommentVars = {
  node: "tokyo-1",
  node_id: "node_7",
  profile: "home",
  domain: "a.io",
  type: "AAAA",
  ip: "2001:db8::2",
  old_ip: "2001:db8::1",
  lattice: "lat.io",
  now: Date.parse("2026-10-08T17:30:45+08:00"),
};

test("a profile saved before comments existed is in the default mode", () => {
  assert.equal(ddnsCommentMode(undefined), "default");
  assert.equal(ddnsCommentMode(""), "default");
  assert.equal(ddnsCommentMode("loud"), "default");
  assert.equal(ddnsCommentMode("custom"), "custom");
  assert.equal(ddnsCommentMode("none"), "none");
});

test("the preview fills every placeholder the way the server does, in UTC", () => {
  const tmpl = DDNS_COMMENT_PLACEHOLDERS.join("|");
  assert.equal(
    renderDdnsComment(tmpl, VARS).text,
    "tokyo-1|node_7|home|a.io|AAAA|2001:db8::2|2001:db8::1|2026-10-08 09:30Z|2026-10-08|lat.io",
  );
  assert.equal(renderDdnsComment(DDNS_DEFAULT_COMMENT_TEMPLATE, VARS).text, "Lattice DDNS for tokyo-1, 2026-10-08 09:30Z");
  // An unknown token next to a known one leaves the known one working.
  assert.equal(renderDdnsComment("#x#node#", VARS).text, "#xtokyo-1");
});

test("the preview is one line cut to 100 characters, never inside a character", () => {
  const out = renderDdnsComment(`#node# ${"节点".repeat(80)}`, { ...VARS, node: "东京\n一号" });
  assert.equal(out.chars, DDNS_COMMENT_MAX_CHARS);
  assert.equal(Array.from(out.text).length, DDNS_COMMENT_MAX_CHARS);
  assert.equal(out.fullChars, 166);
  assert.ok(out.text.startsWith("东京 一号 节点"));
  assert.ok(!/[\r\n]/.test(out.text));
  const short = renderDdnsComment("Lattice #node#", VARS);
  assert.equal(short.chars, short.fullChars);
});

test("a custom template is checked the way the server checks it", () => {
  assert.equal(ddnsTemplateProblem("Lattice #node# #ip# via #lattice#"), null);
  assert.equal(ddnsTemplateProblem("issue #42 fixed"), null);
  assert.deepEqual(ddnsTemplateProblem("  "), { kind: "empty" });
  assert.deepEqual(ddnsTemplateProblem("a\nb"), { kind: "lineBreak" });
  assert.deepEqual(ddnsTemplateProblem("x".repeat(201)), { kind: "tooLong", bytes: 201 });
  // Bytes, not characters: 67 three-byte characters are 201 bytes.
  assert.deepEqual(ddnsTemplateProblem("节".repeat(67)), { kind: "tooLong", bytes: 201 });
  assert.deepEqual(ddnsTemplateProblem("on #host#"), { kind: "unknown", placeholder: "#host#" });
});

test("a placeholder chip inserts at the caret and replaces a selection", () => {
  assert.deepEqual(insertDdnsPlaceholder("Lattice ", "#node#", 8, 8), { value: "Lattice #node#", caret: 14 });
  assert.deepEqual(insertDdnsPlaceholder("Lattice XX!", "#ip#", 8, 10), { value: "Lattice #ip#!", caret: 12 });
  assert.deepEqual(insertDdnsPlaceholder("abc", "#ip#", undefined, undefined), { value: "abc#ip#", caret: 7 });
});

test("a run error reads as sentences, not as Cloudflare's JSON", () => {
  const cname =
    "frontier.nat.aaitr.roobli.org already has a CNAME record pointing to nat-us-28tz.aproxy.top; a name cannot hold both. Remove that record in Cloudflare or use another name.";
  assert.equal(ddnsErrorText(cname), cname);
  assert.equal(
    ddnsErrorText('A home.example.com: cloudflare: api error (status 403): [{"code":10000,"message":"Authentication error"}]\nAAAA home.example.com: no cloudflare zone found for "home.example.com"'),
    'A home.example.com: Cloudflare refused it, HTTP 403: Authentication error (code 10000)\nAAAA home.example.com: no cloudflare zone found for "home.example.com"',
  );
  assert.equal(ddnsErrorText("A x: cloudflare: api error (status 500): not json"), "A x: cloudflare: api error (status 500): not json");
  assert.equal(ddnsErrorText(undefined), "");
  // The console passes its own wording for the refusal.
  assert.equal(
    ddnsErrorText('A x: cloudflare: api error (status 403): [{"code":10000,"message":"Authentication error"}]', (status, said) => `拒绝 ${status} ${said}`),
    "A x: 拒绝 403 Authentication error (code 10000)",
  );
});
