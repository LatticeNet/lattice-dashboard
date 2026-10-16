import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentReportsMethods,
  canonicalHeaderName,
  canonicalStatusSet,
  destinationProblem,
  destinationRefused,
  effectiveProbeMethods,
  headerNameProblem,
  headerValueProblem,
  hostProblem,
  isHttpsUrl,
  monitorOrigin,
  monitorSpeaksM2a,
  needsCurrentAgent,
  normalizeProbeMethods,
  numericLabel,
  parseIPv4,
  parseIPv6,
  parseStatusSet,
  publicIPv4,
  serverSpeaksM2a,
  sourceSupport,
} from "../checkRulesModel.ts";

/* ---- Probe methods (lattice-sdk TestProbeMethods) ---- */

test("an agent that reports nothing runs exactly tcp and http", () => {
  assert.deepEqual(effectiveProbeMethods(undefined), ["http", "tcp"]);
  assert.deepEqual(effectiveProbeMethods({}), ["http", "tcp"]);
  assert.deepEqual(effectiveProbeMethods({ probe_methods: [] }), ["http", "tcp"]);
});

test("a report keeps the known kinds once each, sorted, and is taken as the whole list", () => {
  assert.deepEqual(normalizeProbeMethods([" icmp", "tcp", "gopher", "icmp", "http", "beacon"]), ["beacon", "http", "icmp", "tcp"]);
  assert.deepEqual(effectiveProbeMethods({ probe_methods: ["tcp", "icmp"] }), ["icmp", "tcp"]);
  // A report of no known kind is no report: the server's effective list is never empty.
  assert.deepEqual(normalizeProbeMethods(["gopher"]), []);
});

test("the server speaks M2a when a node carries probe_methods, or the plan names methods", () => {
  assert.equal(serverSpeaksM2a([{ probe_methods: ["http", "tcp"] }, {}]), true);
  assert.equal(serverSpeaksM2a([{}, {}]), false);
  assert.equal(serverSpeaksM2a(undefined), false);
  // A session without node:read still learns it from the latency plan.
  assert.equal(serverSpeaksM2a([], { config: { enabled: true, interval_sec: 60, timeout_sec: 5, sources: [], auto_targets: true, version: 1 }, pairs: [{ source: "a", target: "b", enabled: true, active: true, method: "tcp" }] }), true);
  assert.equal(serverSpeaksM2a([], { config: { enabled: true, interval_sec: 60, timeout_sec: 5, sources: [], auto_targets: true, version: 1 }, pairs: [{ source: "a", target: "b", enabled: true, active: true }] }), false);
});

test("a source that cannot run a kind is refused with the host's reason, else agent_too_old", () => {
  const legacy = {};
  const m2a = { probe_methods: ["http", "icmp", "tcp"] };
  const refused = { probe_methods: ["http", "tcp"], probe_refusals: { icmp: "icmp_not_permitted" } };
  assert.deepEqual(sourceSupport(m2a, "icmp", true), { ok: true });
  assert.deepEqual(sourceSupport(legacy, "icmp", true), { ok: false, reason: "agent_too_old" });
  assert.deepEqual(sourceSupport(refused, "icmp", true), { ok: false, reason: "icmp_not_permitted" });
  assert.deepEqual(sourceSupport(legacy, "tcp", true), { ok: true });
  assert.deepEqual(sourceSupport(legacy, "http", true), { ok: true });
  // tls runs on the control plane; a server before M2a gates nothing.
  assert.deepEqual(sourceSupport(legacy, "tls", true), { ok: true });
  assert.deepEqual(sourceSupport(legacy, "icmp", false), { ok: true });
  // A refusal code that is not a code is not shown as one.
  assert.deepEqual(sourceSupport({ probe_methods: ["tcp"], probe_refusals: { icmp: "<b>x</b>" } }, "icmp", true), { ok: false, reason: "agent_too_old" });
  assert.deepEqual(sourceSupport(undefined, "icmp", true), { ok: true }, "a node this session cannot see is the server's to judge");
});

