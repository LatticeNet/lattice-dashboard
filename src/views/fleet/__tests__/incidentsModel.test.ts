import assert from "node:assert/strict";
import { test } from "node:test";

import type { Incident, MaintenanceWindow } from "@/lib/api/types";
import {
  arrivals,
  compareIncidents,
  splitArrivals,
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
  quietMonitorIds,
  releasedAndPaged,
  toLocalInput,
  visibleIncidents,
  windowCoverage,
  windowDraftErrors,
  windowDraftInput,
  windowHeldIncidents,
  windowInput,
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

test("filters split open from snoozed, and active is open and acknowledged; pending is not an incident yet", () => {
  const counts = filterCounts(INCIDENTS, NOW);
  assert.equal(counts.active, 5);
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
  // A pinned row stays under a state filter it no longer matches.
  const acked = { ...INCIDENTS[1]!, state: "acknowledged" as const };
  const open = visibleIncidents([acked, INCIDENTS[2]!], { filter: "open", kind: "", search: "" }, NOW);
  assert.deepEqual(open.map((i) => i.id), ["crit-old"]);
  const pinned = visibleIncidents([acked, INCIDENTS[2]!], { filter: "open", kind: "", search: "" }, NOW, ["crit-new", "crit-old"], new Set(["crit-new"]));
  assert.deepEqual(pinned.map((i) => i.id), ["crit-new", "crit-old"]);
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
  // Held before, nothing holding it now: the window ended (or another hold lifted) and the next check sends it.
  const windowHold = `held by maintenance window "kernel upgrade" until ${ahead(10)}`;
  assert.deepEqual(phoneState(incident({ owed_open: true, suppressed: windowHold, suppressed_at: ago(7) }), NOW), { key: "released", by: "window" });
  assert.deepEqual(phoneState(incident({ owed_open: true, suppressed: `snoozed until ${ago(1)}`, suppressed_at: ago(7) }), NOW), { key: "released", by: "hold" });
  // While the window still covers the node, it is held by that window.
  assert.deepEqual(phoneState(incident({ owed_open: true, suppressed: windowHold, suppressed_at: ago(7), maintenance: "kernel upgrade" }), NOW), { key: "held", reason: "maintenance", window: "kernel upgrade" });
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

test("a monitor is quiet only when every live incident of it is pending or being handled", () => {
  const down = (id: string, monitor: string, over: Partial<Incident>) => incident({ id, kind: "monitor.down", severity: "warning", monitor_id: monitor, ...over });
  const quiet = quietMonitorIds(
    [
      down("a1", "mon_snoozed", { snoozed_until: ahead(30) }),
      down("b1", "mon_mixed", { state: "acknowledged" }),
      down("b2", "mon_mixed", {}),
      down("c1", "mon_pending", { state: "pending" }),
      down("d1", "mon_held", { maintenance: "kernel upgrade" }),
      down("e1", "mon_done", { state: "resolved" }),
    ],
    NOW,
  );
  assert.deepEqual([...quiet].sort(), ["mon_held", "mon_pending", "mon_snoozed"]);
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
  // Home and the Incidents layer count the same set.
  assert.equal(home.total, filterCounts(INCIDENTS, NOW).active);
  // The pending one is listed for its node, with when it opens.
  assert.deepEqual([...home.pendingNodes.entries()].map(([id, kinds]) => [id, [...kinds.entries()]]), [["n6", [["node.offline", NOW + 4 * 60_000]]]]);
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
      { ...WINDOW, id: "yesterday", starts_at: ago(31 * 60), ends_at: ago(30 * 60) },
      { ...WINDOW, id: "ended-earlier", starts_at: ago(90), ends_at: ago(20) },
      WINDOW,
    ],
    NOW,
  );
  // Windows that ended today stay listed (latest first) so they can be extended; older ones drop.
  assert.deepEqual(listed.map((w) => w.id), ["mw_1", "soon", "later", "ended", "ended-earlier"]);
  const coverage = windowCoverage(WINDOW, new Map([["n1", "DMIT-4"]]), new Map([["grp_edge", "edge"]]));
  assert.deepEqual(coverage, { nodes: ["DMIT-4", "gone"], groups: ["edge"] });
});

test("ending a window names what it releases, and Undo sends the window back as it was", () => {
  const held = [
    incident({ id: "held", maintenance_id: "mw_1", owed_open: true }),
    incident({ id: "paged", maintenance_id: "mw_1", notified: "open" }),
    incident({ id: "acked", maintenance_id: "mw_1", state: "acknowledged", owed_open: true }),
    incident({ id: "other", maintenance_id: "mw_2", owed_open: true }),
  ];
  assert.deepEqual(windowHeldIncidents(held, WINDOW, NOW).map((i) => i.id), ["held"]);
  // Something else still holds it: a snooze, flapping, or another active window over its node (by id or group).
  const stillHeld = [
    incident({ id: "snoozed", maintenance_id: "mw_1", owed_open: true, snoozed_until: ahead(30) }),
    incident({ id: "flapping", maintenance_id: "mw_1", owed_open: true, flapping: true }),
    incident({ id: "other-window", maintenance_id: "mw_1", owed_open: true, node_id: "n9" }),
    incident({ id: "other-group", maintenance_id: "mw_1", owed_open: true, node_id: "n8" }),
    incident({ id: "released", maintenance_id: "mw_1", owed_open: true, node_id: "n7" }),
  ];
  const disk = { ...WINDOW, id: "mw_disk", node_ids: ["n9"], group_ids: ["grp_eu"] };
  const later = { ...WINDOW, id: "mw_later", node_ids: ["n7"], starts_at: ahead(60), ends_at: ahead(120) };
  assert.deepEqual(windowHeldIncidents(stillHeld, WINDOW, NOW, [WINDOW, disk, later], new Map([["grp_eu", ["n8"]]])).map((i) => i.id), ["released"]);
  // Undo cannot take back a message the sweep already sent: the restore names those.
  const afterSweep = [
    incident({ id: "paged", notified: "open", open_notified_at: ago(0) }),
    incident({ id: "still-owed", owed_open: true }),
    incident({ id: "never-held", notified: "open" }),
  ];
  assert.deepEqual(releasedAndPaged(afterSweep, ["paged", "still-owed"]).map((i) => i.id), ["paged"]);
  const ended = endWindowInput(WINDOW, NOW);
  assert.equal(ended.ends_at, new Date(NOW).toISOString());
  assert.deepEqual(windowInput(WINDOW), { ...ended, ends_at: WINDOW.ends_at });
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

describeArrivals();

function describeArrivals(): void {
  const crit = (id: string, over: Partial<Incident> = {}) => incident({ id, severity: "critical", state: "open", since: ago(30), ...over });
  const warn = (id: string, over: Partial<Incident> = {}) => incident({ id, kind: "agent.stalled", severity: "warning", state: "open", since: ago(30), ...over });
  const ids = (rows: readonly Incident[]) => rows.map((row) => row.id);
  const asWas = (...rows: Incident[]) => new Map(rows.map((row) => [row.id, row]));

  test("arrivals: nothing while no order is held", () => {
    assert.deepEqual(arrivals([warn("w"), crit("c")], { order: null }, NOW), []);
  });

  test("arrivals: a critical that arrived during the hold, held below a warning, is named", () => {
    // Rows held as [dmit4, stall]; the new critical goes after them.
    const shown = [crit("dmit4"), warn("stall"), crit("new", { since: ago(1) })];
    assert.deepEqual(ids(arrivals(shown, { order: ["dmit4", "stall"] }, NOW)), ["new"]);
    assert.deepEqual(ids(arrivals(shown, { order: ["dmit4", "stall"], before: asWas(crit("dmit4"), warn("stall")) }, NOW)), ["new"]);
  });

  test("arrivals: an arrival that belongs at the bottom anyway is not news", () => {
    assert.deepEqual(arrivals([crit("dmit4"), warn("late")], { order: ["dmit4"] }, NOW), []);
  });

  test("arrivals: rows acted on are left out, so an acknowledged row kept on top does not flag the rows below it", () => {
    const shown = [crit("acked", { state: "acknowledged" }), crit("bandwagon"), warn("stall")];
    const held = { order: ["acked", "bandwagon", "stall"], pinned: new Set(["acked"]), before: asWas(crit("acked"), crit("bandwagon"), warn("stall")) };
    assert.deepEqual(arrivals(shown, held, NOW), []);
    assert.deepEqual(ids(arrivals([...shown, crit("new", { since: ago(1) })], held, NOW)), ["new"]);
  });

  test("arrivals: a row that reopened during the hold counts as arrived though the held order knows it", () => {
    // Under All, the resolved row was shown at the bottom when the hold began.
    const was = asWas(crit("dmit4"), warn("stall"), incident({ id: "mac", state: "resolved", resolved_at: ago(5) }));
    const shown = [crit("dmit4"), warn("stall"), crit("mac", { since: ago(1) })];
    assert.deepEqual(ids(arrivals(shown, { order: ["dmit4", "stall", "mac"], before: was }, NOW)), ["mac"]);
    const still = [crit("dmit4"), warn("stall"), incident({ id: "mac", state: "resolved", resolved_at: ago(5) })];
    assert.deepEqual(arrivals(still, { order: ["dmit4", "stall", "mac"], before: was }, NOW), []);
  });

  test("arrivals: a row another operator acknowledged sinks; nothing below it is flagged", () => {
    const shown = [crit("a", { state: "acknowledged" }), crit("b")];
    assert.deepEqual(arrivals(shown, { order: ["a", "b"], before: asWas(crit("a"), crit("b")) }, NOW), []);
  });

  test("arrivals: a row filtered out when the hold began (it was pending) counts once it opens", () => {
    // Under Active the pending row was not shown, so the held order does not have it; it was known, though.
    const was = asWas(crit("dmit4"), warn("stall"), crit("cloudcone", { state: "pending" }));
    const shown = [crit("dmit4"), warn("stall"), crit("cloudcone", { since: ago(1) })];
    assert.deepEqual(ids(arrivals(shown, { order: ["dmit4", "stall"], before: was }, NOW)), ["cloudcone"]);
  });

  test("arrivals: several are returned worst first", () => {
    const shown = [crit("dmit4"), warn("stall"), warn("w2", { since: ago(2) }), crit("c2", { since: ago(1) })];
    assert.deepEqual(ids(arrivals(shown, { order: ["dmit4", "stall"] }, NOW)), ["c2"]);
    const both = [crit("dmit4", { state: "acknowledged" }), warn("stall"), crit("c3", { since: ago(3) }), crit("c2", { since: ago(1) })];
    assert.deepEqual(ids(arrivals(both, { order: ["dmit4", "stall"], pinned: new Set(["dmit4"]) }, NOW)), ["c3", "c2"]);
  });

  test("arrivals: a reopened critical that another operator then acknowledged is not counted", () => {
    const was = asWas(crit("dmit4"), warn("stall"), incident({ id: "mac", state: "resolved", resolved_at: ago(5) }));
    const reopened = crit("mac", { since: ago(1) });
    const order = ["dmit4", "stall"];
    assert.deepEqual(ids(arrivals([crit("dmit4"), warn("stall"), reopened], { order, before: was }, NOW)), ["mac"]);
    const ackedByAlice = { ...reopened, state: "acknowledged" as const, acked_by: "alice", acked_at: ago(0) };
    // Under All it would still sort above a resolved row shown before it; it is still not news.
    const under = [crit("dmit4"), warn("stall"), incident({ id: "old", state: "resolved", resolved_at: ago(50) }), ackedByAlice];
    assert.deepEqual(arrivals(under, { order: [...order, "old"], before: was }, NOW), []);
  });

  test("splitArrivals: new for incidents that did not exist, were resolved or pending; moved up for ones already open", () => {
    const was = asWas(warn("snoozed", { snoozed: true, snoozed_until: ahead(30) }), incident({ id: "mac", state: "resolved", resolved_at: ago(5) }), crit("cloudcone", { state: "pending" }));
    const arrived = [crit("brand-new"), crit("mac"), crit("cloudcone"), warn("snoozed")];
    const { fresh, moved } = splitArrivals(arrived, was);
    assert.deepEqual(ids(fresh), ["brand-new", "mac", "cloudcone"]);
    assert.deepEqual(ids(moved), ["snoozed"]);
    assert.deepEqual(ids(splitArrivals(arrived, null).fresh), ids(arrived), "without a snapshot every arrival is new");
  });

  test("arrivals: an incident whose snooze ended moves up past a warning shown before it", () => {
    const was = asWas(crit("dmit4"), warn("stall"), warn("hk", { snoozed: true, snoozed_until: ago(-30) }));
    // The snooze ended: the monitor failure is open again and belongs above the stall it was shown under.
    const shown = [crit("dmit4"), warn("stall", { since: ago(5) }), warn("hk", { since: ago(40) })];
    const arrived = arrivals(shown, { order: ["dmit4", "stall", "hk"], before: was }, NOW);
    assert.deepEqual(ids(arrived), ["hk"]);
    assert.deepEqual(ids(splitArrivals(arrived, was).moved), ["hk"]);
  });

  test("homeIncidents: a critical that arrives while an acknowledged row keeps its slot is missing from the three, and named", () => {
    // Before: DMIT-4, bandwagon and DMIT-1 shown, the stall fourth. DMIT-4 is acknowledged and pinned.
    const was = asWas(crit("dmit4"), crit("bandwagon"), crit("dmit1"), warn("stall"), incident({ id: "mac", state: "resolved", resolved_at: ago(5) }));
    const rows = [crit("dmit4", { state: "acknowledged" }), crit("bandwagon"), crit("dmit1"), warn("stall"), crit("mac", { since: ago(1) })];
    const view = homeIncidents(rows, NOW, 3, ["dmit4", "bandwagon", "dmit1"], { pinned: new Set(["dmit4"]), before: was });
    assert.deepEqual(ids(view.shown), ["dmit4", "bandwagon", "dmit1"]);
    assert.deepEqual(ids(view.arrived), ["mac"]);
    assert.equal(view.total, 5);
    // The stall was there all along: it is not news though the acknowledgement freed a slot it would take.
    const quiet = homeIncidents(rows.slice(0, 4), NOW, 3, ["dmit4", "bandwagon", "dmit1"], { pinned: new Set(["dmit4"]), before: was });
    assert.deepEqual(quiet.arrived, []);
    assert.deepEqual(homeIncidents(rows, NOW, 3).arrived, [], "no hold, nothing held back");
  });
}
