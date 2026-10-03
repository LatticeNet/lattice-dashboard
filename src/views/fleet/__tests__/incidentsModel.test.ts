import assert from "node:assert/strict";
import { test } from "node:test";

import type { Incident, MaintenanceWindow } from "@/lib/api/types";
import {
  compareIncidents,
  draftFromWindow,
  endWindowInput,
  filterCounts,
  fromLocalInput,
  homeIncidents,
  incidentActions,
  incidentAge,
  incidentTone,
  kindsPresent,
  listedWindows,
  newWindowDraft,
  parseIncidentFilter,
  phoneState,
  toLocalInput,
  visibleIncidents,
  windowCoverage,
  windowDraftErrors,
  windowDraftInput,
  windowPhase,
} from "../incidentsModel.ts";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min: number) => new Date(NOW + min * 60_000).toISOString();

function incident(over: Partial<Incident>): Incident {
  return { id: over.id ?? "inc_1", key: "k", kind: "service.down", severity: "critical", state: "open", ...over };
}

const INCIDENTS: Incident[] = [
  incident({ id: "warn", kind: "node.offline", severity: "warning", since: ago(40), node_id: "n2", subject: "bwg-la" }),
  incident({ id: "crit-new", since: ago(5), node_id: "n1", subject: "DMIT-4" }),
  incident({ id: "crit-old", since: ago(50), node_id: "n3", subject: "vultr-sg" }),
  incident({ id: "acked", state: "acknowledged", since: ago(90), node_id: "n4", subject: "hz-fsn" }),
  incident({ id: "snoozed", snoozed_until: ahead(20), since: ago(30), node_id: "n5", subject: "do-nyc" }),
  incident({ id: "pending:node.offline/n6", state: "pending", kind: "node.offline", severity: "warning", node_id: "n6", subject: "mac-air", opens_at: ahead(4) }),
  incident({ id: "done-old", state: "resolved", resolved_at: ago(300), node_id: "n7" }),
  incident({ id: "done-new", state: "resolved", resolved_at: ago(10), node_id: "n8", kind: "monitor.down", subject: "web on DMIT-4" }),
];

test("the list is worst first: unhandled open critical oldest first, then warnings, then handled, pending, resolved newest first", () => {
  const order = [...INCIDENTS].sort((a, b) => compareIncidents(a, b, NOW)).map((i) => i.id);
  assert.deepEqual(order, ["crit-old", "crit-new", "warn", "acked", "snoozed", "pending:node.offline/n6", "done-new", "done-old"]);
  // A window holding a critical incident's message ranks it with the handled ones, below an open warning.
  const held = incident({ id: "held", since: ago(60), maintenance: "kernel upgrade" });
  const warn = incident({ id: "warn", severity: "warning", since: ago(5) });
  assert.deepEqual([held, warn].sort((a, b) => compareIncidents(a, b, NOW)).map((i) => i.id), ["warn", "held"]);
  // A snooze that ran out is unhandled again.
  const lapsed = incident({ id: "lapsed", snoozed_until: ago(1), since: ago(70) });
  assert.deepEqual([warn, lapsed].sort((a, b) => compareIncidents(a, b, NOW)).map((i) => i.id), ["lapsed", "warn"]);
});

test("filters split open from snoozed, and active covers open, acknowledged and pending", () => {
  const counts = filterCounts(INCIDENTS, NOW);
  assert.equal(counts.active, 6);
  assert.equal(counts.open, 3);
  assert.equal(counts.snoozed, 1);
  assert.equal(counts.acknowledged, 1);
  assert.equal(counts.pending, 1);
  assert.equal(counts.resolved, 2);
  assert.equal(counts.all, 8);
  // A snooze that ran out is open again.
  assert.equal(filterCounts([incident({ snoozed_until: ago(1) })], NOW).open, 1);
  assert.equal(parseIncidentFilter("nonsense"), "active");
  assert.equal(parseIncidentFilter("resolved"), "resolved");
});

