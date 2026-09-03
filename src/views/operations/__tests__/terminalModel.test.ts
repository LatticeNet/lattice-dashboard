import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TERMINAL_LIMITS,
  buildSessionTabs,
  closeReason,
  connectReadiness,
  createRequest,
  deniedState,
  filterNodes,
  isForbidden,
  latestEnded,
  mergeSessionState,
  nextActiveTab,
  parseTime,
  proofLabels,
  resolveTransport,
  sessionCounts,
  type NodeLike,
  type SessionLike,
} from "../terminalModel.ts";

function node(over: Partial<NodeLike> & { id: string }): NodeLike {
  return {
    name: over.id,
    online: true,
    agent_version: "0.3.9-alpha.2",
    agent_runtime: { allow_terminal: true, no_exec: false, terminal_transport: "stream" },
    ...over,
  };
}

function session(over: Partial<SessionLike> & { id: string }): SessionLike {
  return {
    node_id: "n1",
    actor_id: "cdcd",
    shell: "bash",
    status: "open",
    created_at: "2026-09-02T03:52:10Z",
    opened_at: "2026-09-02T03:52:12Z",
    ...over,
  };
}

const NODES = [node({ id: "n1", name: "[cd]-DMIT-pro-malibu" }), node({ id: "n2", name: "gomami-hk-turin-mini" })];

// --- close reasons ----------------------------------------------------------

test("the server's reaper reasons map to their kinds and a live session has none", () => {
  assert.equal(closeReason(session({ id: "a", status: "open" })), undefined);
  assert.deepEqual(closeReason(session({ id: "a", status: "failed", error: "terminal session expired after inactivity" })), { kind: "idle" });
  assert.deepEqual(closeReason(session({ id: "a", status: "failed", error: "terminal session reached maximum duration" })), { kind: "max-duration" });
  assert.deepEqual(
    closeReason(session({ id: "a", status: "failed", error: "terminal session expired before node accepted it" })),
    { kind: "pending-expired" },
  );
});

test("an unfamiliar failure keeps the server's words; a plain close has no detail", () => {
  assert.deepEqual(closeReason(session({ id: "a", status: "failed", error: "pty: fork/exec /bin/zsh: no such file" })), {
    kind: "failed",
    detail: "pty: fork/exec /bin/zsh: no such file",
  });
  assert.deepEqual(closeReason(session({ id: "a", status: "closed" })), { kind: "closed", detail: undefined });
});

test("Go's zero time reads as absent, not as year one", () => {
  assert.equal(parseTime("0001-01-01T00:00:00Z"), undefined);
  assert.equal(parseTime(""), undefined);
  assert.equal(parseTime(undefined), undefined);
  assert.equal(parseTime("2026-09-02T03:52:10Z"), Date.parse("2026-09-02T03:52:10Z"));
});

// --- tabs -------------------------------------------------------------------

test("live listed sessions on any node become tabs, ordered by creation", () => {
  const listed = [
    session({ id: "later", node_id: "n2", created_at: "2026-09-02T04:00:00Z" }),
    session({ id: "first", node_id: "n1", created_at: "2026-09-02T03:00:00Z" }),
    session({ id: "gone", node_id: "n1", status: "closed", created_at: "2026-09-02T02:00:00Z" }),
  ];
  const tabs = buildSessionTabs(listed, [], NODES);
  assert.deepEqual(
    tabs.map((tab) => [tab.id, tab.nodeName, tab.live]),
    [
      ["first", "[cd]-DMIT-pro-malibu", true],
      ["later", "gomami-hk-turin-mini", true],
    ],
  );
  assert.equal(tabs[0]?.actorId, "cdcd", "the recorded actor rides on the tab");
});

test("a session this page watched end stays a tab with its reason until dismissed", () => {
  const ended = session({ id: "e", status: "failed", error: "terminal session expired after inactivity", closed_at: "2026-09-02T04:30:00Z" });
  const tabs = buildSessionTabs([ended], [ended], NODES);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]?.live, false);
  assert.deepEqual(tabs[0]?.reason, { kind: "idle" });
  assert.equal(buildSessionTabs([ended], [ended], NODES, new Set(["e"])).length, 0);
});

