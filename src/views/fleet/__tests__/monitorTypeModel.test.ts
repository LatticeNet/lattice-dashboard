import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMonitorCreate,
  canSubmitMonitor,
  isServerEvaluated,
  tlsTargetError,
  usesThreshold,
  type MonitorFormState,
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
