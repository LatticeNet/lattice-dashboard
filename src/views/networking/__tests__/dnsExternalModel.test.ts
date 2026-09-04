import assert from "node:assert/strict";
import { test } from "node:test";

import type { DNSDeploymentView } from "@/lib/api";
import {
  canPlanDeployment,
  canPublishDeployment,
  certExpiry,
  driftTone,
  formatListeners,
  isObservedEngine,
  listenSummary,
  listenerProcesses,
} from "../dnsExternalModel.ts";

function deployment(over: Partial<DNSDeploymentView>): DNSDeploymentView {
  return {
    id: "dns_1",
    name: "resolver",
    node_id: "node_ob46mh4ltshdpkhc",
    engine: "coredns",
    listen_port: 53,
    enable_udp: true,
    enable_tcp: true,
    exposure: "public",
    zones: [],
    publish_ipv4: false,
    publish_ipv6: false,
    has_credential: false,
    status: "running",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

test("an observed engine is recognised by its engine word, whatever its case", () => {
  assert.equal(isObservedEngine("external"), true);
  assert.equal(isObservedEngine(" External "), true);
  assert.equal(isObservedEngine("coredns"), false);
  assert.equal(isObservedEngine(undefined), false);
});

test("an observed record offers neither plan nor publish", () => {
  const observed = deployment({ engine: "external", hostname: "dns.roobli.org" });
  assert.equal(canPlanDeployment(observed), false);
  assert.equal(canPublishDeployment(observed), false);

  const deployed = deployment({ hostname: "dns.example.com" });
  assert.equal(canPlanDeployment(deployed), true);
  assert.equal(canPublishDeployment(deployed), true);
  // A deployed record without a hostname has nothing to publish.
  assert.equal(canPublishDeployment(deployment({})), false);
});

test("listeners print as protocol/port sorted by port, and name the processes behind them", () => {
  const listeners = [
    { protocol: "tcp", port: 8443, process: "dnsproxy" },
    { protocol: "udp", port: 53, process: "dnsproxy" },
    { protocol: "tcp", port: 53, process: "dnsproxy" },
    { protocol: "tcp", port: 2053, process: "" },
  ];
  assert.deepEqual(formatListeners(listeners), ["tcp/53", "udp/53", "tcp/2053", "tcp/8443"]);
  assert.deepEqual(listenerProcesses(listeners), ["dnsproxy"]);
  assert.deepEqual(formatListeners(undefined), []);
  assert.deepEqual(listenerProcesses(undefined), []);
});

test("the listen column prints the observed socket set, not a single deployed port", () => {
  const observed = deployment({
    engine: "external",
    listen_port: 53,
    listeners: [
      { protocol: "udp", port: 53, process: "dnsproxy" },
      { protocol: "tcp", port: 8443, process: "dnsproxy" },
    ],
  });
  assert.equal(listenSummary(observed), "udp/53, tcp/8443");
  assert.equal(listenSummary(deployment({ enable_udp: true, enable_tcp: false })), "53 udp");
  assert.equal(listenSummary(deployment({ enable_udp: false, enable_tcp: false })), "53");
});

test("the certificate countdown warns inside the renewal window and treats a zero time as unknown", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  assert.deepEqual(certExpiry("2026-11-17T00:00:00Z", now), { tone: "ok", days: 74 });
  assert.deepEqual(certExpiry("2026-09-20T00:00:00Z", now), { tone: "warn", days: 16 });
  assert.deepEqual(certExpiry("2026-08-30T00:00:00Z", now), { tone: "expired", days: -5 });
  // Go's zero time survives omitempty and must not read as a lapsed certificate.
  assert.deepEqual(certExpiry("0001-01-01T00:00:00Z", now), { tone: "unknown", days: 0 });
  assert.deepEqual(certExpiry(undefined, now), { tone: "unknown", days: 0 });
  assert.deepEqual(certExpiry("not a date", now), { tone: "unknown", days: 0 });
});

test("an uncheckable drift verdict is a warning, not a neutral badge", () => {
  assert.equal(driftTone("ok"), "success");
  assert.equal(driftTone("drift"), "destructive");
  assert.equal(driftTone("unknown"), "warning");
  assert.equal(driftTone(undefined), "warning");
});
