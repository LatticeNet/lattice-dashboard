import assert from "node:assert/strict";
import { test } from "node:test";

import type { MonitorView } from "@/lib/api/types";

import {
  certExpiry,
  latestCertExpiry,
  buildCarryPauses,
  buildCreate,
  buildPauseOld,
  buildSourcePause,
  buildUpdate,
  canEditCheck,
  checkGroup,
  draftChanged,
  draftFromMonitor,
  draftProblems,
  emptyDraft,
  identityChanged,
  sourcePaused,
  suggestName,
  switchDraftKind,
  draftSources,
  icmpBudget,
  icmpRunSeconds,
  offeredKinds,
  resolveNodeTarget,
  unsupportedSources,
  usesNodeTarget,
  withPathVerdict,
  type CheckDraft,
} from "../checksModel.ts";
import { rowsFromHeaders, startReplace } from "../checkHeadersModel.ts";

function monitor(over: Partial<MonitorView> = {}): MonitorView {
  return {
    id: "mon_http",
    name: "Status page",
    type: "http",
    target: "https://status.example.com/health",
    interval_sec: 30,
    timeout_sec: 5,
    assign_all: false,
    node_ids: ["sh", "hk"],
    paused_node_ids: [],
    enabled: true,
    version: 4,
    alert: "down",
    alert_after: 2,
    ...over,
  };
}

test("groups: operator checks first, the path set's generated checks under it, edits only with a version", () => {
  assert.equal(checkGroup(monitor()), "operator");
  assert.equal(checkGroup(monitor({ managed_by: "latency" })), "pathset");
  assert.equal(canEditCheck(monitor(), true), true);
  assert.equal(canEditCheck(monitor({ version: undefined }), true), true, "a check listed without a version is edited at version zero");
  assert.equal(canEditCheck(monitor(), false), false, "a server without the edit route");
  assert.equal(canEditCheck(monitor({ managed_by: "latency" }), true), false);
  assert.equal(buildUpdate(monitor({ version: undefined }), { ...draftFromMonitor(monitor()), intervalSec: 60 }).version, 0);
});

test("names: suggested from the method and the target until the operator types one", () => {
  assert.equal(suggestName("http", "https://status.example.com/health"), "HTTP status.example.com/health");
  assert.equal(suggestName("http", "https://example.com/"), "HTTP example.com");
  assert.equal(suggestName("tcp", "203.0.113.9:22"), "TCP 203.0.113.9:22");
  assert.equal(suggestName("tls", "  "), "");
});

test("problems: target shape, cadence bounds, timeout under interval, sources, threshold and alert count", () => {
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()) }), []);
  assert.deepEqual(draftProblems({ ...emptyDraft("tcp"), target: "https://x" }), ["target"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), intervalSec: 5 }), ["interval"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), timeoutSec: 30 }), ["timeoutVsInterval"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), timeoutSec: 0 }), ["timeout"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), nodeIds: [] }), ["sources"]);
  assert.deepEqual(draftProblems({ ...emptyDraft("tls"), target: "example.com:443", thresholdDays: 0 }), ["threshold"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), alertAfter: 0 }), ["alertAfter"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), alertAfter: 21 }), ["alertAfter"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), alert: "off", alertAfter: 0 }), [], "the count matters only when the check alerts");
  assert.equal(draftFromMonitor(monitor({ alert_after: undefined })).alertAfter, 2, "absent reads as the server's default");
});

test("edit: only changed fields with the version; kind and target never ride an edit", () => {
  const m = monitor();
  assert.deepEqual(buildUpdate(m, draftFromMonitor(m)), { id: "mon_http", version: 4 });
  const draft = { ...draftFromMonitor(m), intervalSec: 60, nodeIds: ["sh", "hk", "fsn"], pausedNodeIds: ["hk"], alert: "off" as const };
  assert.deepEqual(buildUpdate(m, draft), { id: "mon_http", version: 4, interval_sec: 60, node_ids: ["fsn", "hk", "sh"], paused_node_ids: ["hk"], alert: "off" });
  // A source taken off the check drops its pause with it.
  const dropped = { ...draftFromMonitor(monitor({ paused_node_ids: ["hk"] })), nodeIds: ["sh"] };
  assert.deepEqual(buildUpdate(monitor({ paused_node_ids: ["hk"] }), dropped), { id: "mon_http", version: 4, node_ids: ["sh"], paused_node_ids: [] });
  const renamed = { ...draftFromMonitor(m), name: "  " };
  assert.equal(buildUpdate(m, renamed).name, "HTTP status.example.com/health", "an emptied name falls back to the suggestion");
  assert.equal(draftChanged(m, draftFromMonitor(m)), false);
  assert.equal(draftChanged(m, draft), true);
});

