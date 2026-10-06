import assert from "node:assert/strict";
import test from "node:test";

import type { WitnessNodeView, WitnessReport, WitnessStatusResponse } from "../../../lib/api/types.ts";
import {
  barkChannels,
  channelFallbackChoices,
  channelFallbackForSave,
  isLoopbackBaseURL,
  isWitnessHealthURL,
  witnessAttention,
  witnessConfigState,
  witnessConfiguredCount,
  witnessFormDefaults,
  witnessFormProblems,
  witnessLine,
  witnessPlanRequest,
  witnessPushLine,
  witnessWatch,
  type WitnessForm,
} from "../witnessModel.ts";

const applied = {
  approval_id: "approval_1",
  action: "configure",
  status: "applied",
  config_sha256: "a".repeat(64),
  channel_id: "ch_bark_urgent",
  channel_name: "Bark urgent",
  key_sha256_prefix: "41b88fb74e0a",
  created_at: "2026-10-03T03:00:00Z",
};

function report(over: Partial<WitnessReport> = {}): WitnessReport {
  return {
    version: 1,
    config_sha256: "a".repeat(64),
    phase: "watching",
    last_check_at: "2026-10-03T04:00:00Z",
    last_check_ok: true,
    alerted: false,
    last_push_ok: true,
    ...over,
  };
}

function node(over: Partial<WitnessNodeView> = {}): WitnessNodeView {
  return {
    node_id: "node_pulse",
    node_name: "[cd]-gomami-jpn-pulse-nano",
    capable: true,
    configured: applied,
    report: report(),
    reported_at: "2026-10-03T04:00:05Z",
    report_fresh: true,
    check_stale: false,
    config_matches: true,
    ...over,
  };
}

// One sentence per node, chosen from what the server knows: no plan, a plan
// waiting, an applied plan with no report, a report gone stale, then the
// witness's own phase.
test("witnessLine follows the plan, the relay and the phase", () => {
  assert.equal(witnessLine(node({ configured: undefined, report: undefined, report_fresh: false })).key, "notConfigured");
  assert.equal(witnessLine(node({ configured: undefined, report: undefined, report_fresh: false, pending: { ...applied, status: "pending" } })).key, "planned");
  assert.deepEqual(witnessLine(node({ report: undefined, report_fresh: false })), { key: "neverReported", tone: "warning" });
  assert.equal(witnessLine(node({ report_fresh: false })).key, "notReporting");
  assert.equal(witnessLine(node()).key, "watching");
  const failing = witnessLine(node({ report: report({ phase: "failing", failing_since: "2026-10-03T03:58:00Z", consecutive_failures: 3, last_check_detail: "http 503" }) }));
  assert.deepEqual([failing.key, failing.tone, failing.failures, failing.detail], ["failing", "warning", 3, "http 503"]);
  const down = witnessLine(node({ report: report({ phase: "down", alerted: true, alerted_at: "2026-10-03T03:59:00Z", down_since: "2026-10-03T03:56:00Z" }) }));
  assert.deepEqual([down.key, down.tone, down.since, down.at], ["down", "danger", "2026-10-03T03:56:00Z", "2026-10-03T03:59:00Z"]);
  assert.equal(witnessLine(node({ report: report({ phase: "network_down" }) })).key, "networkDown");
  assert.equal(witnessLine(node({ report: report({ phase: "unknown" }) })).key, "unknown");
  // A witness still reporting with no applied plan on record (an old plan
  // pruned, a restored server) is shown by what it says, not as absent.
  assert.equal(witnessLine(node({ configured: undefined })).key, "watching");
});