test("an agent reports its methods when icmp is among them or among its refusals", () => {
  // The node read carries the effective list: tcp and http for an agent that reported nothing.
  assert.equal(agentReportsMethods({ probe_methods: ["http", "tcp"] }), false);
  assert.equal(agentReportsMethods({}), false);
  assert.equal(agentReportsMethods(undefined), false);
  assert.equal(agentReportsMethods({ probe_methods: ["http", "icmp", "tcp"] }), true);
  assert.equal(agentReportsMethods({ probe_methods: ["http", "tcp"], probe_refusals: { icmp: "icmp_not_permitted" } }), true);
});

test("an http check needs a current agent with headers or a status set other than the default (monitorNeedsCurrentAgent)", () => {
  assert.equal(needsCurrentAgent("http", "", 0), false);
  assert.equal(needsCurrentAgent("http", "200-399", 0), false);
  assert.equal(needsCurrentAgent("http", " 300-399, 200-299 ", 0), false, "the default written another way");
  assert.equal(needsCurrentAgent("http", "200-299", 0), true);
  assert.equal(needsCurrentAgent("http", "2xx", 0), true, "a set the server cannot read is not the default");
  assert.equal(needsCurrentAgent("http", "", 1), true);
  assert.equal(needsCurrentAgent("tcp", "200", 2), false);
  const legacy = { probe_methods: ["http", "tcp"] };
  const current = { probe_methods: ["http", "icmp", "tcp"] };
  assert.deepEqual(sourceSupport(legacy, "http", true, true), { ok: false, reason: "agent_too_old" });
  assert.deepEqual(sourceSupport(current, "http", true, true), { ok: true });
  assert.deepEqual(sourceSupport(legacy, "http", true, false), { ok: true });
  assert.deepEqual(sourceSupport(legacy, "http", false, true), { ok: true }, "an M1 server gates nothing");
});

test("a check with an M2a field says the server speaks M2a when nodes and the plan cannot", () => {
  assert.equal(monitorSpeaksM2a({ headers: [{ name: "X-Api-Key", secret: true, set: true }] }), true);
  assert.equal(monitorSpeaksM2a({ expect_status: "200-399" }), true);
  assert.equal(monitorSpeaksM2a({ target_node: "jp" }), true);
  assert.equal(monitorSpeaksM2a({ packets: 5 }), true);
  assert.equal(monitorSpeaksM2a({ latest: [{ node_id: "sh", at: "", success: true, fail_streak: 0, since: "", sent: 1, lost: 0 }] }), true);
  assert.equal(monitorSpeaksM2a({ headers: [], latest: [{ node_id: "sh", at: "", success: true, fail_streak: 0, since: "" }] }), false);
  assert.equal(monitorSpeaksM2a(undefined), false);
  assert.equal(serverSpeaksM2a(undefined, null, [{}, { expect_status: "200-299" }]), true);
  assert.equal(serverSpeaksM2a(undefined, null, [{}, {}]), false);
});

/* ---- Status sets (lattice-sdk TestParseMonitorStatusSet) ---- */

test("status sets parse, sort and merge as the server's", () => {
  const ok: [string, string][] = [
    ["", "200-399"],
    [" 204 ", "204"],
    ["200-299, 301,404", "200-299,301,404"],
    ["301,200-299,300", "200-301"],
    ["200-250,240-260", "200-260"],
    ["599", "599"],
    ["200 - 299", "200-299"],
  ];
  for (const [input, canonical] of ok) {
    const parsed = parseStatusSet(input);
    assert.ok(parsed.ok, input);
    assert.equal(parsed.ok && parsed.canonical, canonical, input);
  }
  assert.equal(canonicalStatusSet(undefined), "200-399");
});

test("a status set that the server refuses is refused with its reason", () => {
  const bad: [string, string][] = [
    ["99", "notStatus"],
    ["600", "notStatus"],
    ["2xx", "notStatus"],
    ["200,,300", "notStatus"],
    ["200-", "notStatus"],
    ["+20", "notStatus"],
    ["299-200", "backwards"],
    [`${"200,".repeat(16)}200`, "tooMany"],
  ];
  for (const [input, code] of bad) {
    const parsed = parseStatusSet(input);
    assert.equal(parsed.ok, false, input);
    assert.equal(!parsed.ok && parsed.problem.code, code, input);
  }
  const many = parseStatusSet(`${"200,".repeat(16)}200`);
  assert.deepEqual(!many.ok && many.problem, { code: "tooMany", count: 17 });
  const backwards = parseStatusSet("200, 299-200");
  assert.deepEqual(!backwards.ok && backwards.problem, { code: "backwards", entry: "299-200" });
  assert.equal(canonicalStatusSet("2xx"), undefined);
});

