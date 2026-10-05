import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ConnRecord,
  LogSource,
  LogSourceStatsView,
  TraceCollectorView,
  TracePolicy,
  TraceSession,
} from "../../../lib/api/types.ts";
import { connRecordKey, readConnTraceFilters, resolveTraceWindow } from "../connTraceModel.ts";
import {
  EMPTY_EVIDENCE_QUERY,
  uniformPolicyColumns,
  captureBlock,
  captureRequest,
  captureSessionName,
  collectingNodeCount,
  collectorReadiness,
  connMatchesText,
  connectionOnlyTokens,
  evidenceCoverageRows,
  evidenceQueryEqual,
  evidenceStoreProof,
  formatEvidenceQuery,
  isActiveSession,
  legacyEvidenceQuery,
  normalizeEvidenceQuery,
  notReadyNodeCount,
  parseConnKey,
  policyRawDraft,
  rawFollowsRecords,
  readinessAwaitsAgent,
  readinessNeedsAttention,
  serverReportsReadiness,
  shedSummary,
  parseEvidenceQuery,
  unresolvedEvidenceTokens,
  pickLogSource,
  readEvidenceQuery,
  seedCaptureNodes,
  resolveEvidenceLayer,
  resolveEvidenceLens,
  summarizeLastHour,
  tokenizeEvidenceQuery,
  writeEvidenceLayer,
  writeEvidenceQuery,
  type EvidenceTokenResolvers,
} from "../evidenceModel.ts";

/* ------------------------------------------------------------------ */
/* Layers and old links                                                */
/* ------------------------------------------------------------------ */

test("a bare Evidence URL opens Overview", () => {
  assert.equal(resolveEvidenceLayer({}), "overview");
  assert.deepEqual(normalizeEvidenceQuery({}), {});
});

test("an explicit view wins and unknown views fall back", () => {
  assert.equal(resolveEvidenceLayer({ view: "collection" }), "collection");
  assert.equal(resolveEvidenceLayer({ view: "explore" }), "explore");
  assert.equal(resolveEvidenceLayer({ view: "nonsense" }), "overview");
  assert.equal(resolveEvidenceLayer({ view: "nonsense", node_id: "n" }), "explore");
});

// vpn-core's evidenceRoute() mints exactly these (lattice-plugin-vpn-core
// ui/src/navigate.ts), and the plugin allowlist admits lens, node_id,
// line_uuid, user_id and tab. Each must still open the question it asked.
test("vpn-core's Connections link opens Explore on that node and line", () => {
  const query = { node_id: "node_ob46mh4ltshdpkhc", line_uuid: "0000abcd-0000-4000-8000-000000000001" };
  assert.equal(resolveEvidenceLayer(query), "explore");
  assert.equal(resolveEvidenceLens(query), "connections");
  assert.deepEqual(normalizeEvidenceQuery(query), { ...query, view: "explore" });
  assert.equal(readConnTraceFilters(normalizeEvidenceQuery(query)).nodeId, "node_ob46mh4ltshdpkhc");
});

test("vpn-core's Raw log link opens the raw log lens on that node", () => {
  const query = { node_id: "n", lens: "log" };
  assert.equal(resolveEvidenceLayer(query), "explore");
  assert.equal(resolveEvidenceLens(query), "log");
  assert.deepEqual(normalizeEvidenceQuery(query), { node_id: "n", lens: "log", view: "explore" });
});

test("the old inner tabs map onto layers and the tab key is dropped", () => {
  assert.deepEqual(normalizeEvidenceQuery({ tab: "policy" }), { view: "collection" });
  assert.deepEqual(normalizeEvidenceQuery({ tab: "sessions" }), { view: "collection" });
  assert.deepEqual(normalizeEvidenceQuery({ tab: "connections" }), { view: "explore" });
  assert.deepEqual(
    normalizeEvidenceQuery({ lens: "connections", node_id: "n", tab: "policy" }),
    { node_id: "n", view: "collection" },
  );
  // An explicit view outranks a stale tab riding along with it, and Overview
  // with nothing else to say is the bare URL.
  assert.deepEqual(normalizeEvidenceQuery({ view: "overview", tab: "policy" }), {});
  assert.deepEqual(normalizeEvidenceQuery({ view: "overview", tab: "policy", node_id: "n" }), {
    node_id: "n",
    view: "overview",
  });
});

test("the default lens is never spelled", () => {
  assert.deepEqual(normalizeEvidenceQuery({ lens: "connections" }), { view: "explore" });
  assert.deepEqual(normalizeEvidenceQuery({ view: "explore", lens: "LOG" }), { view: "explore", lens: "log" });
});

test("the retired routes land on the lens they were", () => {
  assert.deepEqual(legacyEvidenceQuery("logs", {}), { lens: "log", view: "explore" });
  assert.deepEqual(legacyEvidenceQuery("logs", { node_id: "n" }), { node_id: "n", lens: "log", view: "explore" });
  assert.deepEqual(legacyEvidenceQuery("trace", {}), {});
  assert.deepEqual(legacyEvidenceQuery("trace", { tab: "policy" }), { view: "collection" });
  assert.deepEqual(
    legacyEvidenceQuery("trace", { range: "24h", close_reason: "timeout" }),
    { range: "24h", close_reason: "timeout", view: "explore" },
  );
});