test("identity: a new method or target makes a new check and pauses the old one", () => {
  const m = monitor();
  assert.equal(identityChanged(m, draftFromMonitor(m)), false);
  assert.equal(identityChanged(m, { type: "tcp", target: m.target }), true);
  assert.equal(identityChanged(m, { type: "http", target: "https://status.example.com/v2" }), true);
  assert.equal(identityChanged(m, { type: "http", target: ` ${m.target} ` }), false);
  assert.deepEqual(buildPauseOld(m), { id: "mon_http", version: 4, enabled: false });
});

test("create: tls carries a threshold and no nodes; agent checks carry their sources; alert only when the server takes it", () => {
  const tls = buildCreate({ ...emptyDraft("tls"), target: "example.com:443" }, false);
  assert.deepEqual(tls, { name: "TLS example.com:443", type: "tls", target: "example.com:443", interval_sec: 3600, timeout_sec: 10, threshold_days: 14, assign_all: false });
  const http = buildCreate({ ...draftFromMonitor(monitor()), nodeIds: ["hk", "sh"] }, true);
  assert.deepEqual(http, { name: "Status page", type: "http", target: "https://status.example.com/health", interval_sec: 30, timeout_sec: 5, assign_all: false, node_ids: ["hk", "sh"], alert: "down", alert_after: 2 });
  assert.equal(buildUpdate(monitor(), { ...draftFromMonitor(monitor()), alertAfter: 3 }).alert_after, 3);
});

test("a replacement keeps the pauses of the sources it still runs on", () => {
  const draft = { ...draftFromMonitor(monitor({ paused_node_ids: ["hk"] })), target: "https://status.example.com/v2", nodeIds: ["sh", "hk"] };
  assert.deepEqual(buildCarryPauses({ id: "mon_new", version: 1 }, draft), { id: "mon_new", version: 1, paused_node_ids: ["hk"] });
  assert.deepEqual(buildCarryPauses({ id: "mon_new" }, { ...draft, nodeIds: ["sh"] }), undefined, "a source taken off drops its pause");
  assert.equal(buildCarryPauses({ id: "mon_new", version: 1 }, { ...draft, pausedNodeIds: [] }), undefined);
  assert.equal(buildCarryPauses({ id: "mon_new", version: 1 }, { ...draft, type: "tls" }), undefined);
});

test("pause one source of a check", () => {
  const m = monitor({ paused_node_ids: ["hk"] });
  assert.deepEqual(buildSourcePause(m, "sh", true), { id: "mon_http", version: 4, paused_node_ids: ["hk", "sh"] });
  assert.deepEqual(buildSourcePause(m, "hk", false), { id: "mon_http", version: 4, paused_node_ids: [] });
  assert.equal(sourcePaused(m, "hk"), true);
  assert.equal(sourcePaused(m, "sh"), false);
});

test("switching kind keeps the agent assignment aside through tls and hands it back", () => {
  const start = { ...draftFromMonitor(monitor()), type: "tcp" as const, target: "203.0.113.1:22" };
  const toTls = switchDraftKind(start, "tls");
  assert.equal(toTls.draft.assignAll, false);
  assert.deepEqual(toTls.draft.nodeIds, []);
  assert.equal(toTls.draft.intervalSec, 3600);
  const back = switchDraftKind(toTls.draft, "http", toTls.stash);
  assert.deepEqual(back.draft.nodeIds, ["hk", "sh"]);
  assert.equal(back.draft.intervalSec, 30);
  assert.equal(back.stash, undefined);
  const sideways = switchDraftKind(start, "http");
  assert.deepEqual(sideways.draft.nodeIds, ["hk", "sh"]);
});