// The agent relays the status file whether or not the witness is alive. A
// fresh relay of a status the witness stopped updating is a dead witness:
// whatever phase it last wrote ("watching", or "down" forever), it reads as
// stopped and is raised.
test("a fresh relay of an old status reads as a stopped witness", () => {
  const old = report({ last_check_at: "2026-10-03T03:40:00Z", relayed_at: "2026-10-03T04:00:00Z" });
  const stopped = witnessLine(node({ check_stale: true, report: old }));
  assert.deepEqual(stopped, { key: "stopped", tone: "warning", at: "2026-10-03T03:40:00Z" });
  const stuckDown = witnessLine(node({ check_stale: true, report: report({ ...old, phase: "down", alerted: true, alerted_at: "2026-10-03T03:30:00Z" }) }));
  assert.equal(stuckDown.key, "stopped");
  // Never checked at all: the start is the last sign of life.
  assert.equal(witnessLine(node({ check_stale: true, report: report({ last_check_at: undefined, started_at: "2026-10-03T03:20:00Z" }) })).at, "2026-10-03T03:20:00Z");
  // A relay that itself went quiet says so first; the witness may be fine.
  assert.equal(witnessLine(node({ check_stale: true, report_fresh: false })).key, "notReporting");
  const kinds = witnessAttention([node({ node_id: "a" }), node({ node_id: "b", check_stale: true, report: old })]).map((item) => `${item.node.node_id}:${item.kind}`);
  assert.deepEqual(kinds, ["b:stopped"]);
});

test("witnessPushLine names the last push or none", () => {
  assert.equal(witnessPushLine(undefined), undefined);
  assert.deepEqual(witnessPushLine(report()), { key: "none", ok: true, pushes: 0 });
  assert.deepEqual(witnessPushLine(report({ last_push_at: "2026-10-03T03:59:00Z", last_push_kind: "down", last_push_ok: false, last_push_error: "http 400", pushes: 1 })), {
    key: "down",
    ok: false,
    at: "2026-10-03T03:59:00Z",
    error: "http 400",
    pushes: 1,
  });
});

test("witnessConfigState compares only what can be compared", () => {
  assert.equal(witnessConfigState(node()), "matches");
  assert.equal(witnessConfigState(node({ config_matches: false })), "differs");
  assert.equal(witnessConfigState(node({ report_fresh: false })), "unknown");
  assert.equal(witnessConfigState(node({ configured: undefined })), "unknown");
  assert.equal(witnessConfigState(node({ report: report({ config_sha256: undefined }), config_matches: false })), "unknown");
});

// Worst first, and a quiet witness says nothing at all.
test("witnessAttention raises only what needs the operator", () => {
  assert.deepEqual(witnessAttention([node()]), []);
  const kinds = witnessAttention([
    node({ node_id: "a", report_fresh: false }),
    node({ node_id: "b", report: report({ phase: "down", alerted: true }) }),
    node({ node_id: "c", config_matches: false, report: report({ last_push_at: "2026-10-03T03:00:00Z", last_push_kind: "recovery", last_push_ok: false }) }),
    node({ node_id: "d", last_failed: { ...applied, status: "rejected", reason: "exit_code=1" } }),
  ]).map((item) => `${item.node.node_id}:${item.kind}`);
  assert.deepEqual(kinds, ["b:down", "a:notReporting", "c:pushFailed", "c:differs", "d:planFailed"]);
  assert.equal(witnessConfiguredCount({ nodes: [node(), node({ configured: undefined })] } as WitnessStatusResponse), 1);
  assert.equal(witnessConfiguredCount(undefined), 0);
});

// The bark-server must be on the node's loopback, as the server and the
// witness both insist, so the device key never leaves the node.
test("isLoopbackBaseURL accepts only a bare loopback base", () => {
  for (const ok of ["http://127.0.0.1:7001", "http://127.0.0.5:8080/", "https://localhost:8443", "http://[::1]:8080"]) assert.equal(isLoopbackBaseURL(ok), true, ok);
  for (const bad of ["https://bark.example.com", "http://10.0.0.1:8080", "http://127.0.0.1:7001/?k=1", "ftp://127.0.0.1", "http://u:p@127.0.0.1", "127.0.0.1:7001", ""]) {
    assert.equal(isLoopbackBaseURL(bad), false, bad);
  }
});

const status: WitnessStatusResponse = {
  health_url: "https://lattice.example.org/readyz",
  nodes: [],
  capable_nodes: [{ node_id: "node_pulse", node_name: "[cd]-gomami-jpn-pulse-nano", online: true }],
  defaults: {
    reference_urls: ["https://www.cloudflare.com/cdn-cgi/trace", "https://www.apple.com/library/test/success.html"],
    interval_seconds: 30,
    hold_seconds: 180,
    recover_seconds: 60,
    bark_level: "critical",
    bark_levels: ["active", "timeSensitive", "passive", "critical"],
    key_file: "/etc/lattice-witness/bark-device-key",
    config_file: "/etc/lattice-witness/witness.json",
    unit: "lattice-witness.service",
  },
};
const channels = [
  { id: "ch_tg", name: "Telegram", kind: "telegram" },
  { id: "ch_bark_urgent", name: "Bark urgent", kind: "bark" },
];