test("normalizing is idempotent, so the view can apply it on every navigation", () => {
  const samples = [
    {},
    { tab: "policy" },
    { node_id: "n", lens: "log" },
    { view: "overview", node_id: "n" },
    { lens: "connections", conn: "n:0:1:2026-09-29T08:00:00Z" },
  ];
  for (const sample of samples) {
    const once = normalizeEvidenceQuery(sample);
    assert.ok(evidenceQueryEqual(once, normalizeEvidenceQuery(once)), JSON.stringify(sample));
  }
});

test("stepping to Overview keeps the question and says which layer it is", () => {
  const explore = { view: "explore", node_id: "n", q: "google" };
  const overview = writeEvidenceLayer(explore, "overview");
  assert.deepEqual(overview, { node_id: "n", q: "google", view: "overview" });
  assert.equal(resolveEvidenceLayer(overview), "overview");
  assert.deepEqual(writeEvidenceLayer(overview, "explore"), explore);
  // With nothing to keep, Overview is the bare URL.
  assert.deepEqual(writeEvidenceLayer({ view: "collection" }, "overview"), {});
});

test("a panel link opens Explore", () => {
  assert.equal(resolveEvidenceLayer({ conn: "n:0:1:2026-09-29T08:00:00Z" }), "explore");
});

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

const NODES = new Map([
  ["nod_legend", "legend-sg"],
  ["nod_dmit", "DMIT-1"],
]);
const resolvers: EvidenceTokenResolvers = {
  nodeId: (value) => {
    if (NODES.has(value)) return value;
    for (const [id, name] of NODES) if (name.toLowerCase() === value.toLowerCase()) return id;
    return undefined;
  },
  nodeLabel: (id) => NODES.get(id) ?? id,
  userId: (value) => (value === "alice" ? "usr_alice" : value === "usr_alice" ? value : undefined),
  userLabel: (id) => (id === "usr_alice" ? "alice" : id),
  sourceId: (value) => (value === "sing-box" ? "src_sb" : value === "src_sb" ? value : undefined),
  sourceLabel: (id) => (id === "src_sb" ? "sing-box" : id),
};

test("the tokenizer splits on space and keeps quoted values whole", () => {
  assert.deepEqual(tokenizeEvidenceQuery('  node:a   dest:"x y"  free '), ["node:a", "dest:x y", "free"]);
  assert.deepEqual(tokenizeEvidenceQuery('dest:"unclosed value'), ["dest:unclosed value"]);
  assert.deepEqual(tokenizeEvidenceQuery(""), []);
});

