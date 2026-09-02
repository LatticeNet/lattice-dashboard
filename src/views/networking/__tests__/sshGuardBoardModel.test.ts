import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFleetStates, type NodeGuardState } from "../sshGuardModel.ts";
import {
  batchRefusal,
  boardStage,
  controlPlaneNodeIds,
  coverageBucket,
  coverageCounts,
  describeSshdNow,
  filterByCoverage,
  foldReality,
  formatAge,
  formatCountdown,
  isCoverageFilter,
  membersToFile,
  newestObservation,
  orderForBoard,
  proofCounts,
  realityDetailsToFetch,
  revertingNodes,
  sshdPorts,
  summarizeBatch,
  type BatchMember,
  type ScopeState,
} from "../sshGuardBoardModel.ts";

function approval(over: Record<string, unknown>) {
  return { id: "a", node_id: "n", plugin: "sshguard", action: "sshguard-arm:v1", plan: "", status: "pending", created_at: "2026-09-02T03:00:00Z", ...over } as never;
}

const FLEET = buildFleetStates(
  [
    approval({ id: "a1", node_id: "done", status: "applied", created_at: "2026-09-02T02:00:00Z" }),
    approval({ id: "c1", node_id: "done", action: "sshguard-confirm:v1", status: "applied", created_at: "2026-09-02T02:30:00Z" }),
    approval({ id: "a2", node_id: "reverting", status: "applied" }),
    approval({ id: "a3", node_id: "broken", status: "rejected", reason: "apply failed" }),
    approval({ id: "a4", node_id: "planned", status: "pending" }),
    approval({ id: "a5", node_id: "broken-excluded", status: "rejected" }),
  ],
  [{ id: "done" }, { id: "reverting" }, { id: "broken" }, { id: "planned" }, { id: "never" }, { id: "left-out" }, { id: "broken-excluded" }],
);

const SCOPES: Record<string, ScopeState> = { "left-out": "excluded", "broken-excluded": "excluded", done: "enrolled" };
const scopeOf = (id: string): ScopeState => SCOPES[id] ?? "undecided";

// The reverting node's arm was applied at 03:00 with the default 900s window,
// so its deadline is 03:15. NOW is inside the window; LATER is past it.
const NOW = Date.parse("2026-09-02T03:05:00Z");
const LATER = Date.parse("2026-09-02T03:20:00Z");

test("every node lands in exactly one coverage bucket, so the chips add up to the fleet", () => {
  const counts = coverageCounts(FLEET, scopeOf, NOW);
  assert.deepEqual(counts, { all: 7, confirmed: 1, reverting: 1, armPending: 1, open: 1, failed: 1, excluded: 2 });
  const sum = counts.confirmed + counts.reverting + counts.armPending + counts.open + counts.failed + counts.excluded;
  assert.equal(sum, counts.all);
});

test("chips use the row words: each stage lands under the chip that names it", () => {
  assert.equal(coverageBucket("idle", "enrolled"), "open");
  assert.equal(coverageBucket("armPending", "enrolled"), "armPending");
  assert.equal(coverageBucket("armApproved", "enrolled"), "armPending");
  assert.equal(coverageBucket("awaitingConfirm", "enrolled"), "reverting");
  assert.equal(coverageBucket("confirmPending", "enrolled"), "reverting");
  assert.equal(coverageBucket("confirmApproved", "enrolled"), "reverting");
  assert.equal(coverageBucket("reverted", "enrolled"), "failed", "an arm that reverted unconfirmed did not survive");
});

test("exclusion hides only what is not live on the box", () => {
  assert.equal(coverageBucket("idle", "excluded"), "excluded");
  assert.equal(coverageBucket("armFailed", "excluded"), "excluded");
  assert.equal(coverageBucket("reverted", "excluded"), "excluded", "nothing is live after a revert either");
  assert.equal(coverageBucket("confirmed", "excluded"), "confirmed", "a hardened node stays on the board");
  assert.equal(coverageBucket("awaitingConfirm", "excluded"), "reverting", "a running revert timer is never hidden");
});

test("filtering by a chip returns that chip's nodes and 'all' returns a copy", () => {
  assert.deepEqual(filterByCoverage(FLEET, "failed", scopeOf, NOW).map((s) => s.nodeId), ["broken"]);
  assert.deepEqual(filterByCoverage(FLEET, "excluded", scopeOf, NOW).map((s) => s.nodeId).sort(), ["broken-excluded", "left-out"]);
  const all = filterByCoverage(FLEET, "all", scopeOf, NOW);
  assert.equal(all.length, FLEET.length);
  assert.notEqual(all, FLEET);
});