test("witnessFormDefaults picks the only node and Bark channel and leaves the bark-server URL to the operator", () => {
  const form = witnessFormDefaults(status, channels);
  assert.equal(form.nodeId, "node_pulse");
  assert.equal(form.channelId, "ch_bark_urgent");
  assert.equal(form.barkUrl, "");
  assert.equal(form.references, status.defaults.reference_urls.join("\n"));
  assert.deepEqual([form.interval, form.hold, form.recover, form.barkLevel], ["30", "180", "60", "critical"]);
  const two = witnessFormDefaults({ ...status, capable_nodes: [...status.capable_nodes, { node_id: "x", node_name: "x", online: true }] }, [...channels, { id: "ch_bark_info", name: "Bark info", kind: "bark" }]);
  assert.deepEqual([two.nodeId, two.channelId], ["", ""]);
  // A change starts from the applied plan's node and channel.
  const change = witnessFormDefaults({ ...status, capable_nodes: [] }, [...channels, { id: "ch_bark_info", name: "Bark info", kind: "bark" }], node());
  assert.deepEqual([change.nodeId, change.channelId], ["node_pulse", "ch_bark_urgent"]);
  assert.deepEqual(barkChannels(channels).map((c) => c.id), ["ch_bark_urgent"]);
});

// A new setup watches the default; a change keeps an operator's watch URL, so
// changing the timing never points the witness back at an address it cannot
// reach, and a plan that watched the default leaves the field empty.
test("witnessFormDefaults starts the watch URL empty unless the applied plan set one", () => {
  assert.equal(witnessFormDefaults(status, channels).healthUrl, "");
  const ready = "https://lattice-ready.example.org/readyz";
  assert.equal(witnessFormDefaults(status, channels, node({ configured: { ...applied, health_url: ready } })).healthUrl, ready);
  assert.equal(witnessFormDefaults(status, channels, node({ configured: { ...applied, health_url: status.health_url } })).healthUrl, "");
  assert.equal(witnessFormDefaults(status, channels, node()).healthUrl, "");
});

// The same rule the server applies to health_url.
test("isWitnessHealthURL accepts only an https /readyz with nothing after it", () => {
  for (const ok of [
    "https://lattice-ready.example.org/readyz",
    " https://lattice-ready.example.org/readyz ",
    "HTTPS://lattice-ready.example.org/readyz",
    "https://lattice-ready.example.org:8443/readyz",
    "https://[2001:db8::1]/readyz",
  ]) {
    assert.equal(isWitnessHealthURL(ok), true, ok);
  }
  for (const bad of [
    "",
    "http://lattice-ready.example.org/readyz",
    "http://127.0.0.1:8080/readyz",
    "ftp://lattice-ready.example.org/readyz",
    "lattice-ready.example.org/readyz",
    "https://lattice-ready.example.org",
    "https://lattice-ready.example.org/",
    "https://lattice-ready.example.org/healthz",
    "https://lattice-ready.example.org/readyz/",
    "https://lattice-ready.example.org/READYZ",
    "https://lattice-ready.example.org/x/readyz",
    "https://lattice-ready.example.org/./readyz",
    "https://lattice-ready.example.org/ready%7Az",
    "https://lattice-ready.example.org/readyz?probe=1",
    "https://lattice-ready.example.org/readyz?",
    "https://lattice-ready.example.org/readyz#top",
    "https://lattice-ready.example.org/readyz#",
    "https://ops:secret@lattice-ready.example.org/readyz",
    "https://ops@lattice-ready.example.org/readyz",
    "https://lattice ready.example.org/readyz",
    "https:///readyz",
  ]) {
    assert.equal(isWitnessHealthURL(bad), false, bad);
  }
});