test("every token lands on the field the request carries", () => {
  const { query, problems } = parseEvidenceQuery(
    "node:legend-sg user:alice line:8f1c dest:google.com reason:timeout,dial_failed kind:managed session:trace_1 stalled open youtube 443",
    resolvers,
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(query, {
    nodeId: "nod_legend",
    userId: "usr_alice",
    lineUuid: "8f1c",
    sessionId: "trace_1",
    dst: "google.com",
    // Canonical order, not typed order.
    closeReasons: ["timeout", "dial_failed"],
    userKinds: ["managed"],
    stalledOnly: true,
    includeOpen: true,
    sourceId: "",
    text: "youtube 443",
  });
});

test("node names resolve case-insensitively and lists keep every member", () => {
  const { query } = parseEvidenceQuery("node:LEGEND-SG,dmit-1", resolvers);
  assert.equal(query.nodeId, "nod_legend,nod_dmit");
});

test("a word whose prefix is not a key stays free text", () => {
  const { query, problems } = parseEvidenceQuery("example.com:443 [2001:db8::1]:80 http://x", resolvers);
  assert.deepEqual(problems, []);
  assert.equal(query.text, "example.com:443 [2001:db8::1]:80 http://x");
});

test("problems are reported, and a value that does not resolve is kept as typed", () => {
  const { query, problems } = parseEvidenceQuery("node:nowhere reason:exploded kind:alien dest: source:x", resolvers);
  assert.equal(query.nodeId, "nowhere");
  assert.deepEqual(query.closeReasons, []);
  assert.deepEqual(query.userKinds, []);
  assert.equal(query.sourceId, "x");
  assert.deepEqual(problems, [
    { token: "node:nowhere", kind: "unresolved" },
    { token: "reason:exploded", kind: "unknown-value" },
    { token: "kind:alien", kind: "unknown-value" },
    { token: "dest:", kind: "empty-value" },
    { token: "source:x", kind: "unresolved" },
  ]);
});

test("quotes group values, escape themselves, and keep quoted words as text", () => {
  assert.deepEqual(tokenizeEvidenceQuery('dest:"a \\"b\\" c" x'), ['dest:a "b" c', "x"]);
  assert.deepEqual(tokenizeEvidenceQuery('dest:"back\\\\slash"'), ["dest:back\\slash"]);
  const { query, problems } = parseEvidenceQuery('"node:x" "open" "stalled" open', resolvers);
  assert.deepEqual(problems, []);
  assert.equal(query.nodeId, "");
  assert.equal(query.text, "node:x open stalled");
  assert.equal(query.includeOpen, true);
  assert.equal(query.stalledOnly, false);
});

test("values with colons, quotes and non-ASCII round-trip through the field", () => {
  const cases = [
    { ...EMPTY_EVIDENCE_QUERY, dst: "[2001:db8::1]:443" },
    { ...EMPTY_EVIDENCE_QUERY, dst: 'say "hi"' },
    { ...EMPTY_EVIDENCE_QUERY, dst: "a\\b" },
    { ...EMPTY_EVIDENCE_QUERY, dst: "東京.example" },
    { ...EMPTY_EVIDENCE_QUERY, text: "node:x open stalled is:open plain" },
    { ...EMPTY_EVIDENCE_QUERY, text: 'quote"inside' },
  ];
  for (const query of cases) {
    const text = formatEvidenceQuery(query);
    assert.deepEqual(parseEvidenceQuery(text).query, query, text);
  }
  assert.equal(formatEvidenceQuery({ ...EMPTY_EVIDENCE_QUERY, text: "node:x open plain" }), '"node:x" "open" plain');
});

test("a node name in any script resolves", () => {
  const unicode: EvidenceTokenResolvers = { nodeId: (value) => (value === "東京-1" ? "nod_tokyo" : undefined) };
  assert.equal(parseEvidenceQuery("node:東京-1", unicode).query.nodeId, "nod_tokyo");
});

test("is:stalled and is:open read like the bare flags", () => {
  const { query } = parseEvidenceQuery("is:stalled IS:OPEN");
  assert.equal(query.stalledOnly, true);
  assert.equal(query.includeOpen, true);
});

test("formatting names what it can and parses back to the same query", () => {
  const query = {
    ...EMPTY_EVIDENCE_QUERY,
    nodeId: "nod_legend,nod_dmit",
    userId: "usr_alice",
    dst: "a b",
    closeReasons: ["reset"],
    stalledOnly: true,
    sourceId: "src_sb",
    text: "free words",
  };
  const text = formatEvidenceQuery(query, resolvers);
  assert.equal(text, 'node:legend-sg,DMIT-1 source:sing-box user:alice dest:"a b" reason:reset stalled free words');
  assert.deepEqual(parseEvidenceQuery(text, resolvers).query, query);
  assert.equal(formatEvidenceQuery(EMPTY_EVIDENCE_QUERY), "");
});

test("the field round-trips through the address bar without touching the range", () => {
  const start = { view: "explore", range: "24h", "conn.sort": "started_at" };
  const parsed = parseEvidenceQuery("node:nod_dmit reason:timeout source:src_sb hello", resolvers).query;
  const written = writeEvidenceQuery(start, parsed);
  assert.deepEqual(written, {
    view: "explore",
    range: "24h",
    "conn.sort": "started_at",
    node_id: "nod_dmit",
    close_reason: "timeout",
    source: "src_sb",
    q: "hello",
  });
  assert.deepEqual(readEvidenceQuery(written), parsed);
  // Clearing the field clears every filter and keeps the window.
  assert.deepEqual(writeEvidenceQuery(written, EMPTY_EVIDENCE_QUERY), {
    view: "explore",
    range: "24h",
    "conn.sort": "started_at",
  });
});

test("the raw log lens names the tokens it cannot apply", () => {
  const { query } = parseEvidenceQuery("node:x user:u reason:reset dest:d text", resolvers);
  assert.deepEqual(connectionOnlyTokens(query), ["user", "dest", "reason"]);
});

test("free text needs every word somewhere in the row", () => {
  assert.equal(connMatchesText(["alice", "legend-sg", "google.com:443"], "legend 443"), true);
  assert.equal(connMatchesText(["alice", "legend-sg", "google.com:443"], "legend 80"), false);
  assert.equal(connMatchesText(["x"], "  "), true);
});

test("the any-time range sends no window at all", () => {
  const filters = readConnTraceFilters({ range: "all" });
  assert.equal(filters.range, "all");
  assert.deepEqual(resolveTraceWindow(filters, Date.parse("2026-09-29T08:00:00Z")), { since: "", until: "" });
});

/* ------------------------------------------------------------------ */
/* Panel address                                                       */
/* ------------------------------------------------------------------ */

test("the panel key reads back with the colons of its timestamp", () => {
  const record = {
    node_id: "nod_legend",
    core_generation: 3,
    log_id: 4021,
    started_at: "2026-09-29T08:01:02.5Z",
  } as ConnRecord;
  assert.deepEqual(parseConnKey(connRecordKey(record)), {
    node_id: "nod_legend",
    core_generation: 3,
    log_id: 4021,
    started_at: "2026-09-29T08:01:02.5Z",
  });
  assert.equal(parseConnKey("garbage"), null);
  assert.equal(parseConnKey("n:x:1:2026"), null);
  assert.equal(parseConnKey(":0:1:2026"), null);
});

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-09-29T08:00:00Z");

function policy(node_id: string, enabled = false): TracePolicy {
  return { node_id, enabled, level: "debug", budget_lines_per_sec: 500 };
}

function session(id: string, node_ids: string[], state = "running"): TraceSession {
  return {
    id,
    name: id,
    filter: { node_ids },
    level: "debug",
    started_at: "2026-09-29T07:30:00Z",
    expires_at: id === "s1" ? "2026-09-29T08:30:00Z" : "2026-09-29T08:10:00Z",
    state,
    started_by: "cdcd",
    lines: 0,
    records: 0,
    dropped: 0,
  };
}

const SOURCE: LogSource = {
  id: "src_sb",
  name: "sing-box",
  node_id: "nod_legend",
  path: "singbox://nod_legend",
  enabled: true,
  max_line_bytes: 8192,
  max_batch_lines: 500,
  created_at: "",
  updated_at: "",
  managed: true,
};

const STATS: LogSourceStatsView = {
  source_id: "src_sb",
  node_id: "nod_legend",
  name: "sing-box",
  path: "singbox://nod_legend",
  enabled: true,
  lines: 82,
  bytes: 9000,
  last_ingest_at: "2026-08-27T10:00:00Z",
};

test("production today: nothing collects, one stale source, and the quiet nodes say so", () => {
  const rows = evidenceCoverageRows({
    nodes: [
      { id: "nod_legend", name: "legend-sg" },
      { id: "nod_dmit", name: "DMIT-1" },
    ],
    policies: [policy("nod_dmit"), policy("nod_legend")],
    sessions: [],
    sources: [SOURCE],
    stats: [STATS],
    nowMs: NOW,
  });
  assert.deepEqual(
    rows.map((row) => [row.name, row.quiet, row.heldLines]),
    [
      ["legend-sg", false, 82],
      ["DMIT-1", true, 0],
    ],
  );
  assert.equal(rows[0]?.sources[0]?.stale, true);
  assert.equal(rows[0]?.sources[0]?.lastIngestAt, "2026-08-27T10:00:00Z");
  assert.equal(collectingNodeCount(rows), 0);
});

test("a fresh source is not stale, and one that never shipped is", () => {
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [policy("nod_legend")],
    sessions: [],
    sources: [SOURCE, { ...SOURCE, id: "src_debug", name: "agent debug" }],
    stats: [
      { ...STATS, last_ingest_at: "2026-09-29T07:00:00Z" },
      { ...STATS, source_id: "src_debug", lines: 0, last_ingest_at: "0001-01-01T00:00:00Z" },
    ],
    nowMs: NOW,
  });
  const [debug, singbox] = rows[0]!.sources;
  assert.equal(singbox?.stale, false);
  assert.equal(debug?.stale, true);
  assert.equal(debug?.lastIngestAt, "");
});