test("certificate expiry: Go's zero time is no expiry, so tcp and http runs and failed handshakes never read as expired", () => {
  assert.equal(certExpiry("0001-01-01T00:00:00Z"), undefined);
  assert.equal(certExpiry(undefined), undefined);
  assert.equal(certExpiry(""), undefined);
  assert.equal(certExpiry("not a date"), undefined);
  assert.equal(certExpiry("2026-12-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"));
  const runs = [
    { cert_not_after: "0001-01-01T00:00:00Z" },
    { cert_not_after: "2026-12-01T00:00:00Z" },
    { cert_not_after: "2026-11-01T00:00:00Z" },
  ];
  assert.equal(latestCertExpiry(runs), Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(latestCertExpiry([{ cert_not_after: "0001-01-01T00:00:00Z" }, {}]), undefined);
  assert.equal(latestCertExpiry(undefined), undefined);
});

/* ---- Design 29 M2a ---- */

function icmpCheck(over: Partial<MonitorView> = {}): MonitorView {
  return monitor({ id: "mon_ping", name: "Ping jp", type: "icmp", target: "203.0.113.12", target_node: "jp", packets: 5, interval_sec: 30, timeout_sec: 2, node_ids: ["sh"], ...over });
}

function httpCheck(over: Partial<MonitorView> = {}): MonitorView {
  return monitor({ expect_status: "200-299,301", headers: [{ name: "X-Api-Key", secret: true, set: true }, { name: "Accept", value: "application/json" }], secrets_origin: "https://status.example.com:443", ...over });
}

const M2A = { m2a: true };

test("ICMP is offered only by an M2a server", () => {
  assert.deepEqual(offeredKinds(false), ["tcp", "http", "tls"]);
  assert.deepEqual(offeredKinds(true), ["tcp", "icmp", "http", "tls"]);
});

test("a read check's M2a fields become the draft: node target, packets, statuses, headers", () => {
  const d = draftFromMonitor(icmpCheck());
  assert.equal(d.targetMode, "node");
  assert.equal(d.targetNode, "jp");
  assert.equal(d.packets, 5);
  assert.equal(usesNodeTarget(d), true);
  assert.equal(draftFromMonitor(icmpCheck({ packets: undefined })).packets, 5, "absent packets read as five");
  const h = draftFromMonitor(httpCheck());
  assert.equal(h.expectStatus, "200-299,301");
  assert.equal(h.headers.length, 2);
  assert.equal(h.targetMode, "address");
  // http never takes a node target, whatever the draft's mode says.
  assert.equal(usesNodeTarget({ type: "http", targetMode: "node" }), false);
});

test("an M1 check read by an M2a console is unchanged by opening it", () => {
  assert.equal(draftChanged(monitor(), draftFromMonitor(monitor())), false);
  assert.equal(draftChanged(httpCheck(), draftFromMonitor(httpCheck())), false);
  assert.equal(draftChanged(icmpCheck(), draftFromMonitor(icmpCheck())), false);
});

test("ICMP problems: an IPv4 target, packets, the run inside the interval, the packet budget", () => {
  const base: CheckDraft = { ...emptyDraft("icmp"), target: "203.0.113.9", assignAll: false, nodeIds: ["sh"], intervalSec: 30, timeoutSec: 2 };
  assert.deepEqual(draftProblems(base, M2A), []);
  assert.deepEqual(draftProblems({ ...base, target: "example.com" }, M2A), ["target"]);
  assert.deepEqual(draftProblems({ ...base, target: "203.0.113.9:443" }, M2A), ["target"]);
  assert.deepEqual(draftProblems({ ...base, target: "10.0.0.9" }, M2A), ["destination"]);
  assert.deepEqual(draftProblems({ ...base, packets: 0 }, M2A), ["packets"]);
  assert.deepEqual(draftProblems({ ...base, packets: 11 }, M2A), ["packets"]);
  // (10 - 1) x 200 ms + 9 s = 10.8 s, which does not end before a 10 s interval.
  assert.equal(icmpRunSeconds(10, 9), 10.8);
  assert.deepEqual(draftProblems({ ...base, packets: 10, timeoutSec: 9, intervalSec: 10 }, M2A), ["runLength"]);
  assert.deepEqual(draftProblems({ ...base, packets: 1, timeoutSec: 9, intervalSec: 10 }, M2A), []);
  assert.deepEqual(draftProblems(base, { ...M2A, budgetPps: 2 }), [], "two a second is allowed");
  assert.deepEqual(draftProblems(base, { ...M2A, budgetPps: 2.1 }), ["budget"]);
});

test("a node target: missing, refused for the method, or resolved", () => {
  const base: CheckDraft = { ...emptyDraft("icmp"), targetMode: "node", assignAll: false, nodeIds: ["sh"], intervalSec: 30, timeoutSec: 2 };
  assert.deepEqual(draftProblems(base, M2A), ["target"]);
  const chosen = { ...base, targetNode: "jp" };
  assert.deepEqual(draftProblems(chosen, { ...M2A, nodeTarget: { state: "refused", reason: "no_public_ipv4" } }), ["targetNode"]);
  assert.deepEqual(draftProblems(chosen, { ...M2A, nodeTarget: { state: "resolved", endpoint: "203.0.113.12" } }), []);
  assert.deepEqual(draftProblems(chosen, { ...M2A, nodeTarget: { state: "onSave" } }), []);
});

test("resolution: ICMP to the public IPv4, TCP to the plan's line port or on save", () => {
  assert.deepEqual(resolveNodeTarget("icmp", { public_ip: "203.0.113.12" }), { state: "resolved", endpoint: "203.0.113.12" });
  assert.deepEqual(resolveNodeTarget("icmp", { public_ip: "203.0.113.12" }, { icmp_target: "198.51.100.4", target: "probed" }), { state: "resolved", endpoint: "198.51.100.4" });
  assert.deepEqual(resolveNodeTarget("icmp", {}), { state: "refused", reason: "no_public_ipv4" });
  assert.deepEqual(resolveNodeTarget("icmp", { public_ip: "2001:db8::1" }), { state: "refused", reason: "no_public_ipv4" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint: "203.0.113.12:443", target: "probed" }), { state: "resolved", endpoint: "203.0.113.12:443" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint_note: "udp_only", target: "not_probeable" }), { state: "refused", reason: "udp_only" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { target: "not_probeable" }), { state: "refused", reason: "no_tcp_line" });
  // A node the path set pings but cannot dial: the plan names it a target with a note and no line.
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint_note: "udp_only", target: "probed" }), { state: "refused", reason: "udp_only" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint: "203.0.113.12:443", endpoint_note: "last_known", target: "probed" }), { state: "resolved", endpoint: "203.0.113.12:443" });
  assert.deepEqual(resolveNodeTarget("tcp", { public_ip: "203.0.113.12" }), { state: "onSave" });
});

