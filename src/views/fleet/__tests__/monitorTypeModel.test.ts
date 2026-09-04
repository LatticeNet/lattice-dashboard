import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AGENT_DEFAULT_INTERVAL_SEC,
  AGENT_DEFAULT_TIMEOUT_SEC,
  TLS_DEFAULT_INTERVAL_SEC,
  TLS_DEFAULT_TIMEOUT_SEC,
  buildMonitorCreate,
  canSubmitMonitor,
  isServerEvaluated,
  switchMonitorType,
  tlsTargetError,
  usesThreshold,
  type MonitorFormState,
  type ProbeAssignment,
} from "../monitorTypeModel.ts";

function form(over: Partial<MonitorFormState> = {}): MonitorFormState {
  return {
    name: "dns.roobli.org certificate",
    type: "tls",
    target: "dns.roobli.org:8443",
    intervalSec: 3600,
    timeoutSec: 10,
    thresholdDays: 14,
    assignAll: false,
    nodeIds: [],
    ...over,
  };
}

test("only the certificate watch is server-evaluated and carries a threshold", () => {
  assert.equal(isServerEvaluated("tls"), true);
  assert.equal(isServerEvaluated("tcp"), false);
  assert.equal(usesThreshold("tls"), true);
  assert.equal(usesThreshold("http"), false);
});

test("a tls target is host:port and nothing else", () => {
  assert.equal(tlsTargetError("dns.roobli.org:8443"), undefined);
  assert.equal(tlsTargetError(" 154.17.12.165:2053 "), undefined);
  assert.equal(tlsTargetError("https://dns.roobli.org:8443/dns-query"), "not_host_port");
  assert.equal(tlsTargetError("dns.roobli.org"), "not_host_port");
  assert.equal(tlsTargetError("dns.roobli.org:"), "not_host_port");
  assert.equal(tlsTargetError("dns.roobli.org:70000"), "port_range");
  assert.equal(tlsTargetError("dns.roobli.org:https"), "port_range");
  assert.equal(tlsTargetError("   "), "empty");
});

test("a tls monitor submits without an assignment; an agent monitor cannot", () => {
  assert.equal(canSubmitMonitor(form()), true);
  // The server refuses a tls monitor that names nodes, so the form must not
  // gate on one being chosen.
  assert.equal(canSubmitMonitor(form({ assignAll: false, nodeIds: [] })), true);
  assert.equal(canSubmitMonitor(form({ type: "tcp", assignAll: false, nodeIds: [] })), false);
  assert.equal(canSubmitMonitor(form({ type: "tcp", assignAll: true })), true);
  assert.equal(canSubmitMonitor(form({ target: "https://dns.roobli.org" })), false);
  assert.equal(canSubmitMonitor(form({ thresholdDays: 0 })), false);
  assert.equal(canSubmitMonitor(form({ thresholdDays: 900 })), false);
});

test("the body carries the threshold for tls and the assignment for agent probes, never both", () => {
  assert.deepEqual(buildMonitorCreate(form({ assignAll: true, nodeIds: ["dmit-1"] })), {
    name: "dns.roobli.org certificate",
    type: "tls",
    target: "dns.roobli.org:8443",
    interval_sec: 3600,
    timeout_sec: 10,
    threshold_days: 14,
    assign_all: false,
  });
  assert.deepEqual(
    buildMonitorCreate(form({ type: "tcp", target: "154.17.12.165:53", assignAll: false, nodeIds: ["dmit-1"] })),
    {
      name: "dns.roobli.org certificate",
      type: "tcp",
      target: "154.17.12.165:53",
      interval_sec: 3600,
      timeout_sec: 10,
      assign_all: false,
      node_ids: ["dmit-1"],
    },
  );
});

// ── Switching type without losing the operator's work ─────────────────────

const picked: ProbeAssignment = {
  assignAll: false,
  nodeIds: ["node_ob46mh4ltshdpkhc", "xuezhang-jp"],
  intervalSec: 60,
  timeoutSec: 8,
};

test("a round trip through tls hands the node selection and the cadence back", () => {
  const out = switchMonitorType("tcp", "tls", picked, undefined);
  assert.deepEqual(out.state, {
    assignAll: false,
    nodeIds: [],
    intervalSec: TLS_DEFAULT_INTERVAL_SEC,
    timeoutSec: TLS_DEFAULT_TIMEOUT_SEC,
  });
  assert.deepEqual(out.stash, picked);

  const back = switchMonitorType("tls", "tcp", out.state, out.stash);
  assert.deepEqual(back.state, picked, "the picker has to be re-worked after one mis-click");
  assert.equal(back.stash, undefined);
});

test("the state held aside is a copy, so later edits do not reach into it", () => {
  const live: ProbeAssignment = { ...picked, nodeIds: [...picked.nodeIds] };
  const out = switchMonitorType("tcp", "tls", live, undefined);
  live.nodeIds.push("late-addition");
  const back = switchMonitorType("tls", "http", out.state, out.stash);
  assert.deepEqual(back.state.nodeIds, picked.nodeIds);
});

test("coming back with nothing held aside falls to the agent defaults", () => {
  const back = switchMonitorType("tls", "tcp", { assignAll: false, nodeIds: [], intervalSec: 3600, timeoutSec: 10 }, undefined);
  assert.deepEqual(back.state, {
    assignAll: true,
    nodeIds: [],
    intervalSec: AGENT_DEFAULT_INTERVAL_SEC,
    timeoutSec: AGENT_DEFAULT_TIMEOUT_SEC,
  });
});

test("switching between two agent types leaves the assignment alone", () => {
  // Both run the probe on nodes, so there is nothing to move.
  const out = switchMonitorType("tcp", "http", picked, undefined);
  assert.deepEqual(out.state, picked);
  assert.equal(out.stash, undefined);
  assert.deepEqual(switchMonitorType("tcp", "tcp", picked, undefined).state, picked);
});

test("MonitoringView switches type through the reducer instead of overwriting", () => {
  const view = readFileSync(new URL("../MonitoringView.vue", import.meta.url), "utf8");
  const watcher = view.slice(view.indexOf("watch(monitorType,"), view.indexOf("const isCertWatch"));
  assert.ok(watcher.length > 0, "MonitoringView no longer watches monitorType");
  assert.match(watcher, /switchMonitorType\(/);
  assert.doesNotMatch(
    watcher,
    /selectedNodeIds\.value = \[\]/,
    "the watcher still empties the node list on its own",
  );
  assert.doesNotMatch(watcher, /assignAll\.value = true/, "the watcher still forces assign-all");
});

test("the tls target error is announced, not left as an unexplained invalid field", () => {
  // aria-invalid on its own says "invalid" and stops, which is the one word the
  // operator already knows. The sentence that says a certificate watch takes
  // host:port has to reach the reader who cannot see the red border.
  const view = readFileSync(new URL("../MonitoringView.vue", import.meta.url), "utf8");
  const field = view.slice(view.indexOf('id="monitor-target"'), view.indexOf('id="monitor-type"'));
  assert.ok(field.length > 0, "MonitoringView no longer has a target field before the type select");
  assert.match(field, /:aria-describedby="tlsTargetProblem \? 'monitor-target-error' : undefined"/);
  assert.match(field, /id="monitor-target-error"/);
  assert.match(field, /role="alert"/);
});