test("captures count per node, a fleet capture covers everyone, and the soonest end is kept", () => {
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [policy("a"), policy("b"), policy("c", true)],
    sessions: [session("s1", ["a", "b"]), session("s2", ["a"]), session("s3", [], "stopped")],
    sources: [],
    stats: [],
    lastHourByNode: new Map([["a", 12]]),
    nowMs: NOW,
  });
  assert.deepEqual(
    rows.map((row) => [row.nodeId, row.capturing, row.captureEndsAt, row.lastHour]),
    [
      ["a", 2, "2026-09-29T08:10:00Z", 12],
      ["b", 1, "2026-09-29T08:30:00Z", 0],
      ["c", 0, "", 0],
    ],
  );
  assert.equal(collectingNodeCount(rows), 3);
  const fleet = evidenceCoverageRows({
    nodes: [],
    policies: [policy("a"), policy("b")],
    sessions: [session("s9", [])],
    sources: [],
    stats: [],
    nowMs: NOW,
  });
  assert.deepEqual(fleet.map((row) => row.capturing), [1, 1]);
});

test("an unread stats answer leaves the held count unknown, not zero", () => {
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: undefined,
    sessions: [],
    sources: [SOURCE],
    stats: [],
    nowMs: NOW,
  });
  assert.equal(rows[0]?.heldLines, undefined);
  assert.equal(rows[0]?.sources[0]?.lines, undefined);
});

test("a node whose policy or sources were not read is never called idle", () => {
  const noPolicies = evidenceCoverageRows({
    nodes: [{ id: "a", name: "a" }],
    policies: undefined,
    sessions: [],
    sources: [],
    stats: [],
    nowMs: NOW,
  });
  assert.equal(noPolicies[0]?.quiet, false);
  assert.equal(noPolicies[0]?.trace, undefined);
  const noSources = evidenceCoverageRows({
    nodes: [],
    policies: [policy("a")],
    sessions: [],
    sources: [],
    sourcesKnown: false,
    stats: [],
    nowMs: NOW,
  });
  assert.equal(noSources[0]?.quiet, false);
  assert.equal(noSources[0]?.sourcesKnown, false);
  assert.equal(noSources[0]?.heldLines, undefined);
});

