import assert from "node:assert/strict";
import test from "node:test";

import { dnsDeploymentPayload, dnsProtocols, dnsPublishSummary, dnsZoneSummary } from "./dns.js";

test("dnsDeploymentPayload normalizes forward deployment and omits empty token", () => {
  const body = dnsDeploymentPayload({
    id: " dns1 ",
    name: " Private DNS ",
    node_id: " n1 ",
    listen_port: "53",
    enable_udp: true,
    enable_tcp: false,
    exposure: " mesh ",
    zone_suffix: " . ",
    zone_mode: "forward",
    upstreams: "1.1.1.1, 9.9.9.9 1.1.1.1",
    hostname: " n1.dns.example.com ",
    cf_api_token: "",
    publish_ipv4: true,
    publish_ipv6: false,
  });
  assert.deepEqual(body, {
    id: "dns1",
    name: "Private DNS",
    node_id: "n1",
    engine: "coredns",
    listen_port: 53,
    enable_udp: true,
    enable_tcp: false,
    exposure: "mesh",
    zones: [{ suffix: ".", mode: "forward", upstreams: ["1.1.1.1", "9.9.9.9"] }],
    hostname: "n1.dns.example.com",
    ddns_profile_id: "",
    publish_ipv4: true,
    publish_ipv6: false,
    record_ttl: 60,
    disabled: false,
  });
});

test("dnsDeploymentPayload builds static record and keeps write-only token only when set", () => {
  const body = dnsDeploymentPayload({
    name: "dns",
    node_id: "n1",
    zone_suffix: "mesh.local",
    zone_mode: "static",
    record_name: "gw.mesh.local",
    record_type: "A",
    record_value: "10.66.0.1",
    record_ttl: "120",
    cf_api_token: "secret",
    disabled: true,
  });
  assert.equal(body.cf_api_token, "secret");
  assert.equal(body.disabled, true);
  assert.deepEqual(body.zones, [{
    suffix: "mesh.local",
    mode: "static",
    records: [{ name: "gw.mesh.local", type: "A", value: "10.66.0.1", ttl: 120 }],
  }]);
});

test("dns summaries are compact and stable", () => {
  assert.equal(dnsProtocols({ enable_udp: true, enable_tcp: true }), "udp,tcp");
  assert.equal(dnsProtocols({}), "-");
  assert.equal(dnsZoneSummary([{ suffix: ".", mode: "forward", upstreams: ["1.1.1.1"] }]), ". forward 1.1.1.1");
  assert.equal(dnsZoneSummary([{ suffix: "mesh.local.", mode: "static", records: [{ name: "gw" }] }]), "mesh.local. static 1 record(s)");
  assert.equal(dnsZoneSummary([]), "-");
  assert.equal(dnsPublishSummary({}), "");
  assert.equal(dnsPublishSummary({ last_ipv4: "203.0.113.7" }), "published 203.0.113.7");
  assert.equal(dnsPublishSummary({ last_ipv4: "203.0.113.7", last_ipv6: "2001:db8::7" }), "published 203.0.113.7 / 2001:db8::7");
});