test("the destination rule applies to tcp and http only on an M2a server", () => {
  const tcp: CheckDraft = { ...emptyDraft("tcp"), target: "192.168.1.1:22", assignAll: true };
  assert.deepEqual(draftProblems(tcp), [], "an M1 server dials what M1 dialled");
  assert.deepEqual(draftProblems(tcp, M2A), ["destination"]);
  const http: CheckDraft = { ...emptyDraft("http"), target: "http://localhost:8080/health", assignAll: true };
  assert.deepEqual(draftProblems(http, M2A), ["destination"]);
});

test("HTTP problems on an M2a server: the status set and the headers", () => {
  const d = draftFromMonitor(httpCheck());
  assert.deepEqual(draftProblems(d, M2A), []);
  assert.deepEqual(draftProblems({ ...d, expectStatus: "2xx" }, M2A), ["expectStatus"]);
  assert.deepEqual(draftProblems({ ...d, target: "http://status.example.com/health" }, { ...M2A, newCheck: true }), ["headers"], "secrets need https, and a new check cannot carry them");
  assert.deepEqual(draftProblems(d, { ...M2A, newCheck: true }), ["headers"], "a replacement must have the secret entered again");
  assert.deepEqual(draftProblems({ ...d, expectStatus: "2xx" }), [], "an M1 server has no such field");
});