// Per node: what the applied plan wrote, else what the witness reports, else
// the server's default; marked when it is not the default.
test("witnessWatch names what each witness watches", () => {
  const def = status.health_url;
  const ready = "https://lattice-ready.example.org/readyz";
  assert.deepEqual(witnessWatch(node({ configured: { ...applied, health_url: ready } }), def), { url: ready, custom: true });
  assert.deepEqual(witnessWatch(node({ configured: { ...applied, health_url: def } }), def), { url: def, custom: false });
  // An applied plan from before the field existed: the witness's own report.
  assert.deepEqual(witnessWatch(node({ report: report({ health_url: ready }) }), def), { url: ready, custom: true });
  assert.deepEqual(witnessWatch(node(), def), { url: def, custom: false });
  assert.equal(witnessWatch(node({ configured: undefined, report: undefined }), undefined), undefined);
});

test("witnessFormProblems mirrors the witness bounds", () => {
  const good: WitnessForm = { ...witnessFormDefaults(status, channels), barkUrl: "http://127.0.0.1:7001" };
  assert.deepEqual(witnessFormProblems(good), []);
  assert.deepEqual(witnessFormProblems({ ...good, nodeId: "", channelId: "", barkUrl: "" }), ["node", "channel", "barkUrl"]);
  assert.deepEqual(witnessFormProblems({ ...good, barkUrl: "https://bark.example.com" }), ["barkUrlLoopback"]);
  assert.deepEqual(witnessFormProblems({ ...good, references: "https://a.example\nhttps://b.example\nhttps://c.example\nhttps://d.example" }), ["references"]);
  assert.deepEqual(witnessFormProblems({ ...good, references: "http://example.com" }), ["references"]);
  assert.deepEqual(witnessFormProblems({ ...good, references: "" }), []);
  assert.deepEqual(witnessFormProblems({ ...good, interval: "5" }), ["interval"]);
  assert.deepEqual(witnessFormProblems({ ...good, interval: "60", hold: "90", recover: "30" }), ["hold", "recover"]);
  assert.deepEqual(witnessFormProblems({ ...good, hold: "3601" }), ["hold"]);
  assert.deepEqual(witnessFormProblems({ ...good, recover: "1.5" }), ["recover"]);
  assert.deepEqual(witnessFormProblems({ ...good, healthUrl: "  " }), []);
  assert.deepEqual(witnessFormProblems({ ...good, healthUrl: "https://lattice-ready.example.org/readyz" }), []);
  assert.deepEqual(witnessFormProblems({ ...good, healthUrl: "https://lattice-ready.example.org/healthz", interval: "5" }), ["healthUrl", "interval"]);
});

test("witnessPlanRequest trims, parses and leaves empty references to the server", () => {
  const form: WitnessForm = { ...witnessFormDefaults(status, channels), barkUrl: " http://127.0.0.1:7001/ ", references: "\n https://one.example \n\n" };
  assert.deepEqual(witnessPlanRequest(form), {
    node_id: "node_pulse",
    channel_id: "ch_bark_urgent",
    bark_url: "http://127.0.0.1:7001",
    bark_level: "critical",
    reference_urls: ["https://one.example"],
    interval_seconds: 30,
    hold_seconds: 180,
    recover_seconds: 60,
  });
  assert.equal(witnessPlanRequest({ ...form, references: "" }).reference_urls, undefined);
  // health_url is sent only when set, trimmed: an a118 server refuses the unknown field.
  assert.equal("health_url" in witnessPlanRequest(form), false);
  assert.equal("health_url" in witnessPlanRequest({ ...form, healthUrl: "   " }), false);
  assert.equal(witnessPlanRequest({ ...form, healthUrl: " https://lattice-ready.example.org/readyz " }).health_url, "https://lattice-ready.example.org/readyz");
});

// A channel may hand critical messages to any other channel; clearing sends
// "" only when there was one, so an older server never sees the field.
test("channel fallback choices and save value", () => {
  assert.deepEqual(channelFallbackChoices(channels, "ch_bark_urgent").map((c) => c.id), ["ch_tg"]);
  assert.deepEqual(channelFallbackChoices(channels, undefined).map((c) => c.id), ["ch_tg", "ch_bark_urgent"]);
  assert.equal(channelFallbackForSave("ch_tg", "ch_bark_urgent", false), "ch_tg");
  assert.equal(channelFallbackForSave("", "ch_bark_urgent", false), undefined);
  assert.equal(channelFallbackForSave("", "ch_bark_urgent", true), "");
  assert.equal(channelFallbackForSave("ch_bark_urgent", "ch_bark_urgent", true), "");
});