test("with no trace store on the server, nodes without a source collapse as idle", () => {
  const rows = evidenceCoverageRows({
    nodes: [{ id: "a", name: "a" }, { id: "nod_legend", name: "legend-sg" }],
    policies: undefined,
    sessions: [],
    sources: [SOURCE],
    stats: [STATS],
    traceUnavailable: true,
    nowMs: NOW,
  });
  assert.deepEqual(rows.map((row) => [row.nodeId, row.quiet]), [["nod_legend", false], ["a", true]]);
});

test("the proof line uses full stats when it has them and the page count otherwise", () => {
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [policy("a", true), policy("b")],
    sessions: [],
    sources: [],
    stats: [],
    nowMs: NOW,
  });
  assert.deepEqual(
    evidenceStoreProof({
      stats: { records: 0, max_bytes: 2 * 1024 ** 3, cipher_enabled: true },
      collectedTotal: 5,
      rows,
      coverageKnown: true,
    }),
    { records: 0, encrypted: true, capBytes: 2 * 1024 ** 3, collecting: 1, notReady: 0, total: 2 },
  );
  assert.deepEqual(
    evidenceStoreProof({ stats: { scoped: true, cipher_enabled: true }, collectedTotal: 5, rows, coverageKnown: false }),
    { records: 5, encrypted: true, capBytes: undefined, collecting: 1, notReady: 0, total: undefined },
  );
  assert.deepEqual(evidenceStoreProof({ rows: [], coverageKnown: false }), {
    records: undefined,
    encrypted: undefined,
    capBytes: undefined,
    collecting: 0,
    notReady: 0,
    total: undefined,
  });
});

/* ------------------------------------------------------------------ */
/* Last hour                                                           */
/* ------------------------------------------------------------------ */

function record(node_id: string, close_reason: string, host: string, extra: Partial<ConnRecord> = {}): ConnRecord {
  return { node_id, log_id: 1, started_at: "2026-09-29T07:30:00Z", close_reason, dst_host: host, ...extra };
}

test("the last hour counts failures by reason and the top destinations", () => {
  const records = [
    record("a", "eof", "google.com"),
    record("a", "timeout", "google.com"),
    record("b", "dial_failed", "api.x.com"),
    record("b", "dial_failed", "API.X.COM"),
    record("b", "timeout", "", { sniffed_domain: "cdn.y.net", dst_ip: "1.2.3.4" }),
    record("b", "timeout", "cdn.y.net"),
    record("b", "timeout", "", { open: true }),
  ];
  const summary = summarizeLastHour(records, true, 2);
  assert.equal(summary.total, 7);
  assert.equal(summary.capped, true);
  // Most frequent first.
  assert.deepEqual(summary.failures, [
    { value: "timeout", count: 3 },
    { value: "dial_failed", count: 2 },
  ]);
  assert.equal(summary.failureTotal, 5);
  assert.deepEqual(summary.destinations, [
    { value: "api.x.com", count: 2 },
    { value: "cdn.y.net", count: 2 },
  ]);
  assert.deepEqual([...summary.byNode.entries()], [["a", 2], ["b", 5]]);
});

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

test("the capture action says why it cannot run", () => {
  const base = { canAdmin: true, storeReady: true, nodeIds: ["a"], sessions: [] as TraceSession[], sessionsKnown: true, nowMs: NOW };
  assert.equal(captureBlock(base), "");
  assert.equal(captureBlock({ ...base, canAdmin: false }), "needs-admin");
  assert.equal(captureBlock({ ...base, storeReady: false }), "store-off");
  // An unread capture list is not an empty one: the limits cannot be checked.
  assert.equal(captureBlock({ ...base, sessionsKnown: false }), "sessions-unread");
  assert.equal(captureBlock({ ...base, nodeIds: [] }), "no-nodes");
  const many = Array.from({ length: 16 }, (_, i) => session(`s${i}`, [`n${i}`]));
  assert.equal(captureBlock({ ...base, sessions: many }), "limit-total");
  const onA = Array.from({ length: 8 }, (_, i) => session(`s${i}`, ["a"]));
  assert.equal(captureBlock({ ...base, sessions: onA }), "limit-node");
  // Past their deadline they no longer count, as ActiveTraceSessions(now) on the server.
  assert.equal(captureBlock({ ...base, sessions: onA, nowMs: Date.parse("2026-09-29T09:00:00Z") }), "");
});

test("a running capture past its deadline is not active", () => {
  const s = session("s1", ["a"]);
  assert.equal(isActiveSession(s, NOW), true);
  assert.equal(isActiveSession(s, Date.parse("2026-09-29T08:30:00Z")), false);
  assert.equal(isActiveSession({ ...s, state: "stopped" }, NOW), false);
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [policy("a")],
    sessions: [s],
    sources: [],
    stats: [],
    nowMs: Date.parse("2026-09-29T09:00:00Z"),
  });
  assert.equal(rows[0]?.capturing, 0);
  assert.equal(rows[0]?.quiet, true);
});

