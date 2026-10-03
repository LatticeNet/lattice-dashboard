import assert from "node:assert/strict";
import test from "node:test";

import {
  CRITICAL_ALERT_EVENTS,
  ESCALATING_KINDS,
  HELD_KINDS,
  INCIDENT_KINDS,
  eventSeverity,
  incidentSeverity,
  ruleIncidentReach,
  ruleRoutes,
} from "../incidentSeverity.ts";

// lattice-server incidents.go (incidentKinds) at a108: node.offline and
// service.down are critical, monitor.down and agent.stalled warnings.
test("the table mirrors the server's incident kinds", () => {
  assert.deepEqual(INCIDENT_KINDS, ["node.offline", "service.down", "monitor.down", "agent.stalled"]);
  assert.deepEqual(ESCALATING_KINDS, ["node.offline", "service.down"]);
  assert.deepEqual(HELD_KINDS, ["monitor.down", "agent.stalled"]);
});

test("a recovery takes its incident's severity, and other events are warnings", () => {
  assert.equal(eventSeverity("node.online"), "critical");
  assert.equal(eventSeverity("service.recovered"), "critical");
  assert.equal(eventSeverity("monitor.recovered"), "warning");
  assert.equal(eventSeverity("agent.recovered"), "warning");
  assert.equal(eventSeverity("ssh.compromise_suspected"), "critical");
  assert.equal(eventSeverity("inventory.renewal"), "warning");
});

// notify_channel_fallback.go notifyCriticalEventList, in its order.
test("a channel's fallback carries the critical opening events", () => {
  assert.deepEqual(CRITICAL_ALERT_EVENTS, ["node.offline", "service.down", "ssh.compromise_suspected"]);
});

test("rule routing matches the server: empty and * route everything", () => {
  assert.equal(ruleRoutes([], "node.offline"), true);
  assert.equal(ruleRoutes(["*"], "monitor.down"), true);
  assert.equal(ruleRoutes(["monitor.down"], "node.offline"), false);
});

test("a rule's reach splits what it re-sends from what quiet hours hold", () => {
  assert.deepEqual(ruleIncidentReach(["monitor.down", "node.offline", "inventory.renewal"]), { critical: ["node.offline"], warning: ["monitor.down"] });
  assert.deepEqual(ruleIncidentReach(["monitor.down", "monitor.recovered"]), { critical: [], warning: ["monitor.down"] });
  assert.deepEqual(ruleIncidentReach(["*"]), { critical: ["node.offline", "service.down"], warning: ["monitor.down", "agent.stalled"] });
  assert.deepEqual(ruleIncidentReach(["ssh.login"]), { critical: [], warning: [] });
});

test("an incident's severity is its record's, else its kind's", () => {
  assert.equal(incidentSeverity({ kind: "monitor.down", severity: "critical" }), "critical");
  assert.equal(incidentSeverity({ kind: "node.offline" }), "critical");
  assert.equal(incidentSeverity({ kind: "agent.stalled", severity: "info" }), "warning");
});
