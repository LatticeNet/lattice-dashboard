import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalHeaderName,
  canonicalStatusSet,
  destinationProblem,
  destinationRefused,
  effectiveProbeMethods,
  headerNameProblem,
  headerValueProblem,
  isHttpsUrl,
  monitorOrigin,
  normalizeProbeMethods,
  parseIPv4,
  parseIPv6,
  parseStatusSet,
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
  ];
  for (const raw of refused) assert.equal(destinationRefused(raw), true, raw);
  for (const raw of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1", "203.0.113.7", "172.32.0.1", "100.128.0.1"]) assert.equal(destinationRefused(raw), false, raw);
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