test("a capture seeded from the address bar keeps only nodes the operator can choose", () => {
  const choices = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(seedCaptureNodes("a, b ,a,ghost", choices), ["a", "b"]);
  assert.deepEqual(seedCaptureNodes("", choices), []);
  assert.deepEqual(seedCaptureNodes("a", []), []);
});

test("a capture is named for its nodes and time and asks for debug on exactly those nodes", () => {
  const now = new Date("2026-09-29T08:05:00Z");
  assert.equal(captureSessionName(["legend-sg", "DMIT-1"], now), "capture legend-sg, DMIT-1 2026-09-29 08:05Z");
  assert.equal(captureSessionName(["a", "b", "c", "d", "e"], now), "capture a, b, c +2 2026-09-29 08:05Z");
  assert.deepEqual(captureRequest(["a", "b"], 3600, "n"), {
    name: "n",
    level: "debug",
    ttl_seconds: 3600,
    filter: { node_ids: ["a", "b"] },
  });
});

/* ------------------------------------------------------------------ */
/* Raw log source                                                      */
/* ------------------------------------------------------------------ */

test("the raw log lens reads the named source, then the node's, and never another node's", () => {
  const other: LogSource = { ...SOURCE, id: "src_other", name: "a-first", node_id: "nod_dmit" };
  const disabled: LogSource = { ...SOURCE, id: "src_off", name: "0-off", enabled: false };
  const sources = [SOURCE, other, disabled];
  assert.equal(pickLogSource(sources, { sourceId: "src_off", nodeId: "" })?.id, "src_off");
  assert.equal(pickLogSource(sources, { sourceId: "", nodeId: "nod_legend" })?.id, "src_sb");
  assert.equal(pickLogSource(sources, { sourceId: "", nodeId: "" })?.id, "src_other");
  assert.equal(pickLogSource(sources, { sourceId: "", nodeId: "nod_none" }), undefined);
  assert.equal(pickLogSource([], { sourceId: "", nodeId: "" }), undefined);
});

test("with stats, the raw log lens opens on the source that shipped most recently", () => {
  const stale: LogSource = { ...SOURCE, id: "src_a", name: "a-stale", node_id: "nod_dmit" };
  const fresh: LogSource = { ...SOURCE, id: "src_z", name: "z-fresh" };
  const stats = [
    { ...STATS, source_id: "src_a", last_ingest_at: "2026-08-27T10:00:00Z" },
    { ...STATS, source_id: "src_z", last_ingest_at: "2026-09-29T07:59:00Z" },
  ];
  assert.equal(pickLogSource([stale, fresh], { sourceId: "", nodeId: "" }, stats)?.id, "src_z");
  assert.equal(pickLogSource([stale, fresh], { sourceId: "", nodeId: "" })?.id, "src_a");
});

test("a policy column the same on every node is said once, in its header", () => {
  const all = ["a", "b", "c"].map((id) => policy(id));
  // Production today: every node debug, 500 a second, never changed.
  assert.deepEqual(uniformPolicyColumns(all), { level: "debug", budget: 500, updated: null });

  const edited = [...all.slice(0, 2), { ...policy("c", true), level: "info" as const, updated_at: "2026-09-29T01:00:00Z" }];
  assert.deepEqual(uniformPolicyColumns(edited), { budget: 500 }, "one node that differs keeps its column per row");
  assert.deepEqual(uniformPolicyColumns([policy("a")]), {}, "one row is not a pattern");
  assert.deepEqual(uniformPolicyColumns([]), {});
  assert.deepEqual(
    uniformPolicyColumns([policy("a"), { ...policy("b"), updated_at: "" }]).updated,
    null,
    "an empty timestamp is never changed too",
  );
});

test("the tokens an applied query sent as typed are the ones no list resolved", () => {
  // The node list has not loaded: its resolver knows no node yet.
  const noLists: EvidenceTokenResolvers = { nodeId: () => undefined, sourceId: () => undefined };
  const { query } = parseEvidenceQuery("node:legend-sg reason:timeout dest:example.org", noLists);
  assert.deepEqual(unresolvedEvidenceTokens(query, noLists), ["node:legend-sg"]);
  // With the lists, the same question names a known node and nothing is unresolved.
  const resolved = parseEvidenceQuery("node:legend-sg reason:timeout", resolvers).query;
  assert.deepEqual(unresolvedEvidenceTokens(resolved, resolvers), []);
});

/* ------------------------------------------------------------------ */
/* Collector readiness (design 26, R1)                                 */
/* ------------------------------------------------------------------ */

