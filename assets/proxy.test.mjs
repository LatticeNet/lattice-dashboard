import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmProxyDelete,
  confirmProxyRotate,
  proxyCollectorLabel,
  proxyCollectorStatusClass,
  proxyCoreApprovalQueue,
  proxyDeleteConfirmMessage,
  proxyInboundPayload,
  proxyProfilePayload,
  proxyRotateConfirmMessage,
  proxySubscriptionImportTargets,
  proxyUsageLabel,
  proxyUsagePercent,
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
    fingerprint: " chrome ",
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
    fingerprint: "chrome",
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

test("proxyInboundPayload preserves selected xray core", () => {
  const body = proxyInboundPayload({
    core: "xray",
    name: "Xray Reality",
    port: "443",
    reality_short_ids: "aa",
    enabled: true,
  });
  assert.equal(body.core, "xray");
  assert.equal(body.protocol, "vless");
  assert.equal(body.transport, "tcp");
  assert.equal(body.security, "reality");
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

test("proxyProfilePayload preserves selected xray core", () => {
  assert.deepEqual(proxyProfilePayload({
    node_id: "node-x",
    core: "xray",
    inbound_ids: "in-x",
    config_path: "/usr/local/etc/xray/config.json",
  }), {
    node_id: "node-x",
    core: "xray",
    inbound_ids: ["in-x"],
    config_path: "/usr/local/etc/xray/config.json",
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

test("proxy usage labels show quota progress without leaking credentials", () => {
  const fmt = (v) => `${v}B`;
  assert.equal(proxyUsagePercent({ used_bytes: 50, traffic_limit_bytes: 200 }), 25);
  assert.equal(proxyUsagePercent({ used_bytes: 50, traffic_limit_bytes: 0 }), null);
  assert.equal(proxyUsageLabel({ used_bytes: 50, traffic_limit_bytes: 200 }, fmt), "50B / 200B (25%)");
  assert.equal(proxyUsageLabel({ used_bytes: 50 }, fmt), "50B used");
  assert.equal(proxyUsageLabel({ used_bytes: "not-a-number" }, fmt), "0B used");
});

test("proxy collector labels summarize health without changing policy", () => {
  const fmt = (v) => `date:${v}`;
  assert.equal(proxyCollectorLabel({}, fmt), "collector not reported");
  assert.equal(proxyCollectorStatusClass({}), "muted");
  assert.equal(proxyCollectorLabel({
    usage_collector_status: "ok",
    usage_collector_source: "http",
    usage_collector_checked_at: "2026-06-14T10:00:00Z",
  }, fmt), "collector ok (http) · checked date:2026-06-14T10:00:00Z");
  assert.equal(proxyCollectorStatusClass({ usage_collector_status: "ok" }), "pill");
  assert.equal(proxyCollectorLabel({
    usage_collector_status: "error",
    usage_collector_source: "file",
    usage_collector_last_error: "open /run/usage.json: no such file",
  }, fmt), "collector error (file): open /run/usage.json: no such file");
  assert.equal(proxyCollectorStatusClass({ usage_collector_status: "error" }), "danger");
});

test("proxySubscriptionImportTargets derives copy-safe format URLs", () => {
  const relative = proxySubscriptionImportTargets("/sub/abc?format=plain&keep=1");
  assert.deepEqual(relative.map((x) => [x.format, x.url]), [
    ["base64", "/sub/abc?keep=1"],
    ["plain", "/sub/abc?keep=1&format=plain"],
    ["sing-box", "/sub/abc?keep=1&format=sing-box"],
    ["clash-meta", "/sub/abc?keep=1&format=clash-meta"],
  ]);
  assert.deepEqual(relative.map((x) => x.label), ["Base64", "Plain links", "sing-box JSON", "Clash/Mihomo YAML"]);

  const absolute = proxySubscriptionImportTargets("https://dash.example/sub/abc");
  assert.equal(absolute.find((x) => x.format === "sing-box").url, "https://dash.example/sub/abc?format=sing-box");
  assert.deepEqual(proxySubscriptionImportTargets(""), []);
  assert.deepEqual(proxySubscriptionImportTargets("not a valid url"), []);
});

test("proxyCoreApprovalQueue selects only pending proxy apply reviews", () => {
  const approvals = [
    { id: "old", plugin: "proxycore", action: "apply-config", status: "pending", node_id: "node-a", created_at: "2026-06-14T10:00:00Z" },
    { id: "new", plugin: "proxycore", action: "apply-config", status: "pending", node_id: "node-b", created_at: "2026-06-14T11:00:00Z" },
    { id: "applied", plugin: "proxycore", action: "apply-config", status: "applied", node_id: "node-c", created_at: "2026-06-14T12:00:00Z" },
    { id: "nft", plugin: "nft", action: "apply", status: "pending", node_id: "node-d", created_at: "2026-06-14T13:00:00Z" },
    { id: "proxy-other", plugin: "proxycore", action: "rotate", status: "pending", node_id: "node-e", created_at: "2026-06-14T14:00:00Z" },
    { id: "missing-node", plugin: "proxycore", action: "apply-config", status: "pending", created_at: "2026-06-14T15:00:00Z" },
  ];
  assert.deepEqual(proxyCoreApprovalQueue(approvals).map((a) => a.id), ["new", "old"]);
});