test("identity: a node target compares by node, not by the address it resolves to", () => {
  const m = icmpCheck();
  const d = draftFromMonitor(m);
  assert.equal(identityChanged({ ...m, target: "198.51.100.77" }, d), false, "the node moved; the check did not change");
  assert.equal(identityChanged(m, { ...d, targetNode: "hk" }), true);
  assert.equal(identityChanged(m, { ...d, targetMode: "address", target: "203.0.113.12" }), true, "an address is not the node");
  assert.equal(identityChanged(m, { ...d, type: "tcp" }), true);
});

test("create: a node target sends target_node and no target; icmp its packets; http its statuses and headers on M2a only", () => {
  const icmp: CheckDraft = { ...emptyDraft("icmp"), targetMode: "node", targetNode: "jp", packets: 3, assignAll: false, nodeIds: ["sh"], intervalSec: 30, timeoutSec: 2 };
  assert.deepEqual(buildCreate(icmp, true, { m2a: true, nodeName: "xuezhang-jp-nat" }), {
    name: "ICMP xuezhang-jp-nat",
    type: "icmp",
    target_node: "jp",
    packets: 3,
    interval_sec: 30,
    timeout_sec: 2,
    assign_all: false,
    node_ids: ["sh"],
    alert: "down",
    alert_after: 2,
  });
  const http: CheckDraft = { ...draftFromMonitor(httpCheck()), name: "Status page" };
  http.headers = http.headers.map((h) => (h.key === "saved-0" ? { ...startReplace(h), value: "token" } : h));
  const body = buildCreate(http, true, { m2a: true });
  assert.equal(body.expect_status, "200-299,301");
  assert.deepEqual(body.headers, [{ name: "X-Api-Key", value: "token", secret: true }, { name: "Accept", value: "application/json" }]);
  const old = buildCreate(http, true, { m2a: false });
  assert.equal("expect_status" in old || "headers" in old, false, "an M1 server is sent M1's body");
  assert.equal(buildCreate({ ...http, expectStatus: "" }, true, { m2a: true }).expect_status, undefined, "an empty set is the default and is not sent");
});

test("edit: packets, statuses by meaning, header operations; never the read", () => {
  const m = icmpCheck();
  assert.deepEqual(buildUpdate(m, { ...draftFromMonitor(m), packets: 8 }), { id: "mon_ping", version: 4, packets: 8 });
  const h = httpCheck();
  const d = draftFromMonitor(h);
  assert.deepEqual(buildUpdate(h, d, M2A), { id: "mon_http", version: 4 }, "an unchanged draft sends no headers at all");
  assert.deepEqual(buildUpdate(h, { ...d, expectStatus: "301, 200-299" }, M2A), { id: "mon_http", version: 4 }, "the same set written differently is no change");
  assert.deepEqual(buildUpdate(h, { ...d, expectStatus: "200-204" }, M2A), { id: "mon_http", version: 4, expect_status: "200-204" });
  assert.deepEqual(buildUpdate(h, { ...d, expectStatus: "" }, M2A), { id: "mon_http", version: 4, expect_status: "" }, "cleared back to the default");
  assert.deepEqual(buildUpdate(monitor(), { ...draftFromMonitor(monitor()), expectStatus: "200-399" }, M2A), { id: "mon_http", version: 4 }, "the default typed out is the default");
  const replaced = { ...d, headers: d.headers.map((r) => (r.key === "saved-0" ? { ...startReplace(r), value: "rotated" } : r)) };
  assert.deepEqual(buildUpdate(h, replaced, M2A).headers, [{ name: "X-Api-Key", op: "set", value: "rotated", secret: true }]);
  assert.equal(buildUpdate(h, replaced).headers, undefined, "an M1 server is never sent header operations");
  assert.equal(draftChanged(h, replaced), true);
});

