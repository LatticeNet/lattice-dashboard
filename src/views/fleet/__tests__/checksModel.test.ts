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
  budgetRechecked,
  canEditCheck,
  checkSourceSummary,
  checkGroup,
  draftChanged,
  draftFromMonitor,
  draftNeedsCurrentAgent,
  draftProblems,
  emptyDraft,
  identityChanged,
  sourcePaused,
  suggestName,
  switchDraftKind,
  draftSources,
  beaconBudget,
  icmpBudget,
  icmpRunSeconds,
  multiPacket,
  nodeOnly,
  offeredKinds,
  resolveNodeTarget,
  unsupportedSources,
  unpickableNote,
  usesNodeTarget,
  withPathVerdict,
  draftDegradedProblems,
  type CheckDraft,
} from "../checksModel.ts";
import { applyQuery, compileQuery } from "@/lib/query/engine";
import { healthRank } from "../monitorHealthModel.ts";
import { monitoringQuerySchema } from "../monitoringQuery.ts";
import { ALERT_POLICIES, DEGRADED_BOUNDS, canonicalRule, defaultDegradedDraft, degradedDraftFrom, degradedEdit, degradedProblems, effectiveAlert, pagesDown } from "../degradedRuleModel.ts";
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
/** A create, or a replacement: the destination rules apply. */
const NEW = { m2a: true, newCheck: true };

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
  assert.deepEqual(draftProblems({ ...base, target: "10.0.0.9" }, NEW), ["destination"]);
  assert.deepEqual(draftProblems({ ...base, target: "10.0.0.9" }, M2A), [], "an edit cannot change the target, so a check saved before the rules stays editable");
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
  assert.deepEqual(resolveNodeTarget("icmp", { public_ip: "10.0.0.5" }), { state: "refused", reason: "no_public_ipv4" }, "a private address is not pinged");
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint: "203.0.113.12:443", target: "probed" }), { state: "resolved", endpoint: "203.0.113.12:443" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint_note: "udp_only", target: "not_probeable" }), { state: "refused", reason: "udp_only" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { target: "not_probeable" }), { state: "refused", reason: "no_tcp_line" });
  // A node the path set pings but cannot dial: the plan names it a target with a note and no line.
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint_note: "udp_only", target: "probed" }), { state: "refused", reason: "udp_only" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint: "203.0.113.12:443", endpoint_note: "last_known", target: "probed" }), { state: "resolved", endpoint: "203.0.113.12:443" });
  assert.deepEqual(resolveNodeTarget("tcp", { public_ip: "203.0.113.12" }), { state: "onSave" });
  // A path set on ICMP writes no_public_address over the TCP note; the TCP reason is then the server's to give.
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint_note: "no_public_address", target: "not_probeable" }, "icmp"), { state: "onSave" });
  assert.deepEqual(resolveNodeTarget("tcp", {}, { endpoint_note: "no_public_address", target: "not_probeable" }, "tcp"), { state: "refused", reason: "no_public_address" });
});

test("the destination rule applies to tcp and http only on an M2a server, and only to a new check", () => {
  const tcp: CheckDraft = { ...emptyDraft("tcp"), target: "192.168.1.1:22", assignAll: true };
  assert.deepEqual(draftProblems(tcp, { m2a: false, newCheck: true }), [], "an M1 server dials what M1 dialled");
  assert.deepEqual(draftProblems(tcp, NEW), ["destination"]);
  assert.deepEqual(draftProblems(tcp, M2A), [], "editing a check saved before the rules");
  assert.deepEqual(draftProblems({ ...tcp, target: "127.1:22" }, NEW), ["destination"], "a numeric host form");
  const http: CheckDraft = { ...emptyDraft("http"), target: "http://localhost:8080/health", assignAll: true };
  assert.deepEqual(draftProblems(http, NEW), ["destination"]);
});