/** A policy as a server with readiness sends it (raw_effective is always present). */
function readyPolicy(node_id: string, enabled: boolean, collector?: Partial<TraceCollectorView>): TracePolicy {
  return {
    ...policy(node_id, enabled),
    budget_lines_per_sec: 0,
    raw: { enabled: false },
    raw_effective: false,
    collector: collector ? ({ reported_by: "agent", ...collector } as TraceCollectorView) : undefined,
  };
}

test("collectorReadiness: an older server reports no readiness, so there is none to show", () => {
  assert.equal(collectorReadiness(policy("a", true), 0), undefined);
  assert.equal(collectorReadiness(undefined, 1), undefined);
  assert.equal(serverReportsReadiness(policy("a", true)), false);
  assert.equal(serverReportsReadiness(readyPolicy("a", false)), true);
});

test("collectorReadiness: records on and no_clash_api reads not ready with the reason", () => {
  const detail = "no experimental.clash_api in /etc/sing-box/config.json";
  assert.deepEqual(collectorReadiness(readyPolicy("a", true, { state: "no_clash_api", detail }), 0), {
    kind: "not_ready",
    state: "no_clash_api",
    known: true,
    detail,
    inferred: false,
  });
  // The other agent-reported states read the same way.
  for (const state of ["secret_unreadable", "stream_failing"]) {
    assert.equal(collectorReadiness(readyPolicy("a", true, { state }), 0)?.kind, "not_ready");
  }
});

test("collectorReadiness: an older agent without an address is not ready, inferred", () => {
  const inferred = collectorReadiness(readyPolicy("a", true, { state: "no_clash_api", reported_by: "server" }), 0);
  assert.deepEqual(inferred, { kind: "not_ready", state: "no_clash_api", known: true, detail: undefined, inferred: true });
  const tooOld = collectorReadiness(readyPolicy("a", true, { state: "agent_too_old", reported_by: "server" }), 0);
  assert.deepEqual(tooOld, { kind: "not_ready", state: "agent_too_old", known: true, detail: undefined, inferred: true });
});

test("collectorReadiness: records on with no collector yet is waiting, never ready", () => {
  assert.deepEqual(collectorReadiness(readyPolicy("a", true), 0), { kind: "waiting" });
  assert.deepEqual(collectorReadiness(readyPolicy("a", false), 0), { kind: "off" });
  assert.deepEqual(collectorReadiness(readyPolicy("a", false, { state: "off" }), 0), { kind: "off" });
});

test("collectorReadiness: ready names the level the stream delivers", () => {
  assert.deepEqual(collectorReadiness(readyPolicy("a", true, { state: "ready", level: "trace" }), 0), {
    kind: "ready",
    level: "trace",
  });
  assert.deepEqual(collectorReadiness(readyPolicy("a", true, { state: "ready" }), 0), { kind: "ready", level: "debug" });
  const odd = readyPolicy("a", true, { state: "ready", level: 7 as unknown as string });
  assert.deepEqual(collectorReadiness(odd, 0), { kind: "ready", level: "debug" }, "a level of the wrong type is not shown");
});

test("collectorReadiness: a pending report is pending", () => {
  assert.deepEqual(collectorReadiness(readyPolicy("a", true, { state: "no_clash_api", pending: true }), 0), {
    kind: "pending",
  });
  assert.equal(readinessAwaitsAgent({ kind: "pending" }), true);
  assert.equal(readinessAwaitsAgent({ kind: "waiting" }), true);
  assert.equal(readinessAwaitsAgent({ kind: "ready", level: "debug" }), false);
  assert.equal(readinessAwaitsAgent(undefined), false);
});

test("collectorReadiness: a stale report keeps its last state and says stale", () => {
  const stale = collectorReadiness(
    readyPolicy("a", true, { state: "ready", level: "debug", stale: true, received_at: "2026-09-29T07:57:00Z" }),
    0,
  );
  assert.deepEqual(stale, { kind: "stale", last: { kind: "ready", level: "debug" }, heardAt: "2026-09-29T07:57:00Z" });
  // Stale outranks pending: a node gone quiet will not answer the change either.
  assert.equal(collectorReadiness(readyPolicy("a", true, { state: "ready", stale: true, pending: true }), 0)?.kind, "stale");
  // Nothing asks a quiet node with records off to collect.
  assert.deepEqual(collectorReadiness(readyPolicy("a", false, { state: "ready", stale: true }), 0), { kind: "off" });
});

test("collectorReadiness: a capture on a node with records off still needs readiness", () => {
  assert.deepEqual(collectorReadiness(readyPolicy("a", false), 1), { kind: "waiting" });
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [readyPolicy("a", false, { state: "no_clash_api" })],
    sessions: [session("s1", ["a"])],
    sources: [],
    stats: [],
    nowMs: NOW,
  });
  assert.equal(rows[0]?.readiness?.kind, "not_ready");
  assert.equal(readinessNeedsAttention(rows[0]!), true);
  assert.equal(collectingNodeCount(rows), 0, "a capture on a node that cannot record is not recording");
});