test("sources: the ones whose agent cannot run the method, with the reason", () => {
  const nodes = [
    { id: "sh", name: "cd-hs-sh", online: true, probe_methods: ["http", "icmp", "tcp"] },
    { id: "mk", name: "mkcloud", online: true, probe_methods: ["http", "tcp"] },
    { id: "kix", name: "Oracle-KIX-arm", online: true, probe_methods: ["http", "tcp"], probe_refusals: { icmp: "icmp_not_permitted" } },
  ];
  const d: CheckDraft = { ...emptyDraft("icmp"), assignAll: false, nodeIds: ["sh", "mk", "kix"] };
  assert.deepEqual(unsupportedSources(d, nodes, true), [
    { id: "mk", reason: "agent_too_old" },
    { id: "kix", reason: "icmp_not_permitted" },
  ]);
  assert.deepEqual(unsupportedSources({ ...d, type: "tcp" }, nodes, true), []);
  assert.deepEqual(unsupportedSources(d, nodes, false), [], "an M1 server gates nothing");
  assert.deepEqual(draftSources({ assignAll: true, nodeIds: [] }, nodes), ["sh", "mk", "kix"]);
});

test("the packet budget sums every enabled icmp check to the address on the same source", () => {
  const draft = { packets: 5, intervalSec: 10 };
  const others = [
    icmpCheck({ id: "mon_lati_jp", target: "203.0.113.12", node_ids: ["sh"], packets: 5, interval_sec: 60 }),
    icmpCheck({ id: "mon_other", target: "203.0.113.12", node_ids: ["sh", "mk"], packets: 10, interval_sec: 10 }),
    icmpCheck({ id: "mon_paused", target: "203.0.113.12", node_ids: ["sh"], enabled: false }),
    icmpCheck({ id: "mon_elsewhere", target: "198.51.100.1", node_ids: ["sh"], packets: 10, interval_sec: 10 }),
    icmpCheck({ id: "mon_ping", target: "203.0.113.12", node_ids: ["sh"], packets: 10, interval_sec: 10 }),
  ];
  const worst = icmpBudget("203.0.113.12", ["sh", "mk"], draft, others, "mon_ping");
  assert.equal(worst.source, "sh");
  assert.ok(Math.abs(worst.pps - (0.5 + 5 / 60 + 1)) < 1e-9);
  assert.equal(icmpBudget("", ["sh"], draft, others).pps, 0.5, "no address yet: only the check itself");
});

test("switching to ICMP keeps the node choice; to HTTP the node is set aside, not lost", () => {
  const tcp: CheckDraft = { ...emptyDraft("tcp"), targetMode: "node", targetNode: "jp" };
  const toIcmp = switchDraftKind(tcp, "icmp").draft;
  assert.equal(usesNodeTarget(toIcmp), true);
  const toHttp = switchDraftKind(toIcmp, "http").draft;
  assert.equal(usesNodeTarget(toHttp), false);
  assert.equal(usesNodeTarget(switchDraftKind(toHttp, "icmp").draft), true);
  assert.equal(rowsFromHeaders(undefined).length, 0);
});

test("a check whose failing source reads unknown on its path reads unmeasured, not down", () => {
  const failing = { kind: "failing" as const, failing: 1, total: 2, lastAt: 5 };
  assert.deepEqual(withPathVerdict(failing, [{ state: "unknown", reason: "icmp_filtered" }, { state: "up" }]), { kind: "unmeasured", total: 2, reason: "icmp_filtered", lastAt: 5 });
  assert.deepEqual(withPathVerdict(failing, [{ state: "down" }, { state: "unknown", reason: "icmp_filtered" }]), failing, "a down path keeps it down");
  assert.deepEqual(withPathVerdict(failing, [{ state: "unknown", reason: "source_paused" }, { state: "up" }]), failing, "a pause is not the reason");
  assert.deepEqual(withPathVerdict(failing, []), failing, "no paths read: the results decide");
  const up = { kind: "up" as const, total: 1, lastAt: 5 };
  assert.equal(withPathVerdict(up, [{ state: "unknown", reason: "icmp_filtered" }]), up);
});