test("search matches subject, node and kind, and the kind filter narrows", () => {
  const rows = visibleIncidents(INCIDENTS, { filter: "all", kind: "", search: "dmit" }, NOW);
  assert.deepEqual(rows.map((i) => i.id), ["crit-new", "done-new"]);
  const monitors = visibleIncidents(INCIDENTS, { filter: "all", kind: "monitor.down", search: "" }, NOW);
  assert.deepEqual(monitors.map((i) => i.id), ["done-new"]);
  assert.deepEqual(kindsPresent([...INCIDENTS, incident({ kind: "line.down" })]), ["node.offline", "service.down", "monitor.down", "line.down"]);
});

test("tone: open critical is red, open warning amber, anything someone is handling goes quiet", () => {
  assert.equal(incidentTone(INCIDENTS[1]!, NOW), "danger");
  assert.equal(incidentTone(INCIDENTS[0]!, NOW), "warning");
  assert.equal(incidentTone(INCIDENTS[3]!, NOW), "muted");
  assert.equal(incidentTone(INCIDENTS[4]!, NOW), "muted");
  assert.equal(incidentTone(incident({ maintenance: "kernel upgrade" }), NOW), "muted");
  assert.equal(incidentTone(INCIDENTS[5]!, NOW), "info");
  assert.equal(incidentTone(INCIDENTS[6]!, NOW), "muted");
});

test("the phone line says what was sent, what is owed and why a message is held", () => {
  assert.deepEqual(phoneState(incident({ owed_open: true, maintenance: "kernel upgrade" }), NOW), { key: "held", reason: "maintenance", window: "kernel upgrade" });
  assert.deepEqual(phoneState(incident({ owed_open: true, snoozed_until: ahead(20) }), NOW), { key: "held", reason: "snoozed", until: NOW + 20 * 60_000 });
  assert.deepEqual(phoneState(incident({ owed_open: true, flapping: true, suppressed: "flapping (3 reopenings)" }), NOW), { key: "held", reason: "flapping" });
  assert.deepEqual(phoneState(incident({ owed_open: true }), NOW), { key: "owed" });
  assert.deepEqual(phoneState(incident({ notified: "open", open_notified_at: ago(12) }), NOW), {
    key: "paged",
    at: NOW - 12 * 60_000,
    escalatedAt: undefined,
    unacknowledged: true,
    noEscalate: false,
  });
  const escalated = phoneState(incident({ notified: "open", open_notified_at: ago(40), escalated: { r2: ago(5), r1: ago(10) } }), NOW);
  assert.equal(escalated.key === "paged" && escalated.escalatedAt, NOW - 10 * 60_000);
  assert.deepEqual(phoneState(incident({ state: "resolved", notified: "resolved", notified_at: ago(2) }), NOW), { key: "recovered", at: NOW - 2 * 60_000 });
  assert.deepEqual(phoneState(incident({ state: "resolved", owed_recovery: true }), NOW), { key: "recoveryOwed" });
  assert.deepEqual(phoneState(incident({ state: "resolved", owed_recovery: true, flapping: true }), NOW), { key: "recoveryHeld" });
  assert.deepEqual(phoneState(incident({ state: "resolved" }), NOW), { key: "silent" });
  assert.deepEqual(phoneState(INCIDENTS[5]!, NOW), { key: "pending", opensAt: NOW + 4 * 60_000 });
});

test("actions follow the state and the operator's scope", () => {
  assert.deepEqual(incidentActions(incident({}), NOW, true), { ack: true, snooze: true, unsnooze: false });
  assert.deepEqual(incidentActions(incident({ state: "acknowledged" }), NOW, true), { ack: false, snooze: true, unsnooze: false });
  assert.deepEqual(incidentActions(incident({ snoozed_until: ahead(5) }), NOW, true), { ack: true, snooze: true, unsnooze: true });
  assert.deepEqual(incidentActions(incident({}), NOW, false), { ack: false, snooze: false, unsnooze: false });
  assert.deepEqual(incidentActions(INCIDENTS[5]!, NOW, true), { ack: false, snooze: false, unsnooze: false });
  assert.deepEqual(incidentActions(INCIDENTS[6]!, NOW, true), { ack: false, snooze: false, unsnooze: false });
});

test("age runs from the condition's start and stops at resolution; the server's zero time is never", () => {
  assert.equal(incidentAge(incident({ since: ago(30) }), NOW), 30 * 60_000);
  assert.equal(incidentAge(incident({ state: "resolved", since: ago(30), resolved_at: ago(10) }), NOW), 20 * 60_000);
  assert.equal(incidentAge(incident({ since: "0001-01-01T00:00:00Z" }), NOW), undefined);
});

