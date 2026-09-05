import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildFleetStates, type NodeGuardState } from "../sshGuardModel.ts";
import {
  armCommitment,
  armHistory,
  batchRefusal,
  boardStage,
  installsFirewall,
  isPostureFilter,
  filterByPosture,
  knockGate,
  postureCounts,
  postureTone,
  revealAffordance,
  sshPosture,
  controlPlaneNodeIds,
  coverageBucket,
  coverageCounts,
  describeSshdNow,
  filterByCoverage,
  foldReality,
  formatAge,
  formatCountdown,
  isCoverageFilter,
  knockFingerprints,
  knockStatesToFetch,
  mergeKnockAnswers,
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
  type SshPosture,
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
  assert.equal(seen.password, undefined, "a detail without an sshd block makes no claim about passwords");
});

test("the fold reads PasswordAuthentication from the detail's sshd block and the stale moment from the summary", () => {
  const summaries = new Map([
    ["stale", { node_id: "stale", snapshot_status: "stale", drift_state: "unknown", managed: false, has_binding: false, collected_at: "2026-09-01T03:00:00Z", stale_after: "2026-09-02T09:00:00Z" }],
    ["fresh", { node_id: "fresh", snapshot_status: "fresh", drift_state: "unknown", managed: false, has_binding: false, collected_at: "2026-09-04T03:43:04Z", stale_after: "2026-09-05T09:43:04Z" }],
  ]);
  const sshd = { pubkey_authentication: true, permit_root_login: "without-password", ports: [22], observed_at: "2026-09-04T03:43:04Z" };
  const details = new Map([
    ["stale", { node_id: "stale", collected_at: "2026-09-01T03:00:00Z", sshd: { ...sshd, password_authentication: true, observed_at: "2026-09-01T03:00:00Z" } }],
    ["fresh", { node_id: "fresh", collected_at: "2026-09-04T03:43:04Z", sshd: { ...sshd, password_authentication: false } }],
    ["mute", { node_id: "mute", collected_at: "2026-09-04T03:43:04Z", sshd_note: "sshd -T exceeded 3s" }],
  ]);
  const fresh = foldReality("fresh", summaries, details);
  assert.deepEqual(fresh.password, { enabled: false, observedAt: "2026-09-04T03:43:04Z" });
  assert.equal(fresh.staleSince, "2026-09-05T09:43:04Z");
  const stale = foldReality("stale", summaries, details);
  assert.deepEqual(stale.password, { enabled: true, observedAt: "2026-09-01T03:00:00Z" });
  assert.equal(stale.status, "stale");
  assert.equal(stale.staleSince, "2026-09-02T09:00:00Z");
  const mute = foldReality("mute", summaries, details);
  assert.equal(mute.password, undefined);
  assert.equal(mute.sshdNote, "sshd -T exceeded 3s");
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

// The server's knock answer depends on every SSH Guard approval a node has,
// so the row is re-asked when any of them moves and never otherwise: the
// approvals poll every fifteen seconds and a fleet of thirty-three must not
// cost thirty-three requests each time.
test("a node is asked about its knock once, and again only when one of its approvals moves", () => {
  const before = [
    approval({ id: "old", node_id: "n1", status: "dismissed", updated_at: "2026-08-10T00:00:00Z" }),
    approval({ id: "new", node_id: "n1", status: "applied", updated_at: "2026-09-01T00:00:00Z" }),
    approval({ id: "x", node_id: "n2", status: "pending" }),
    approval({ id: "other", node_id: "n1", plugin: "nftpolicy", status: "pending" }),
  ];
  const prints = knockFingerprints(before);
  assert.equal(prints.has("n2"), true);
  // n3 has no approvals at all and is still asked once: "never planned" is
  // an answer the server states in its own words.
  const asked = new Map<string, string>();
  assert.deepEqual(knockStatesToFetch(["n1", "n2", "n3"], prints, asked), ["n1", "n2", "n3"]);
  for (const id of ["n1", "n2", "n3"]) asked.set(id, prints.get(id) ?? "");
  assert.deepEqual(knockStatesToFetch(["n1", "n2", "n3"], knockFingerprints(before), asked), []);

  // A cleanup retires the three-week-old arm without touching the newest row.
  const retired = before.map((a) => ((a as { id: string }).id === "old" ? { ...(a as object), stale_code: "sshguard_approval_superseded" } as never : a));
  assert.deepEqual(knockStatesToFetch(["n1", "n2", "n3"], knockFingerprints(retired), asked), ["n1"]);

  // Another plugin's approval moving on the same node is not a reason to ask.
  const unrelated = before.map((a) => ((a as { id: string }).id === "other" ? { ...(a as object), status: "applied" } as never : a));
  assert.deepEqual(knockStatesToFetch(["n1", "n2", "n3"], knockFingerprints(unrelated), asked), []);

  // Order of arrival does not change the print.
  assert.equal(knockFingerprints([...before].reverse()).get("n1"), prints.get("n1"));
});

// The approvals and the fleet arrive separately, so the first two knock
// passes overlap. Each folds its answers into the map as it stands when they
// land; a pass that started from a copy of an empty map would hand back only
// its own rows and drop the other pass's.
test("overlapping knock passes keep each other's rows, and a refusal clears one", () => {
  const asked = new Map([["n1", "a"], ["n2", "b"], ["n3", "c"]]);
  const first = mergeKnockAnswers(new Map(), new Map([["n1", { print: "a", answer: "installed" }]]), asked);
  const second = mergeKnockAnswers(first, new Map([["n2", { print: "b", answer: "planned" }]]), asked);
  assert.deepEqual([...second], [["n1", "installed"], ["n2", "planned"]]);
  const refused = mergeKnockAnswers(
    second,
    new Map([["n1", { print: "a", answer: undefined }], ["n3", { print: "c", answer: "unknown" }]]),
    asked,
  );
  assert.deepEqual([...refused], [["n2", "planned"], ["n3", "unknown"]]);
  // The map it was handed is not written to.
  assert.deepEqual([...second], [["n1", "installed"], ["n2", "planned"]]);
});

// One node hit by two passes in quick succession (an operator re-arms right
// after a rejection, or two approval polls land close together) has two
// requests in flight against different fingerprints. The record of what was
// asked already holds the newer print before either request leaves, so an
// answer that comes back against an older print is thrown away whichever
// order the two land in; the map never shows a retired answer that no poll
// would ever re-ask about.
test("a knock answer requested against a fingerprint the node has moved past is dropped", () => {
  const asked = new Map<string, string>();
  // Pass A asks n1 against print "a"; pass B asks it against "b" before A lands.
  asked.set("n1", "a");
  asked.set("n1", "b");
  // A's answer arrives last and must not overwrite B's.
  const afterB = mergeKnockAnswers(new Map(), new Map([["n1", { print: "b", answer: "installed" }]]), asked);
  const afterA = mergeKnockAnswers(afterB, new Map([["n1", { print: "a", answer: "installed_superseded" }]]), asked);
  assert.deepEqual([...afterA], [["n1", "installed"]]);
  // A's answer arriving first is not shown either, not even for a moment.
  const aFirst = mergeKnockAnswers(new Map(), new Map([["n1", { print: "a", answer: "installed_superseded" }]]), asked);
  assert.deepEqual([...aFirst], []);
  assert.deepEqual([...mergeKnockAnswers(aFirst, new Map([["n1", { print: "b", answer: "installed" }]]), asked)], [["n1", "installed"]]);
  // A stale refusal does not clear the fresh row.
  assert.deepEqual([...mergeKnockAnswers(afterB, new Map([["n1", { print: "a", answer: undefined }]]), asked)], [["n1", "installed"]]);
});

// ── posture ─────────────────────────────────────────────────────────────────

// The point of the board: a node that is key-only with password login off
// reads as secured whatever the last arm approval's disposition was. The
// server's word wins when it gives one; the detail's own sshd facts stand in
// for a server from before the field.
test("the posture badge follows the server's status row, then the node's own sshd facts, and never guesses", () => {
  const facts = (over: Record<string, unknown>) => ({
    sshd: { password_authentication: false, pubkey_authentication: true, permit_root_login: "without-password", ports: [22], observed_at: "2026-09-04T00:00:00Z", ...over },
  });
  const served = (state: string) => ({ posture: { state, key_access: true, reason: "" } }) as never;
  // Served by the server: read verbatim, whatever the facts say.
  assert.equal(sshPosture(served("secured"), facts({ password_authentication: true })), "secured");
  assert.equal(sshPosture(served("password_open"), undefined), "password_open");
  assert.equal(sshPosture(served("partial"), facts({})), "partial");
  assert.equal(sshPosture(served("unknown"), facts({})), "unknown");
  // A value outside the contract is not trusted; the facts decide instead.
  assert.equal(sshPosture(served("hardened"), facts({})), "secured");
  // No status row: the fleet's actual state on 2026-09-04 reads secured.
  assert.equal(sshPosture(undefined, facts({ permit_root_login: "without-password" })), "secured");
  assert.equal(sshPosture(undefined, facts({ permit_root_login: "prohibit-password" })), "secured");
  assert.equal(sshPosture(undefined, facts({ permit_root_login: "no" })), "secured");
  // Password on is open however root login is set.
  assert.equal(sshPosture(undefined, facts({ password_authentication: true })), "password_open");
  assert.equal(sshPosture(undefined, facts({ password_authentication: true, permit_root_login: "no" })), "password_open");
  // Root by password permitted, or no key path shown: partial, as the server reads it.
  assert.equal(sshPosture(undefined, facts({ permit_root_login: "yes" })), "partial");
  assert.equal(sshPosture(undefined, facts({ permit_root_login: "Yes " })), "partial");
  assert.equal(sshPosture(undefined, facts({ pubkey_authentication: false })), "partial");
  // Never reported, or an agent that predates the sshd block.
  assert.equal(sshPosture(undefined, undefined), "unknown");
  assert.equal(sshPosture(undefined, { sshd: undefined }), "unknown");
});

test("no posture maps to the destructive badge; secured is calm, password open and partial warn, unknown is muted", () => {
  assert.equal(postureTone("secured"), "secured");
  assert.equal(postureTone("password_open"), "warning");
  assert.equal(postureTone("partial"), "warning");
  assert.equal(postureTone("unknown"), "muted");
  assert.deepEqual(postureCounts(["secured", "secured", "password_open", "partial", "unknown"]), { secured: 2, password_open: 1, partial: 1, unknown: 1 });
  assert.deepEqual(postureCounts([]), { secured: 0, password_open: 0, partial: 0, unknown: 0 });
});

test("the knock gate is the status row's answer, then the knock state's, then the snapshot's own table list", () => {
  assert.equal(knockGate({ knock_gate: true }, { gate_present: false }, { foreign_tables: [] }), true);
  assert.equal(knockGate({ knock_gate: false }, { gate_present: true }, { foreign_tables: ["inet lattice_knock"] }), false);
  assert.equal(knockGate(undefined, { gate_present: true }, { foreign_tables: [] }), true);
  assert.equal(knockGate(undefined, { gate_present: false }, { foreign_tables: ["inet lattice_knock"] }), false);
  assert.equal(knockGate(undefined, {}, { foreign_tables: ["inet filter", "inet lattice_knock"] }), true);
  assert.equal(knockGate(undefined, undefined, { foreign_tables: ["INET Lattice_Knock "] }), true);
  assert.equal(knockGate(undefined, undefined, { foreign_tables: ["inet lattice_guard"] }), false);
  assert.equal(knockGate(undefined, undefined, undefined), false);
});

// A durable arm armed no timer: it reads as confirmed with its own history
// word, and never as a countdown that ends in "reverted". Unless the host
// found no key and armed the timer after all, which the server writes into
// the approval's reason; then it is an ordinary applied arm.
test("a durable arm is permanent history, not a revert countdown", () => {
  const plan = "stage: arm\nssh_port: 0\nknock: false\ndurable: true\nconfirm_window_sec: 900\n";
  const fleet = buildFleetStates(
    [
      approval({ id: "d1", node_id: "durable", status: "applied", plan }),
      approval({ id: "d2", node_id: "fellback", status: "applied", plan, reason: "revert timer armed after all: no authorized key was found on the host" }),
    ],
    [{ id: "durable" }, { id: "fellback" }],
  );
  const durable = fleet.find((s) => s.nodeId === "durable")!;
  assert.equal(durable.stage, "confirmed");
  assert.equal(durable.revertArmed, false);
  assert.equal(durable.durable, true);
  assert.deepEqual(armHistory(durable, LATER), { kind: "hardened" });
  assert.equal(boardStage(durable, LATER), "confirmed");
  const fellback = fleet.find((s) => s.nodeId === "fellback")!;
  assert.equal(fellback.stage, "awaitingConfirm");
  assert.equal(fellback.revertArmed, true);
  assert.equal(boardStage(fellback, LATER), "reverted");
});

// ── arm history: secondary, never the badge ─────────────────────────────────

test("the last arm's outcome is history under the badge, one kind per row", () => {
  const fleet = buildFleetStates(
    [
      approval({ id: "h1", node_id: "done", status: "applied", created_at: "2026-09-02T02:00:00Z" }),
      approval({ id: "h2", node_id: "done", action: "sshguard-confirm:v1", status: "applied", created_at: "2026-09-02T02:30:00Z" }),
      // Applied at 03:00 with the default window: reverts at 03:15.
      approval({ id: "h3", node_id: "closed", status: "applied" }),
      approval({ id: "h4", node_id: "pending", status: "pending" }),
      approval({ id: "h5", node_id: "failed", status: "rejected", approved_by: "cdcd", reason: "step 3/6\nnft: Operation not supported" }),
      approval({ id: "h6", node_id: "rejected", status: "rejected", reason: "Move sshd", rejected_by: "user_ops", rejected_at: "2026-08-12T09:00:00Z" }),
      approval({ id: "h7", node_id: "refused", status: "rejected", reason: "Move sshd", updated_at: "2026-08-12T09:00:00Z" }),
      approval({ id: "h8", node_id: "superseded", status: "dismissed", stale_code: "sshguard_approval_superseded", reason: "superseded", updated_at: "2026-08-30T00:00:00Z" }),
      approval({ id: "h9", node_id: "noreason", status: "rejected", approved_by: "cdcd", reason: "  " }),
    ],
    [{ id: "done" }, { id: "closed" }, { id: "pending" }, { id: "failed" }, { id: "rejected" }, { id: "refused" }, { id: "superseded" }, { id: "noreason" }, { id: "idle" }],
  );
  const by = (id: string) => fleet.find((s) => s.nodeId === id)!;
  assert.deepEqual(armHistory(by("idle"), LATER), { kind: "none" });
  assert.deepEqual(armHistory(by("done"), LATER), { kind: "done" });
  // Past the window the row reads reverted, with the moment the box undid it.
  assert.deepEqual(armHistory(by("closed"), LATER), { kind: "reverted", at: Date.parse("2026-09-02T03:15:00Z") });
  // Inside the window the same node is live and keeps its stage word.
  assert.deepEqual(armHistory(by("closed"), NOW), { kind: "live", stage: "awaitingConfirm" });
  assert.deepEqual(armHistory(by("pending"), LATER), { kind: "live", stage: "armPending" });
  // The failed arm carries the line the task died on and the full text.
  assert.deepEqual(armHistory(by("failed"), LATER), { kind: "failed", line: "nft: Operation not supported", full: "step 3/6\nnft: Operation not supported" });
  // A rejection an operator made in August, with and without a recorded actor.
  assert.deepEqual(armHistory(by("rejected"), LATER), { kind: "rejected", at: "2026-08-12T09:00:00Z", by: "user_ops" });
  assert.deepEqual(armHistory(by("refused"), LATER), { kind: "rejected", at: "2026-08-12T09:00:00Z" });
  assert.deepEqual(armHistory(by("superseded"), LATER), { kind: "superseded", at: "2026-08-30T00:00:00Z" });
  assert.deepEqual(armHistory(by("noreason"), LATER), { kind: "failedNoReason" });
});

// ── the reveal affordance ───────────────────────────────────────────────────

test("every node with a knock gate offers the reveal; the icon stays for a sequence held without a gate", () => {
  assert.equal(revealAffordance(true, "installed"), "reveal");
  assert.equal(revealAffordance(true, "installed_superseded"), "reveal");
  // Gated but the control plane holds nothing: the dialog says so in words.
  assert.equal(revealAffordance(true, "unknown"), "reveal");
  assert.equal(revealAffordance(true, "no_knock"), "reveal");
  assert.equal(revealAffordance(true, "planned"), "reveal");
  assert.equal(revealAffordance(false, "installed"), "icon");
  assert.equal(revealAffordance(false, "installed_superseded"), "icon");
  assert.equal(revealAffordance(false, "planned"), "none");
  assert.equal(revealAffordance(false, "no_knock"), "none");
  assert.equal(revealAffordance(false, "unknown"), "none");
});

// ── what the arm commits the operator to ────────────────────────────────────

test("a management source or a knock installs the firewall, and the firewall always keeps the confirm window", () => {
  assert.equal(installsFirewall({ enableKnock: false, mgmtSources: "" }), false);
  assert.equal(installsFirewall({ enableKnock: false, mgmtSources: " , " }), false);
  assert.equal(installsFirewall({ enableKnock: true, mgmtSources: "" }), true);
  assert.equal(installsFirewall({ enableKnock: false, mgmtSources: "203.0.113.5" }), true);
  // An invalid source alone installs nothing: the server would refuse it anyway.
  assert.equal(installsFirewall({ enableKnock: false, mgmtSources: "not-an-address" }), false);
  const attested = [{ nodeId: "a", keyAccess: true }];
  assert.deepEqual(armCommitment({ enableKnock: true, mgmtSources: "", confirmWindowSec: 0 }, attested), { kind: "firewall", firewall: true, windowSec: 900, unattested: [] });
  assert.deepEqual(armCommitment({ enableKnock: false, mgmtSources: "198.51.100.0/24", confirmWindowSec: 600 }, attested), { kind: "firewall", firewall: true, windowSec: 600, unattested: [] });
});

// ── the three findings closed on this branch ────────────────────────────────

test("the arm sheet claims durable only when the server attested a key path on every member", () => {
  const hardening = { enableKnock: false, mgmtSources: "", confirmWindowSec: 300 };
  // A server from before the status endpoint attests nothing: the sheet keeps
  // the confirm instruction and the window, because that server arms the
  // revert timer before the first change on every arm.
  assert.equal(armCommitment(hardening, []).kind, "hardening");
  assert.equal(armCommitment(hardening, [{ nodeId: "a", keyAccess: undefined }]).kind, "hardening");
  assert.deepEqual(armCommitment(hardening, [{ nodeId: "a", keyAccess: undefined }]).unattested, ["a"]);
  // One member without the attestation makes the whole batch a confirm case:
  // the sheet must not promise "nothing to confirm" for a node that will revert.
  const mixed = armCommitment(hardening, [{ nodeId: "a", keyAccess: true }, { nodeId: "b", keyAccess: false }]);
  assert.equal(mixed.kind, "hardening");
  assert.deepEqual(mixed.unattested, ["b"]);
  // Every member attested and no firewall: the plan will carry durable: true.
  const durable = armCommitment(hardening, [{ nodeId: "a", keyAccess: true }, { nodeId: "b", keyAccess: true }]);
  assert.equal(durable.kind, "durable");
  assert.deepEqual(durable.unattested, []);
  assert.equal(durable.windowSec, 300);
  // A firewall keeps the confirm-or-revert path whatever the server attests.
  const knock = armCommitment({ enableKnock: true, mgmtSources: "", confirmWindowSec: 0 }, [{ nodeId: "a", keyAccess: true }]);
  assert.equal(knock.kind, "firewall");
  assert.equal(knock.firewall, true);
  assert.equal(knock.windowSec, 900);
  assert.equal(durable.firewall, false);
});

test("a posture filter from the address bar is accepted only when it names a posture chip", () => {
  assert.equal(isPostureFilter("password_open"), true);
  assert.equal(isPostureFilter("all"), true);
  assert.equal(isPostureFilter("failed"), false);
  assert.equal(isPostureFilter(undefined), false);
});

const POSTURES: Record<string, SshPosture> = { broken: "password_open", never: "password_open", planned: "partial", "left-out": "unknown" };
const postureOf = (id: string): SshPosture => POSTURES[id] ?? "secured";

test("filtering by posture answers the board's real question: which nodes are not secure", () => {
  assert.deepEqual(filterByPosture(FLEET, "password_open", postureOf).map((s) => s.nodeId).sort(), ["broken", "never"]);
  assert.deepEqual(filterByPosture(FLEET, "partial", postureOf).map((s) => s.nodeId), ["planned"]);
  assert.deepEqual(filterByPosture(FLEET, "unknown", postureOf).map((s) => s.nodeId), ["left-out"]);
  assert.deepEqual(filterByPosture(FLEET, "secured", postureOf).map((s) => s.nodeId).sort(), ["broken-excluded", "done", "reverting"]);
  assert.equal(filterByPosture(FLEET, "all", postureOf).length, FLEET.length);
});

test("the finding leads the table: posture ranks first, the arm stage breaks the tie", () => {
  // Password open first, then partial, then not reported, then the calm green
  // rows in their stage order. A secured node whose arm reverted or was
  // refused sits with the secured, not above the one password-open node.
  assert.deepEqual(
    orderForBoard(FLEET, LATER, postureOf).map((s) => s.nodeId),
    ["broken", "never", "planned", "left-out", "broken-excluded", "reverting", "done"],
  );
  // Without a posture lookup the order is the stage order it always was.
  assert.deepEqual(orderForBoard(FLEET, LATER).map((s) => s.nodeId), ["planned", "broken", "broken-excluded", "reverting", "left-out", "never", "done"]);
});

test("the board writes status as ink, never as the fill token: the light-scheme fills fail 4.5:1 as text", () => {
  // app.css: --success measures 3.4:1 and --warning 2.5:1 as text on the light
  // card; --success-text and --warning-text are the ink step (5.6:1). A badge
  // or a status line that takes the fill as its text colour is unreadable in
  // light theme, and the harness renders dark by default, so this is checked
  // at the source rather than trusted to the eye.
  const source = readFileSync(new URL("../SshGuardView.vue", import.meta.url), "utf8");
  const fillAsText = [...source.matchAll(/\btext-(success|warning|info)(?![-\w/])/g)].map((m) => m[0]);
  assert.deepEqual(fillAsText, []);
  const theme = readFileSync(new URL("../../../style/app.css", import.meta.url), "utf8");
  for (const name of ["success", "warning", "info"]) {
    assert.match(theme, new RegExp(`--color-${name}-text:\\s*var\\(--${name}-text\\)`), `${name}-text is not a Tailwind colour`);
  }
});