test("a closed window turns a reverting row into a reverted one, everywhere at once", () => {
  const reverting = FLEET.find((s) => s.nodeId === "reverting") as NodeGuardState;
  assert.equal(boardStage(reverting, NOW), "awaitingConfirm");
  assert.equal(boardStage(reverting, LATER), "reverted");
  assert.deepEqual(revertingNodes(FLEET, NOW).map((s) => s.nodeId), ["reverting"]);
  assert.deepEqual(revertingNodes(FLEET, LATER), [], "the urgent card empties: there is no timer left to beat");
  const counts = coverageCounts(FLEET, scopeOf, LATER);
  assert.equal(counts.reverting, 0);
  assert.equal(counts.failed, 2);
  assert.deepEqual(filterByCoverage(FLEET, "failed", scopeOf, LATER).map((s) => s.nodeId).sort(), ["broken", "reverting"]);
  assert.deepEqual(proofCounts(FLEET, LATER), { total: 7, confirmed: 1, failedArms: 3, reverting: 0 });
});

test("a reverted node sinks to the failed arms instead of leading the table", () => {
  assert.deepEqual(orderForBoard(FLEET, NOW).map((s) => s.nodeId), ["reverting", "planned", "broken", "broken-excluded", "left-out", "never", "done"]);
  assert.deepEqual(orderForBoard(FLEET, LATER).map((s) => s.nodeId), ["planned", "broken", "broken-excluded", "reverting", "left-out", "never", "done"]);
});

test("a coverage filter from the address bar is accepted only when it names a chip", () => {
  assert.equal(isCoverageFilter("failed"), true);
  assert.equal(isCoverageFilter("enrolled"), false);
  assert.equal(isCoverageFilter(undefined), false);
});

test("the proof line counts confirmed, failed arms and running revert timers", () => {
  assert.deepEqual(proofCounts(FLEET, NOW), { total: 7, confirmed: 1, failedArms: 2, reverting: 1 });
});

// ── evidence ────────────────────────────────────────────────────────────────

test("sshd ports are read the way the server's lint reads them", () => {
  const ports = sshdPorts({
    node_id: "n",
    collected_at: "2026-09-02T03:00:00Z",
    listeners: [
      { protocol: "tcp", port: 22, process: "sshd" },
      { protocol: "tcp", port: 58394, address: "0.0.0.0", process: "sshd: /usr/sbin/sshd -D" },
      { protocol: "tcp", port: 2222, address: "127.0.0.1", process: "sshd" },
      { protocol: "udp", port: 22, process: "sshd" },
      { protocol: "tcp", port: 443, process: "nginx" },
      { protocol: "tcp", port: 58394, address: "::", process: "sshd" },
      { protocol: "tcp", port: 3434, process: "Dropbear" },
    ],
  });
  assert.deepEqual(ports, [22, 3434, 58394]);
});

test("SSHD NOW reads as a claim about the ports, not a status word", () => {
  assert.deepEqual(describeSshdNow([58394]), { kind: "only", ports: [58394], text: ":58394 only" });
  assert.deepEqual(describeSshdNow([22, 58394]), { kind: "several", ports: [22, 58394], text: ":22 + :58394" });
  assert.deepEqual(describeSshdNow([22]), { kind: "legacy", ports: [22], text: ":22" });
  assert.equal(describeSshdNow([]).kind, "none");
  assert.equal(describeSshdNow(undefined).kind, "unknown");
});

test("the fold says when a node was seen from the summary and what it does only from the detail", () => {
  const summaries = new Map([
    ["seen", { node_id: "seen", snapshot_status: "fresh", drift_state: "unknown", managed: false, has_binding: false, collected_at: "2026-09-02T03:00:00Z" }],
    ["never", { node_id: "never", snapshot_status: "unknown", drift_state: "unknown", managed: false, has_binding: false }],
  ]);
  const details = new Map([
    ["seen", { node_id: "seen", collected_at: "2026-09-02T03:00:00Z", listeners: [{ protocol: "tcp", port: 58394, process: "sshd" }] }],
  ]);
  const seen = foldReality("seen", summaries, details);
  assert.equal(seen.status, "fresh");
  assert.equal(seen.collectedAt, "2026-09-02T03:00:00Z");
  assert.equal(seen.sshd?.text, ":58394 only");

  const never = foldReality("never", summaries, details);
  assert.equal(never.status, "unknown");
  assert.equal(never.collectedAt, undefined);
  assert.equal(never.sshd, undefined, "no detail means no claim about sshd");

  const absent = foldReality("not-in-feed", summaries, details);
  assert.equal(absent.status, "unknown");
});