test("the listed copy supplies the reason a stream close cannot carry", () => {
  const local = session({ id: "s", status: "closed" });
  const listed = session({ id: "s", status: "failed", error: "terminal session reached maximum duration" });
  const merged = mergeSessionState(listed, local);
  assert.equal(merged?.error, "terminal session reached maximum duration");
  const tabs = buildSessionTabs([listed], [local], NODES);
  assert.deepEqual(tabs[0]?.reason, { kind: "max-duration" });
});

test("a fresher local copy wins over a stale listed one", () => {
  const listed = session({ id: "s", status: "pending", opened_at: "0001-01-01T00:00:00Z" });
  const local = session({ id: "s", status: "open" });
  assert.equal(mergeSessionState(listed, local)?.status, "open");
  assert.equal(mergeSessionState(local, listed)?.status, "open");
});

test("a pending session has no opened time yet", () => {
  const tabs = buildSessionTabs([session({ id: "p", status: "pending", opened_at: "0001-01-01T00:00:00Z" })], [], NODES);
  assert.equal(tabs[0]?.openedAt, undefined);
});

test("closing the active tab moves to its right neighbour, then left, then nothing", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(nextActiveTab(tabs, "b", "b"), "c");
  assert.equal(nextActiveTab(tabs, "c", "c"), "b");
  assert.equal(nextActiveTab(tabs, "a", "c"), "c", "closing another tab keeps the active one");
  assert.equal(nextActiveTab([{ id: "a" }], "a", "a"), "");
});

// --- readiness and transport -----------------------------------------------

test("Connect is off until a node is chosen, and names the one reason it stays off", () => {
  assert.deepEqual(connectReadiness(undefined, "auto"), { ready: false, reason: "no-node" });
  assert.deepEqual(connectReadiness(node({ id: "x", online: false }), "auto"), { ready: false, reason: "offline" });
  assert.deepEqual(connectReadiness(node({ id: "x", disabled: true }), "auto"), { ready: false, reason: "disabled" });
  assert.deepEqual(connectReadiness(node({ id: "x", agent_runtime: { allow_terminal: false } }), "auto"), { ready: false, reason: "terminal-off" });
  assert.deepEqual(connectReadiness(node({ id: "x", agent_runtime: { allow_terminal: true, no_exec: true } }), "auto"), { ready: false, reason: "exec-off" });
  // A node that was enrolled and never installed is not an outage. Calling it
  // offline collapsed the fifth status word and sent operators looking for a
  // machine that had gone quiet, when nothing had ever been there.
  assert.deepEqual(connectReadiness(node({ id: "x", status: "never_reported" }), "auto"), { ready: false, reason: "never-reported" });
  assert.deepEqual(connectReadiness(node({ id: "x" }), "auto"), { ready: true, transport: "stream" });
});

test("transport follows the agent runtime unless the operator forces one", () => {
  assert.equal(resolveTransport(node({ id: "x" }), "auto"), "stream");
  assert.equal(resolveTransport(node({ id: "x", agent_runtime: { allow_terminal: true } }), "auto"), "poll");
  assert.equal(resolveTransport(node({ id: "x" }), "poll"), "poll");
  assert.equal(resolveTransport(undefined, "auto"), "poll");
});

// --- node binding -----------------------------------------------------------

test("the create request binds the id chosen at click time; a list reorder does not retarget it", () => {
  const before = [node({ id: "n1", name: "alpha" }), node({ id: "n2", name: "bravo" }), node({ id: "n3", name: "charlie" })];
  const chosen = before[1]!.id;
  const reordered = [before[2]!, before[0]!, before[1]!];
  const request = createRequest(reordered, chosen, "bash", { cols: 120, rows: 34 });
  assert.deepEqual(request, { node_id: "n2", shell: "bash", cols: 120, rows: 34 });
  assert.equal(createRequest(reordered.filter((n) => n.id !== chosen), chosen, "bash", { cols: 120, rows: 34 }), undefined, "a node that left the list is not opened");
  assert.equal(createRequest(before, "", "bash", { cols: 120, rows: 34 }), undefined, "nothing is chosen by default");
});