test("the packet budget is re-checked on a new check, and on an edit only when it changes what the budget counts", () => {
  const m = icmpCheck();
  const d = draftFromMonitor(m);
  assert.equal(budgetRechecked(undefined, d, true), true, "a create");
  assert.equal(budgetRechecked(m, d, true), true, "a replacement");
  assert.equal(budgetRechecked(m, { ...d, name: "Ping jp again" }, false), false, "a rename");
  assert.equal(budgetRechecked(m, { ...d, alert: "off" }, false), false);
  assert.equal(budgetRechecked(m, { ...d, packets: 8 }, false), true);
  assert.equal(budgetRechecked(m, { ...d, intervalSec: 10 }, false), true);
  assert.equal(budgetRechecked(m, { ...d, nodeIds: ["sh", "hk"] }, false), true);
  assert.equal(budgetRechecked(m, { ...d, pausedNodeIds: ["sh"] }, false), true);
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

test("an http check with headers or a status set runs only where the agent reports its methods", () => {
  const nodes = [
    { id: "sh", name: "cd-hs-sh", online: true, probe_methods: ["http", "icmp", "tcp"] },
    { id: "mk", name: "mkcloud", online: true, probe_methods: ["http", "tcp"] },
    { id: "kix", name: "Oracle-KIX-arm", online: true, probe_methods: ["http", "tcp"], probe_refusals: { icmp: "icmp_not_permitted" } },
  ];
  const plain: CheckDraft = { ...emptyDraft("http"), target: "https://status.example.com/health", assignAll: false, nodeIds: ["sh", "mk", "kix"] };
  assert.equal(draftNeedsCurrentAgent(plain), false);
  assert.deepEqual(unsupportedSources(plain, nodes, true), [], "a plain http check runs on every agent");
  assert.deepEqual(unsupportedSources({ ...plain, expectStatus: "200-399" }, nodes, true), [], "the default set typed out");
  const withSet = { ...plain, expectStatus: "200-299,301" };
  assert.equal(draftNeedsCurrentAgent(withSet), true);
  assert.deepEqual(unsupportedSources(withSet, nodes, true), [{ id: "mk", reason: "agent_too_old" }], "a host that refuses icmp still runs an M2a agent");
  const withHeader = { ...plain, headers: draftFromMonitor(httpCheck()).headers };
  assert.deepEqual(unsupportedSources(withHeader, nodes, true), [{ id: "mk", reason: "agent_too_old" }]);
  assert.equal(draftNeedsCurrentAgent({ ...plain, headers: [{ ...withHeader.headers[0]!, name: "  " }] }), false, "a row with no name is not a header yet");
  assert.deepEqual(unsupportedSources(withSet, nodes, false), [], "an M1 server gates nothing");
});

test("the budget leaves a source out that the caller drops as paused", () => {
  const others = [icmpCheck({ id: "mon_other", target: "203.0.113.12", node_ids: ["sh"], packets: 10, interval_sec: 10 })];
  const draft = { packets: 5, intervalSec: 10 };
  assert.equal(icmpBudget("203.0.113.12", ["sh"], draft, others).pps, 1.5);
  assert.equal(icmpBudget("203.0.113.12", [], draft, others).pps, 0.5, "every source paused: only the check itself");
  // A replacement passes no editing id: the check it replaces still runs while the new one is created.
  assert.equal(icmpBudget("203.0.113.12", ["sh"], draft, [...others, icmpCheck({ id: "mon_ping", target: "203.0.113.12", node_ids: ["sh"], packets: 5, interval_sec: 10 })]).pps, 2);
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

test("M3: a check whose runs pass reads degraded on N of its judged paths, never a green up", () => {
  const up = { kind: "up" as const, total: 3, latencyMs: 356, lastAt: 5 };
  // Degraded from two of three sources: the third is up; an unknown or paused path is not judged.
  assert.deepEqual(withPathVerdict(up, [{ state: "degraded" }, { state: "degraded" }, { state: "up" }, { state: "unknown", reason: "results_stopped" }]), { kind: "degraded", degraded: 2, total: 3, latencyMs: 356, lastAt: 5 });
  assert.deepEqual(withPathVerdict(up, [{ state: "degraded" }]), { kind: "degraded", degraded: 1, total: 1, latencyMs: 356, lastAt: 5 });
  assert.equal(withPathVerdict(up, [{ state: "up" }, { state: "up" }]), up, "no degraded path, still up");
  assert.equal(withPathVerdict(up, [{ state: "degraded" }, { state: "down" }]), up, "a down path the newest runs have left behind keeps the results' word");
  assert.equal(withPathVerdict(up, []), up, "no paths read (an older server): the results decide");
  // Without the newest results to name the failing source, a failing check keeps the results' word.
  const failing = { kind: "failing" as const, failing: 1, total: 2, lastAt: 5 };
  assert.equal(withPathVerdict(failing, [{ state: "degraded" }, { state: "up" }]), failing);
  // Degraded sorts with the warnings: after failing, before stale.
  assert.ok(healthRank({ kind: "failing", failing: 1, total: 1, lastAt: 0 }) < healthRank({ kind: "degraded", degraded: 1, total: 1, lastAt: 0 }));
  assert.ok(healthRank({ kind: "degraded", degraded: 1, total: 1, lastAt: 0 }) < healthRank({ kind: "stale", lastAt: 0 }));
  assert.ok(healthRank({ kind: "degraded", degraded: 1, total: 1, lastAt: 0 }) < healthRank({ kind: "up", total: 1, lastAt: 0 }));
  // The Checks query finds them by status.
  const rows = [monitor({ id: "a" }), monitor({ id: "b" })];
  const schema = monitoringQuerySchema({ health: (m) => (m.id === "a" ? withPathVerdict(up, [{ state: "degraded" }]) : up), allNodeNames: () => [], nodeName: (id) => id, serverEvaluated: () => false });
  assert.deepEqual(applyQuery(rows, compileQuery("status:degraded", schema).query).map((m) => m.id), ["a"]);
});

test("the verdict names the reason on the failing sources' paths, or counts reasons that differ", () => {
  const failing = { kind: "failing" as const, failing: 1, total: 1, lastAt: 5 };
  const paths = [
    { source: "sh", state: "unknown", reason: "icmp_filtered" },
    { source: "volc", state: "unknown", reason: "agent_too_old" },
  ];
  const latest = [{ node_id: "sh", success: false }];
  assert.deepEqual(withPathVerdict(failing, paths, latest), { kind: "unmeasured", total: 1, reason: "icmp_filtered", lastAt: 5 }, "not the first unknown path's reason");
  assert.deepEqual(withPathVerdict(failing, paths), { kind: "unmeasured", total: 1, reason: "", reasons: 2, lastAt: 5 }, "two reasons and no failing source to choose by");
});

test("M3: a loss-degraded path whose newest run failed reads degraded, never not measured and never down", () => {
  // A path degraded on loss loses runs, so its newest run often fails while the matrix, under alert_after, holds it degraded.
  const failing = { kind: "failing" as const, failing: 1, total: 3, lastAt: 5 };
  const lossy = [
    { source: "sh", state: "degraded", reason: "degraded_loss" },
    { source: "hk", state: "degraded", reason: "degraded_loss" },
    { source: "volc", state: "unknown", reason: "results_stopped" },
  ];
  const latest = [
    { node_id: "sh", success: false },
    { node_id: "hk", success: true, latency_ms: 343 },
    { node_id: "volc", success: true, latency_ms: 90 },
  ];
  // With a stale sibling: the check does not borrow volc's "results stopped" while sh and hk measure it.
  assert.deepEqual(withPathVerdict(failing, lossy, latest), { kind: "degraded", degraded: 2, total: 2, latencyMs: 216.5, lastAt: 5 });
  // The same check a minute later, when sh's newest run passed: the row does not change state.
  const up = { kind: "up" as const, total: 3, latencyMs: 216.5, lastAt: 5 };
  assert.deepEqual(withPathVerdict(up, lossy, latest.map((l) => ({ ...l, success: true }))), { kind: "degraded", degraded: 2, total: 2, latencyMs: 216.5, lastAt: 5 });
  // Without the sibling: degraded, not a red "down on 1 of 2".
  const two = [lossy[0]!, { source: "hk", state: "up" }];
  assert.deepEqual(withPathVerdict({ ...failing, total: 2 }, two, latest.slice(0, 2)), { kind: "degraded", degraded: 1, total: 2, latencyMs: 343, lastAt: 5 });
  // Every source failing: degraded with no latency to show.
  assert.deepEqual(withPathVerdict({ kind: "failing", failing: 1, total: 1, lastAt: 5 }, [lossy[0]!], [latest[0]!]), { kind: "degraded", degraded: 1, total: 1, latencyMs: undefined, lastAt: 5 });
  // A failing source degraded beside another failing source unknown: one source measures it, so it is not "not measured".
  const mixed = [lossy[0]!, { source: "mk", state: "unknown", reason: "agent_too_old" }];
  assert.equal(withPathVerdict(failing, mixed, [{ node_id: "sh", success: false }, { node_id: "mk", success: false }]).kind, "degraded");
  // A down path still keeps it down.
  assert.deepEqual(withPathVerdict(failing, [...lossy, { source: "fra", state: "down" }], latest), failing);
});

test("another path's unknown reason speaks for a failing check only when a failing source has no path of its own", () => {
  const failing = { kind: "failing" as const, failing: 1, total: 2, lastAt: 5 };
  const stale = { source: "volc", state: "unknown", reason: "results_stopped" };
  // The failing source's own path reads up (one failure, under alert_after): its results speak, not volc's reason.
  assert.deepEqual(withPathVerdict(failing, [{ source: "sh", state: "up" }, stale], [{ node_id: "sh", success: false }]), failing);
  // The failing source has no path in the matrix: the check's other unknown path speaks for it.
  assert.deepEqual(withPathVerdict(failing, [{ source: "hk", state: "up" }, stale], [{ node_id: "sh", success: false }]), { kind: "unmeasured", total: 2, reason: "results_stopped", lastAt: 5 });
  // The failing source's own path is unknown: its reason, as before.
  assert.deepEqual(withPathVerdict(failing, [{ source: "sh", state: "unknown", reason: "icmp_filtered" }, stale], [{ node_id: "sh", success: false }]), { kind: "unmeasured", total: 2, reason: "icmp_filtered", lastAt: 5 });
});

test("a check's sources: its own and every source its paths name, with how many measure nothing", () => {
  const m = icmpCheck({ node_ids: ["sh", "mk", "kix"] });
  const paths = [
    { source: "sh", state: "up" },
    { source: "mk", state: "unknown", reason: "agent_too_old" },
    { source: "kix", state: "unknown", reason: "icmp_not_permitted" },
    { source: "volc", state: "unknown", reason: "agent_too_old" },
  ];
  assert.deepEqual(checkSourceSummary(m, paths), { ids: ["kix", "mk", "sh", "volc"], unmeasured: 3 });
  assert.deepEqual(checkSourceSummary(m, [{ source: "sh", state: "unknown", reason: "source_paused" }]).unmeasured, 0, "a pause is a choice, not a failure to measure");
  const fromLatest = icmpCheck({ node_ids: ["sh"], latest: [{ node_id: "sh", at: "", success: false, fail_streak: 0, since: "", reason: "icmp_not_permitted" }] });
  assert.equal(checkSourceSummary(fromLatest, []).unmeasured, 1, "without paths, the newest results say it");
});

/* ---- Beacon checks (design 29 M2b, D12) ---- */

test("Beacon is offered on an M2b server only, first, as the method D2 prefers for a node", () => {
  assert.deepEqual(offeredKinds(true, true), ["beacon", "tcp", "icmp", "http", "tls"]);
  assert.deepEqual(offeredKinds(true, false), ["tcp", "icmp", "http", "tls"]);
  assert.deepEqual(offeredKinds(false, true), ["tcp", "http", "tls"], "M2b without M2a is not a server that exists; nothing new is offered");
  assert.deepEqual(offeredKinds(true, true, false), ["tcp", "icmp", "http", "tls"], "a beacon check names a node, so a session without node:read is not offered one");
  assert.equal(multiPacket("beacon"), true);
  assert.equal(nodeOnly("beacon"), true);
  assert.equal(nodeOnly("icmp"), false);
});

test("a beacon check always targets a node and resolves to its advertised endpoint", () => {
  const draft = emptyDraft("beacon");
  assert.equal(draft.targetMode, "node");
  assert.equal(usesNodeTarget({ type: "beacon", targetMode: "address" }), true, "no address mode exists for a beacon");
  const listening = { public_ip: "203.0.113.12", beacon: { responder: true, state: "listening" } };
  assert.deepEqual(resolveNodeTarget("beacon", listening, { beacon_target: "203.0.113.12:50231" }), { state: "resolved", endpoint: "203.0.113.12:50231" });
  // The server saves a check to any enabled beacon; one that cannot answer carries a note, and the first two are not offered.
  const noted = (beacon?: { responder?: boolean; refusal?: string; state?: string }) => resolveNodeTarget("beacon", { public_ip: "203.0.113.12", beacon }, { beacon_target: "203.0.113.12:50231" });
  assert.deepEqual(noted({ responder: true, refusal: "refused_by_node", state: "refused" }), { state: "resolved", endpoint: "203.0.113.12:50231", note: "beacon_refused" });
  assert.deepEqual(noted(undefined), { state: "resolved", endpoint: "203.0.113.12:50231", note: "beacon_agent_too_old" });
  assert.deepEqual(noted({ responder: true, state: "circuit_open" }), { state: "resolved", endpoint: "203.0.113.12:50231", note: "beacon_not_listening" });
  assert.equal(unpickableNote(noted({ responder: true, refusal: "refused_by_node" })), true);
  assert.equal(unpickableNote(noted(undefined)), true);
  assert.equal(unpickableNote(noted({ responder: true, state: "bind_failed" })), false, "a socket that is down can come back; the check may be written now");
  assert.equal(unpickableNote(noted({ responder: true, state: "off" })), false, "a beacon still opening is not blocked");
  assert.deepEqual(resolveNodeTarget("beacon", { public_ip: "203.0.113.12" }, {}), { state: "refused", reason: "no_beacon" });
  assert.deepEqual(resolveNodeTarget("beacon", { public_ip: "203.0.113.12" }), { state: "refused", reason: "no_beacon" });
  const switched = switchDraftKind({ ...emptyDraft("http"), target: "https://status.example.com" }, "beacon").draft;
  assert.equal(switched.targetMode, "node");
  assert.equal(suggestName("beacon", "", "xuezhang-jp-nat"), "Beacon to xuezhang-jp-nat");
});

test("a beacon check is read, created and edited with its node and packets", () => {
  const saved = monitor({ id: "mon_b", type: "beacon", target: "203.0.113.12:50231", target_node: "jp", packets: 4, interval_sec: 30, timeout_sec: 2, version: 2 });
  const draft = draftFromMonitor(saved);
  assert.deepEqual([draft.type, draft.targetMode, draft.targetNode, draft.packets], ["beacon", "node", "jp", 4]);
  const body = buildCreate({ ...emptyDraft("beacon"), targetNode: "jp", packets: 5, nodeIds: ["sh"], assignAll: false, intervalSec: 30, timeoutSec: 2 }, true, { m2a: true, nodeName: "xuezhang-jp-nat" });
  assert.equal(body.target, undefined, "the server resolves the endpoint");
  assert.deepEqual([body.type, body.target_node, body.packets, body.name], ["beacon", "jp", 5, "Beacon to xuezhang-jp-nat"]);
  assert.deepEqual(buildUpdate(saved, { ...draft, packets: 6 }), { id: "mon_b", version: 2, packets: 6 });
});

test("a beacon draft follows the run length and packets rules, and its budget counts every beacon check to the node", () => {
  const draft = { ...emptyDraft("beacon"), targetNode: "jp", nodeIds: ["sh"], assignAll: false, packets: 10, intervalSec: 10, timeoutSec: 9 };
  assert.ok(draftProblems(draft, { m2a: true }).includes("runLength"), "1.8 s of spacing plus a 9 s timeout overruns 10 s");
  assert.ok(draftProblems({ ...draft, packets: 11, timeoutSec: 2 }, { m2a: true }).includes("packets"));
  const generated = monitor({ id: "mon_latb_jp", type: "beacon", target: "203.0.113.12:50231", target_node: "jp", packets: 5, interval_sec: 60, assign_all: false, node_ids: ["sh"], enabled: true, managed_by: "latency" });
  const otherNode = monitor({ id: "mon_latb_us", type: "beacon", target: "198.51.100.7:51388", target_node: "us", packets: 5, interval_sec: 10, assign_all: false, node_ids: ["sh"], enabled: true });
  const ping = monitor({ id: "mon_ping", type: "icmp", target: "203.0.113.12", target_node: "jp", packets: 10, interval_sec: 10, assign_all: false, node_ids: ["sh"], enabled: true });
  const pps = beaconBudget("jp", ["sh"], { packets: 10, intervalSec: 10 }, [generated, otherNode, ping]).pps;
  // 10/10 for the draft plus 5/60 for the generated check to the same node; another node and an icmp check do not count.
  assert.equal(Math.round(pps * 1000) / 1000, Math.round((1 + 5 / 60) * 1000) / 1000);
  assert.ok(draftProblems({ ...draft, packets: 5, intervalSec: 10, timeoutSec: 2 }, { m2a: true, budgetPps: 2.5 }).includes("budget"));
});

/* ---- Design 29 M3 (contract D13): the alert policy and the degraded thresholds ---- */

test("policies: off, down and down and degraded; empty reads as down on a check and off on the path set", () => {
  assert.deepEqual(ALERT_POLICIES, ["off", "down", "down_and_degraded"]);
  assert.equal(effectiveAlert(undefined, false), "down");
  assert.equal(effectiveAlert("", true), "off");
  assert.equal(effectiveAlert("down_and_degraded", true), "down_and_degraded");
  assert.equal(effectiveAlert("sideways", false), "down");
  assert.equal(pagesDown("down_and_degraded"), true);
  assert.equal(pagesDown("off"), false);
  assert.equal(draftFromMonitor(monitor({ alert: "down_and_degraded", alert_after: 3 })).alert, "down_and_degraded");
  assert.equal(draftFromMonitor(monitor({ alert: undefined })).alert, "down");
});

test("policies: the run count applies to both down choices and is sent with either", () => {
  const m = monitor();
  const d = { ...draftFromMonitor(m), alert: "down_and_degraded" as const, alertAfter: 4 };
  assert.deepEqual(buildUpdate(m, d, { m3: true }), { id: "mon_http", version: 4, alert: "down_and_degraded", alert_after: 4 });
  assert.deepEqual(draftProblems({ ...d, alertAfter: 0 }), ["alertAfter"]);
  const created = buildCreate({ ...emptyDraft("icmp"), targetMode: "node", targetNode: "jp", nodeIds: ["sh"], assignAll: false, alert: "down_and_degraded", alertAfter: 3 }, true, { m2a: true, m3: true });
  assert.equal(created.alert, "down_and_degraded");
  assert.equal(created.alert_after, 3);
  assert.equal(created.degraded, undefined, "default thresholds are not sent");
});

test("policies: tls refuses down and degraded, and switching a check to tls falls back to down", () => {
  const tls = { ...emptyDraft("tls"), target: "api.example.com:443", alert: "down_and_degraded" as const };
  assert.ok(draftProblems(tls).includes("alertTls"));
  const switched = switchDraftKind({ ...emptyDraft("http"), alert: "down_and_degraded" }, "tls").draft;
  assert.equal(switched.alert, "down");
  assert.deepEqual(draftDegradedProblems({ ...tls, degraded: { ...defaultDegradedDraft(), lossPercent: 99 } }), [], "a certificate has no degraded rule");
  const body = buildUpdate(monitor({ type: "tls", target: "api.example.com:443", threshold_days: 14 }), { ...draftFromMonitor(monitor({ type: "tls", target: "api.example.com:443", threshold_days: 14 })), degraded: { ...defaultDegradedDraft(), lossPercent: 5 } }, { m3: true });
  assert.equal(body.degraded, undefined, "never sent for tls");
});

test("thresholds: the bounds as the server checks them, at and beyond each edge", () => {
  for (const [field, b] of Object.entries(DEGRADED_BOUNDS)) {
    const at = (v: number | string) => degradedProblems({ ...defaultDegradedDraft(), [field]: v });
    assert.deepEqual(at(b.min), [], `${field} at its minimum`);
    assert.deepEqual(at(b.max), [], `${field} at its maximum`);
    assert.deepEqual(at(b.max + 1), [field], `${field} above`);
    assert.deepEqual(at(b.min / 2), [field], `${field} below`);
    assert.deepEqual(at(-1), [field], `${field} negative`);
    assert.deepEqual(at(Number.NaN), [field], `${field} NaN`);
    assert.deepEqual(at(Number.POSITIVE_INFINITY), [field], `${field} infinite`);
    assert.deepEqual(at("abc"), [field], `${field} unreadable`);
    assert.deepEqual(at(""), [], `${field} empty reads as the default`);
  }
  const d = { ...draftFromMonitor(monitor()), degraded: { ...defaultDegradedDraft(), latencyMarginMs: 2000 } };
  assert.ok(draftProblems(d, { m2a: true, m3: true }).includes("degraded"));
  assert.ok(!draftProblems(d, { m2a: true }).includes("degraded"), "an older server has no thresholds to refuse");
});

test("thresholds: canonical form rounds, leaves defaults out and reads stored zero as the default", () => {
  assert.deepEqual(canonicalRule(defaultDegradedDraft()), {});
  assert.deepEqual(canonicalRule({ lossPercent: 4.26, lossFactor: 2, latencyFactor: 3, latencyMarginMs: 44.6 }), { loss_percent: 4.3, latency_factor: 3, latency_margin_ms: 45 });
  assert.deepEqual(degradedDraftFrom({ loss_percent: 0, latency_margin_ms: 50 }), { lossPercent: 2, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 50 });
});

test("thresholds diff: unchanged is not sent, a change replaces the rule whole, a reset sends {}", () => {
  const m = monitor({ degraded: { loss_percent: 5, latency_margin_ms: 50 } });
  const d = draftFromMonitor(m);
  assert.equal(buildUpdate(m, d, { m3: true }).degraded, undefined, "unchanged thresholds are not sent");
  assert.equal(draftChanged(m, d), false);
  assert.deepEqual(buildUpdate(m, { ...d, degraded: { ...d.degraded, lossFactor: 3 } }, { m3: true }).degraded, { loss_percent: 5, loss_factor: 3, latency_margin_ms: 50 });
  assert.deepEqual(buildUpdate(m, { ...d, degraded: defaultDegradedDraft() }, { m3: true }).degraded, {}, "a reset to the defaults");
  assert.equal(buildUpdate(m, { ...d, degraded: defaultDegradedDraft() }).degraded, undefined, "never sent to a server that does not judge degraded");
  assert.equal(degradedEdit(undefined, { ...defaultDegradedDraft(), lossPercent: "2.0" }), undefined, "typing the default is no change");
  assert.equal(degradedEdit({ loss_percent: 2 }, defaultDegradedDraft()), undefined, "a stored default is the default");
});