test("details are re-read only when the summary says the snapshot moved", () => {
  const summaries = [
    { node_id: "same", snapshot_status: "fresh", drift_state: "unknown", managed: false, has_binding: false, collected_at: "t1" },
    { node_id: "moved", snapshot_status: "fresh", drift_state: "unknown", managed: false, has_binding: false, collected_at: "t2" },
    { node_id: "new", snapshot_status: "fresh", drift_state: "unknown", managed: false, has_binding: false, collected_at: "t1" },
    { node_id: "never", snapshot_status: "unknown", drift_state: "unknown", managed: false, has_binding: false },
  ];
  const cached = new Map([["same", "t1"], ["moved", "t1"]]);
  assert.deepEqual(realityDetailsToFetch(summaries, cached), ["moved", "new"]);
});

test("the newest observation across the fleet is the one the proof line states", () => {
  assert.equal(
    newestObservation([
      { node_id: "a", snapshot_status: "fresh", drift_state: "unknown", managed: false, has_binding: false, collected_at: "2026-09-02T03:00:00Z" },
      { node_id: "b", snapshot_status: "fresh", drift_state: "unknown", managed: false, has_binding: false, collected_at: "2026-09-02T03:05:00Z" },
      { node_id: "c", snapshot_status: "unknown", drift_state: "unknown", managed: false, has_binding: false },
    ]),
    "2026-09-02T03:05:00Z",
  );
  assert.equal(newestObservation([]), undefined);
});

// ── time ────────────────────────────────────────────────────────────────────

test("ages are short, floor at zero, and never carry decimals", () => {
  assert.equal(formatAge(43_000), "43s");
  assert.equal(formatAge(-5_000), "0s");
  assert.equal(formatAge(2 * 60_000 + 59_000), "2m");
  assert.equal(formatAge(3 * 3_600_000), "3h");
  assert.equal(formatAge(50 * 3_600_000), "2d");
});

test("countdowns read mm:ss, grow an hours field when needed, and stop at zero", () => {
  assert.equal(formatCountdown(7 * 60_000 + 41_000), "07:41");
  assert.equal(formatCountdown(3_723_000), "1:02:03");
  assert.equal(formatCountdown(-1), "00:00");
  assert.equal(formatCountdown(500), "00:01", "a fraction of a second still counts as one left");
});

// ── batch ───────────────────────────────────────────────────────────────────

test("the control-plane host is the node reporting the address the console was reached on", () => {
  const nodes = [
    { id: "cp", public_ip: "203.0.113.10" },
    { id: "v6", public_ipv6: "2001:db8::10" },
    { id: "other", public_ip: "198.51.100.7" },
  ];
  assert.deepEqual([...controlPlaneNodeIds(nodes, "203.0.113.10:8443")], ["cp"]);
  assert.deepEqual([...controlPlaneNodeIds(nodes, "[2001:db8::10]:8443")], ["v6"]);
  assert.deepEqual([...controlPlaneNodeIds(nodes, "2001:DB8::10")], ["v6"]);
  assert.deepEqual([...controlPlaneNodeIds(nodes, "lattice.example.org")], [], "a name no node reports matches nothing");
  assert.deepEqual([...controlPlaneNodeIds(nodes, "")], []);
});

test("the control-plane host may be armed alone, never as one member of a batch", () => {
  const cp = new Set(["cp"]);
  assert.equal(batchRefusal([], cp), "empty");
  assert.equal(batchRefusal(["cp"], cp), undefined);
  assert.equal(batchRefusal(["a", "b"], cp), undefined);
  assert.equal(batchRefusal(["a", "cp"], cp), "control_plane_in_batch");
});

test("a batch summary never hides a failed member behind the filed ones", () => {
  const members: BatchMember[] = [
    { nodeId: "a", name: "A", outcome: { kind: "filed", approvalId: "ap1", findings: [] } },
    { nodeId: "b", name: "B", outcome: { kind: "failed", error: "capability_denied" } },
    { nodeId: "c", name: "C", outcome: { kind: "blocked", findings: [{ code: "x", severity: "block", message: "" }] } },
    { nodeId: "d", name: "D" },
  ];
  assert.deepEqual(summarizeBatch(members), { filed: 1, blocked: 1, failed: 1, pending: 1 });
});

test("a retry re-files the blocked members and the untried ones, never a filed one", () => {
  const members: BatchMember[] = [
    { nodeId: "a", name: "A", outcome: { kind: "filed", approvalId: "ap1", findings: [] } },
    { nodeId: "b", name: "B", outcome: { kind: "failed", error: "boom" } },
    { nodeId: "c", name: "C", outcome: { kind: "blocked", findings: [] } },
    { nodeId: "d", name: "D" },
  ];
  assert.deepEqual(membersToFile(members, false).map((m) => m.nodeId), ["d"]);
  assert.deepEqual(membersToFile(members, true).map((m) => m.nodeId), ["c", "d"]);
});

test("fleet states feed the board without a name when the node has none", () => {
  const state: NodeGuardState | undefined = FLEET.find((s) => s.nodeId === "never");
  assert.equal(state?.name, "");
});