/* ---- Headers (lattice-sdk TestValidateMonitorHeader) ---- */

test("header names and values follow the server's rule", () => {
  for (const [name, value] of [
    ["Authorization", "Bearer abc"],
    ["x-api-key", "k\tv"],
    ["Cookie", "a=b"],
    [`X-${"a".repeat(62)}`, "v".repeat(4096)],
  ] as const) {
    assert.equal(headerNameProblem(name), undefined, name);
    assert.equal(headerValueProblem(value), undefined, name);
  }
  assert.equal(headerNameProblem(""), "nameLength");
  assert.equal(headerNameProblem("a".repeat(65)), "nameLength");
  assert.equal(headerNameProblem("X Space"), "nameChars");
  assert.equal(headerNameProblem("X:Colon"), "nameChars");
  for (const name of ["Host", "host", "Transfer-Encoding", "Proxy-Authorization", "proxy-anything", "TE", "Content-Length"]) assert.equal(headerNameProblem(name), "nameForbidden", name);
  assert.equal(headerValueProblem(""), "valueLength");
  assert.equal(headerValueProblem("v".repeat(4097)), "valueLength");
  // Bytes, not characters: 1366 three-byte characters are 4098 bytes.
  assert.equal(headerValueProblem("密".repeat(1366)), "valueLength");
  assert.equal(headerValueProblem("line\r\nX-Injected: 1"), "valueControl");
  assert.equal(headerValueProblem("nul\x00"), "valueControl");
  assert.equal(headerValueProblem("del\x7f"), "valueControl");
});

test("header names are compared in Go's canonical form", () => {
  assert.equal(canonicalHeaderName(" x-api-KEY "), "X-Api-Key");
  assert.equal(canonicalHeaderName("authorization"), "Authorization");
  assert.equal(canonicalHeaderName("x space"), "x space");
});

/* ---- Origins (lattice-sdk TestMonitorOrigin) ---- */

test("an origin is scheme, host and port, in lower case, the port always written", () => {
  assert.equal(monitorOrigin("https://Example.COM/health?x=1"), "https://example.com:443");
  assert.equal(monitorOrigin("HTTPS://example.com:8443/"), "https://example.com:8443");
  assert.equal(monitorOrigin("http://example.com"), "http://example.com:80");
  assert.equal(monitorOrigin("https://[2001:db8::1]/x"), "https://[2001:db8::1]:443");
  assert.equal(monitorOrigin("https://user:pw@example.com/"), "https://example.com:443");
  for (const raw of ["ftp://example.com/", "example.com", "://", ""]) assert.equal(monitorOrigin(raw), undefined, raw);
  assert.equal(isHttpsUrl("https://status.example.com/health"), true);
  assert.equal(isHttpsUrl("http://status.example.com/health"), false);
});

/* ---- Destinations (lattice-sdk TestMonitorDestinationRefused) ---- */

test("addresses an agent refuses to dial are refused", () => {
  const refused = [
    "127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "169.254.1.1", "fd00:ec2::254",
    "fc00::1", "fe80::1", "224.0.0.1", "ff02::1", "0.0.0.0", "::", "0.1.2.3", "100.64.0.1", "255.255.255.255",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "[::1]", "fe80::1%eth0",
    // lattice-sdk c9739fa: reserved and benchmarking IPv4, and IPv6 forms that reach IPv4 space.
    "192.0.0.8", "198.18.0.1", "198.19.255.255", "240.0.0.1", "64:ff9b::a00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
    "::ffff:0:a00:1", "2002:a00:1::1", "2002:7f00:1::", "64:ff9b:1::808:808", "::808:808", "fec0::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  ];
  for (const raw of refused) assert.equal(destinationRefused(raw), true, raw);
  for (const raw of [
    "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1", "203.0.113.7", "172.32.0.1", "100.128.0.1",
    "64:ff9b::808:808", "2002:808:808::1", "192.0.1.1", "198.20.0.1", "223.255.255.1",
  ]) assert.equal(destinationRefused(raw), false, raw);
  // A name is judged by the agent when it resolves it.
  assert.equal(destinationRefused("status.example.com"), undefined);
});

test("IP literals parse as netip reads them", () => {
  assert.deepEqual(parseIPv4("203.0.113.9"), [203, 0, 113, 9]);
  for (const raw of ["203.0.113", "203.0.113.256", "010.0.0.1", "1.2.3.4.5", "a.b.c.d", ""]) assert.equal(parseIPv4(raw), undefined, raw);
  assert.deepEqual(parseIPv6("2001:db8::1"), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6("::ffff:1.2.3.4"), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:7:8"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:1.2.3.4"), [1, 2, 3, 4, 5, 6, 0x102, 0x304]);
  for (const raw of ["1:2:3:4:5:6:7", "1::2::3", "12345::", "1:2:3:4:5:6:7:8:9", "example.com"]) assert.equal(parseIPv6(raw), undefined, raw);
});

