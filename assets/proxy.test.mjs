import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmProxyDelete,
  confirmProxyRotate,
  proxyDeleteConfirmMessage,
  proxyInboundPayload,
  proxyProfilePayload,
  proxyRotateConfirmMessage,
  proxyUserPayload,
  splitProxyList,
} from "./proxy.js";

test("splitProxyList trims, de-dupes, and accepts comma or whitespace lists", () => {
  assert.deepEqual(splitProxyList("in-a, in-b in-a\nin-c"), ["in-a", "in-b", "in-c"]);
  assert.deepEqual(splitProxyList(""), []);
});

test("proxyInboundPayload builds the narrow sing-box VLESS REALITY payload", () => {
  assert.deepEqual(proxyInboundPayload({
    id: " in-a ",
    name: "  Reality 443 ",
    port: "443",
    listen: "::",
    sni: "cdn.example.com",
    alpn: "h2, http/1.1",
    reality_private_key: " private-key ",
    reality_public_key: " public-key ",
    reality_short_ids: "AA, 0123456789ABCDEF",
    reality_dest: "www.microsoft.com:443",
    enabled: true,
  }), {
    id: "in-a",
    name: "Reality 443",
    core: "sing-box",
    protocol: "vless",
    transport: "tcp",
    security: "reality",
    listen: "::",
    port: 443,
    sni: "cdn.example.com",
    alpn: ["h2", "http/1.1"],
    reality_private_key: "private-key",
    reality_public_key: "public-key",
    reality_short_ids: ["aa", "0123456789abcdef"],
    reality_dest: "www.microsoft.com:443",
    enabled: true,
  });
});

test("proxyInboundPayload omits blank write-only private key", () => {
  const body = proxyInboundPayload({ port: "443", reality_private_key: "", enabled: false });
  assert.equal(body.enabled, false);
  assert.ok(!("reality_private_key" in body));
});

test("proxyUserPayload omits raw subscription token and formats expiry", () => {
  assert.deepEqual(proxyUserPayload({
    id: " alice ",
    name: " Alice ",
    enabled: true,
    inbound_ids: "in-a in-b",
    traffic_limit_bytes: "1073741824",
    expires_at: "2026-07-01",
  }), {
    id: "alice",
    name: "Alice",
    enabled: true,
    inbound_ids: ["in-a", "in-b"],
    traffic_limit_bytes: 1073741824,
    expires_at: "2026-07-01T00:00:00Z",
  });
});

test("proxyUserPayload rejects malformed numeric/date input", () => {
  assert.throws(() => proxyUserPayload({ traffic_limit_bytes: "-1" }), /traffic_limit_bytes/);
  assert.throws(() => proxyUserPayload({ expires_at: "07/01/2026" }), /expires_at/);
});

test("proxyProfilePayload builds a node profile payload", () => {
  assert.deepEqual(proxyProfilePayload({
    id: " node-a ",
    node_id: " node-a ",
    inbound_ids: "in-a,in-b",
    hostname: "node-a.dns.example.com",
    listen_ip: "10.66.0.2",
    config_path: "/etc/sing-box/config.json",
    stats_api: "127.0.0.1:9090",
  }), {
    id: "node-a",
    node_id: "node-a",
    core: "sing-box",
    inbound_ids: ["in-a", "in-b"],
    hostname: "node-a.dns.example.com",
    listen_ip: "10.66.0.2",
    config_path: "/etc/sing-box/config.json",
    stats_api: "127.0.0.1:9090",
  });
});

test("confirmProxyRotate delegates the final decision", () => {
  assert.match(proxyRotateConfirmMessage({ id: "alice", name: "Alice" }), /old URL will stop working/);
  assert.equal(confirmProxyRotate({ id: "alice" }, () => true), true);
  assert.equal(confirmProxyRotate({ id: "alice" }, () => false), false);
  assert.equal(confirmProxyRotate({ id: "alice" }, null), false);
});

test("confirmProxyDelete delegates destructive delete confirmation", () => {
  assert.match(proxyDeleteConfirmMessage("user", { id: "alice", name: "Alice" }), /Delete proxy user Alice/);
  assert.equal(confirmProxyDelete("inbound", { id: "in-a" }, () => true), true);
  assert.equal(confirmProxyDelete("profile", { node_id: "node-a" }, () => false), false);
  assert.equal(confirmProxyDelete("user", { id: "alice" }, null), false);
});