test("node search matches name, id, address and tags, and lists ready nodes first", () => {
  const nodes = [
    node({ id: "zz", name: "zeta", online: false }),
    node({ id: "aa", name: "alpha", public_ip: "203.0.113.5", tags: ["relay"] }),
    node({ id: "bb", name: "bravo", online: false, tags: ["relay"] }),
  ];
  assert.deepEqual(filterNodes(nodes, "").map((n) => n.id), ["aa", "bb", "zz"]);
  assert.deepEqual(filterNodes(nodes, "relay").map((n) => n.id), ["aa", "bb"]);
  assert.deepEqual(filterNodes(nodes, "113.5").map((n) => n.id), ["aa"]);
  assert.deepEqual(filterNodes(nodes, "ZZ").map((n) => n.id), ["zz"]);
});

// --- proof line -------------------------------------------------------------

test("the proof line states transport, shell, agent and live counts once a node is chosen", () => {
  const chosen = node({ id: "n1" });
  const labels = proofLabels({ node: chosen, readiness: connectReadiness(chosen, "auto"), shell: "bash", liveOwn: 2, liveOnNode: 1 });
  assert.deepEqual(labels, [
    { key: "transport", transport: "stream" },
    { key: "shell", shell: "bash" },
    { key: "agent", version: "0.3.9-alpha.2" },
    { key: "liveOnNode", count: 1 },
    { key: "liveOwn", count: 2 },
    { key: "audited" },
  ]);
});

test("without a node the proof line still says what is live and that sessions are audited", () => {
  const labels = proofLabels({ readiness: connectReadiness(undefined, "auto"), shell: "bash", liveOwn: 0, liveOnNode: 0 });
  assert.deepEqual(labels, [{ key: "liveOwn", count: 0 }, { key: "audited" }]);
});

test("a blocked node replaces transport and shell with the reason", () => {
  const offline = node({ id: "n1", online: false, agent_version: undefined });
  const labels = proofLabels({ node: offline, readiness: connectReadiness(offline, "auto"), shell: "bash", liveOwn: 1, liveOnNode: 0 });
  assert.deepEqual(labels[0], { key: "blocked", reason: "offline" });
  assert.deepEqual(labels[1], { key: "agentUnknown" });
});

test("live counts come from the listed sessions, which are the operator's own", () => {
  const sessions = [session({ id: "a", node_id: "n1" }), session({ id: "b", node_id: "n2" }), session({ id: "c", node_id: "n1", status: "closed" })];
  assert.deepEqual(sessionCounts(sessions, "n1"), { liveOwn: 2, liveOnNode: 1 });
  assert.deepEqual(sessionCounts(sessions, ""), { liveOwn: 2, liveOnNode: 0 });
  assert.equal(latestEnded(sessions)?.id, "c");
});

test("the printed limits are the server's constants", () => {
  assert.deepEqual(TERMINAL_LIMITS, { maxSessions: 128, maxPerNode: 4, pendingMinutes: 10, idleMinutes: 30, absoluteHours: 8 });
});

// --- denied states ----------------------------------------------------------

test("no scope and a forbidden list are denied states; a network error is not", () => {
  assert.equal(deniedState({ hasScope: false }), "no-scope");
  assert.equal(deniedState({ hasScope: true, listError: { status: 403 } }), "forbidden");
  assert.equal(deniedState({ hasScope: true, listError: new Error("fetch failed") }), undefined);
  assert.equal(deniedState({ hasScope: true }), undefined);
});

test("a 403 is recognised by shape so the harness fake and the real client both qualify", () => {
  assert.equal(isForbidden({ status: 403 }), true);
  assert.equal(isForbidden({ status: 404 }), false);
  assert.equal(isForbidden(new Error("x")), false);
  assert.equal(isForbidden(undefined), false);
});