test("the destination rule per kind: icmp takes a global IPv4, tcp and http refuse local literals and names", () => {
  assert.equal(destinationProblem("icmp", "203.0.113.9"), undefined);
  assert.equal(destinationProblem("icmp", "10.0.0.5"), "refused");
  assert.equal(destinationProblem("icmp", "example.com"), "notIPv4");
  assert.equal(destinationProblem("tcp", "example.com:443"), undefined);
  assert.equal(destinationProblem("tcp", "192.168.1.1:22"), "refused");
  assert.equal(destinationProblem("tcp", "[::1]:22"), "refused");
  assert.equal(destinationProblem("tcp", "localhost:8080"), "localhost");
  assert.equal(destinationProblem("http", "https://status.example.com/health"), undefined);
  assert.equal(destinationProblem("http", "http://169.254.169.254/latest/meta-data"), "refused");
  assert.equal(destinationProblem("http", "http://[fd00:ec2::254]/"), "refused");
  assert.equal(destinationProblem("http", "http://api.localhost/"), "localhost");
  assert.equal(destinationProblem("http", "https://user:pw@example.com/"), "userinfo");
  assert.equal(destinationProblem("tls", "10.0.0.1:443"), undefined);
  assert.equal(destinationProblem("http", ""), undefined);
});

test("hosts follow the server's checkMonitorHost: zones and spaces, then numeric forms", () => {
  assert.equal(numericLabel("2130706433"), true);
  assert.equal(numericLabel("0x7f"), true);
  assert.equal(numericLabel("0x"), true, "as monitorNumericLabel: 0x with nothing after it");
  assert.equal(numericLabel("0xg"), false);
  assert.equal(numericLabel("com"), false);
  assert.equal(numericLabel(""), false);
  assert.equal(hostProblem("2130706433"), "numeric");
  assert.equal(hostProblem("127.1"), "numeric");
  assert.equal(hostProblem("0x7f.1"), "numeric");
  assert.equal(hostProblem("0X7F.1"), "numeric", "compared in lower case");
  assert.equal(hostProblem("1.2.3.4."), "numeric", "a trailing dot is not an address netip reads");
  assert.equal(hostProblem("8.8.8.8"), undefined);
  assert.equal(hostProblem("status.example.com"), undefined);
  assert.equal(hostProblem("1password.com"), undefined, "a label that starts with a digit is a name");
  assert.equal(hostProblem("fe80::1%eth0"), "notHost");
  assert.equal(hostProblem("[fe80::1%25eth0]"), "notHost");
  assert.equal(hostProblem("exa mple.com"), "notHost");
  assert.equal(destinationProblem("tcp", "2130706433:80"), "numeric");
  assert.equal(destinationProblem("tcp", "0x7f.1:80"), "numeric");
  // The browser would read http://127.1/ as 127.0.0.1; the server reads the host as typed.
  assert.equal(destinationProblem("http", "http://127.1/"), "numeric");
  assert.equal(destinationProblem("http", "http://8.8.8/"), "numeric");
  assert.equal(destinationProblem("http", "https://status.example.com:8443/health?x=1"), undefined);
  assert.equal(destinationProblem("http", "http://[2606:4700:4700::1111]:8080/"), undefined);
});

test("a node's public IPv4 for ICMP is a dotted IPv4 the destination rule accepts", () => {
  assert.equal(publicIPv4(" 203.0.113.9 "), "203.0.113.9");
  for (const raw of ["10.0.0.5", "100.64.1.1", "2001:db8::1", "", undefined, "example.com"]) assert.equal(publicIPv4(raw), undefined, String(raw));
});