test("home shows the active incidents worst first and names the kinds it shows per node", () => {
  const home = homeIncidents(INCIDENTS, NOW, 3);
  assert.deepEqual(home.shown.map((i) => i.id), ["crit-old", "crit-new", "warn"]);
  assert.equal(home.more, 2);
  assert.equal(home.total, 5);
  // Only the three shown: the acknowledged and snoozed ones past the cap keep their nodes' rows.
  assert.deepEqual([...home.nodeKinds.entries()].map(([id, kinds]) => [id, [...kinds]]).sort(), [["n1", ["service.down"]], ["n2", ["node.offline"]], ["n3", ["service.down"]]]);
});

const WINDOW: MaintenanceWindow = {
  id: "mw_1",
  name: "kernel upgrade",
  node_ids: ["n1", "gone"],
  group_ids: ["grp_edge"],
  starts_at: ago(30),
  ends_at: ahead(30),
  created_at: ago(40),
  updated_at: ago(40),
};

test("windows: phase, the listed order and what each covers by name", () => {
  assert.equal(windowPhase(WINDOW, NOW), "active");
  assert.equal(windowPhase({ starts_at: ahead(10), ends_at: ahead(70) }, NOW), "upcoming");
  assert.equal(windowPhase({ starts_at: ago(70), ends_at: ago(10) }, NOW), "ended");
  const listed = listedWindows(
    [
      { ...WINDOW, id: "later", starts_at: ahead(60), ends_at: ahead(120) },
      { ...WINDOW, id: "ended", starts_at: ago(90), ends_at: ago(1) },
      { ...WINDOW, id: "soon", starts_at: ahead(10), ends_at: ahead(20) },
      WINDOW,
    ],
    NOW,
  );
  assert.deepEqual(listed.map((w) => w.id), ["mw_1", "soon", "later"]);
  const coverage = windowCoverage(WINDOW, new Map([["n1", "DMIT-4"]]), new Map([["grp_edge", "edge"]]));
  assert.deepEqual(coverage, { nodes: ["DMIT-4", "gone"], groups: ["edge"] });
});

test("the window editor follows the server's rules and leaves starts_at out of a window that starts now", () => {
  const draft = newWindowDraft(NOW, "n1");
  assert.deepEqual(windowDraftErrors(draft, NOW), ["name"]);
  draft.name = "  reboot  ";
  assert.deepEqual(windowDraftErrors(draft, NOW), []);
  const input = windowDraftInput(draft);
  assert.equal(input.name, "reboot");
  assert.equal(input.starts_at, undefined);
  assert.equal(input.ends_at, new Date(fromLocalInput(draft.endsAt)).toISOString());

  assert.deepEqual(windowDraftErrors({ ...draft, nodeIds: [] }, NOW), ["target"]);
  assert.deepEqual(windowDraftErrors({ ...draft, endsAt: toLocalInput(NOW - 60_000) }, NOW), ["endBeforeStart", "endPast"]);
  assert.deepEqual(windowDraftErrors({ ...draft, endsAt: toLocalInput(NOW + 31 * 86_400_000) }, NOW), ["tooLong"]);
  assert.deepEqual(windowDraftErrors({ ...draft, start: "at", startsAt: "soon" }, NOW), ["start"]);
  assert.deepEqual(windowDraftErrors({ ...draft, name: "x".repeat(121) }, NOW), ["nameLong"]);

  const edit = draftFromWindow(WINDOW);
  assert.equal(edit.start, "at");
  assert.deepEqual(windowDraftErrors(edit, NOW), []);
  assert.ok(windowDraftInput(edit).starts_at);
  const ended = endWindowInput(WINDOW, NOW);
  assert.equal(ended.ends_at, new Date(NOW).toISOString());
  assert.equal(ended.starts_at, WINDOW.starts_at);
});

test("datetime-local values round trip through the browser's zone", () => {
  const at = Date.parse("2026-10-03T09:45:00Z");
  assert.equal(fromLocalInput(toLocalInput(at)), at);
  assert.ok(Number.isNaN(fromLocalInput("2026-10-03 09:45")));
});