test("collectorReadiness: an unknown state string is not ready", () => {
  assert.deepEqual(collectorReadiness(readyPolicy("a", true, { state: "warming_up" }), 0), {
    kind: "not_ready",
    state: "warming_up",
    known: false,
    detail: undefined,
    inferred: false,
  });
  // A collector object without a state is no report at all.
  assert.deepEqual(collectorReadiness(readyPolicy("a", true, { state: "" }), 0), { kind: "waiting" });
});

test("collectingNodeCount counts recording nodes, not switched-on nodes", () => {
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [
      readyPolicy("ready", true, { state: "ready", level: "debug" }),
      readyPolicy("noapi", true, { state: "no_clash_api" }),
      readyPolicy("waiting", true),
      readyPolicy("stale", true, { state: "ready", stale: true }),
      readyPolicy("old", true, { state: "agent_too_old", reported_by: "server" }),
      readyPolicy("off", false),
    ],
    sessions: [],
    sources: [],
    stats: [],
    nowMs: NOW,
  });
  assert.equal(collectingNodeCount(rows), 1);
  assert.equal(
    notReadyNodeCount(rows),
    2,
    "not ready and stale; waiting is on its way, and an agent too old to report may be recording",
  );
  assert.equal(readinessNeedsAttention(rows.find((row) => row.nodeId === "old")!), false);
  const proof = evidenceStoreProof({ rows, coverageKnown: true });
  assert.equal(proof.collecting, 1);
  assert.equal(proof.notReady, 2);
});

test("evidenceCoverageRows ranks on-but-not-ready first", () => {
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [
      readyPolicy("a-ready", true, { state: "ready" }),
      readyPolicy("b-capture", false, { state: "ready" }),
      readyPolicy("c-noapi", true, { state: "no_clash_api" }),
      readyPolicy("d-off", false),
    ],
    sessions: [session("s1", ["b-capture"])],
    sources: [],
    stats: [],
    nowMs: NOW,
  });
  assert.deepEqual(
    rows.map((row) => row.nodeId),
    ["c-noapi", "b-capture", "a-ready", "d-off"],
  );
  assert.equal(rows[0]?.rawLines, false);
});

test("raw draft: a pre-switch policy that is on reads raw as on", () => {
  const preSwitchOn: TracePolicy = { ...policy("a", true), raw_effective: true };
  assert.equal(policyRawDraft(preSwitchOn), true);
  assert.equal(rawFollowsRecords(preSwitchOn), true);
  const preSwitchOff: TracePolicy = { ...policy("a", false), raw_effective: false };
  assert.equal(policyRawDraft(preSwitchOff), false);
  assert.equal(rawFollowsRecords(preSwitchOff), false, "switched on, it gets records only");
  // The stored choice survives records going off and on again.
  const storedOn: TracePolicy = { ...policy("a", false), raw: { enabled: true }, raw_effective: false };
  assert.equal(policyRawDraft(storedOn), true);
  assert.equal(rawFollowsRecords(storedOn), false);
  // An older server has no switch to follow.
  assert.equal(rawFollowsRecords(policy("a", true)), false);
  assert.equal(policyRawDraft(policy("a", true)), false);
});

test("shed connections are shown only when the budget refused some", () => {
  assert.equal(shedSummary(undefined), undefined);
  assert.equal(shedSummary({ state: "ready", reported_by: "agent", shed_connections: 0 }), undefined);
  assert.deepEqual(
    shedSummary({
      state: "ready",
      reported_by: "agent",
      shed_connections: 1204,
      counters_since: "2026-10-05T08:00:00Z",
      budget_lines_per_sec: 5000,
    }),
    { count: 1204, since: "2026-10-05T08:00:00Z", budget: 5000 },
  );
});

test("collectorReadiness: an agent that saw the policy and still reports off is not recording", () => {
  // The report came after the policy (the server does not mark it pending).
  const applied = collectorReadiness(readyPolicy("a", true, { state: "off" }), 0);
  assert.deepEqual(applied, { kind: "not_ready", state: "off", known: true, inferred: false });
  // While the report predates the change it is pending, not a failure.
  assert.deepEqual(collectorReadiness(readyPolicy("a", true, { state: "off", pending: true }), 0), { kind: "pending" });
  // Before any report exists it is waiting.
  assert.deepEqual(collectorReadiness(readyPolicy("a", true), 0), { kind: "waiting" });
  // A capture wanting the node counts the same as records on.
  assert.equal(collectorReadiness(readyPolicy("a", false, { state: "off" }), 1)?.kind, "not_ready");
  const rows = evidenceCoverageRows({
    nodes: [],
    policies: [readyPolicy("off-applied", true, { state: "off" }), readyPolicy("ready", true, { state: "ready" })],
    sessions: [],
    sources: [],
    stats: [],
    nowMs: NOW,
  });
  assert.equal(collectingNodeCount(rows), 1);
  assert.equal(notReadyNodeCount(rows), 1, "counted as not recording");
  assert.equal(rows[0]?.nodeId, "off-applied", "and ranked with the attention rows");
  assert.equal(readinessAwaitsAgent(rows[0]?.readiness), false, "no re-poll waits on it");
});
