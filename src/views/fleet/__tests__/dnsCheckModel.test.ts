import assert from "node:assert/strict";
import { test } from "node:test";

import type { MonitorView } from "../../../lib/api/types.ts";
import { buildCreate, buildUpdate, draftFromMonitor, draftProblems, emptyDraft, identityChanged, offeredKinds, suggestName, unsupportedSources } from "../checksModel.ts";
import { buildDefinitionSave, definitionProblems, draftFromDefinition, emptyDefinitionDraft, suggestDefinitionName, withKind } from "../definitionsModel.ts";
import {
  DNS_EXPECT_MAX,
  canonicalDnsValue,
  canonicalResolver,
  checkDestination,
  dnsFailure,
  expectBlocks,
  failedAnswer,
  normalizeDnsName,
  parseExpect,
  parseResolver,
  resolverEncrypted,
} from "../dnsCheckModel.ts";
import { targetError } from "../monitorTypeModel.ts";

/* ---- Resolver endpoints (lattice-sdk TestParseDNSResolver) ---- */

test("resolver endpoints parse to the SDK's canonical form", () => {
  const cases: [string, string, string, number, string][] = [
    ["https://dns.google/dns-query", "https", "dns.google", 443, "https://dns.google/dns-query"],
    ["HTTPS://DNS.Example:8443/q/abc", "https", "dns.example", 8443, "https://dns.example:8443/q/abc"],
    ["tls://1.1.1.1", "tls", "1.1.1.1", 853, "tls://1.1.1.1"],
    ["tls://dns.example:853/", "tls", "dns.example", 853, "tls://dns.example"],
    [" udp://8.8.8.8:53 ", "udp", "8.8.8.8", 53, "udp://8.8.8.8"],
    ["tcp://[2606:4700:4700:0:0:0:0:1111]:5353", "tcp", "2606:4700:4700::1111", 5353, "tcp://[2606:4700:4700::1111]:5353"],
    ["udp://[::FFFF:192.0.2.1]", "udp", "::ffff:192.0.2.1", 53, "udp://[::ffff:192.0.2.1]"],
  ];
  for (const [raw, transport, host, port, canonical] of cases) {
    const parsed = parseResolver(raw);
    assert.ok(parsed.ok, raw);
    assert.equal(parsed.resolver.transport, transport, raw);
    assert.equal(parsed.resolver.host, host, raw);
    assert.equal(parsed.resolver.port, port, raw);
    assert.equal(parsed.canonical, canonical, raw);
    const again = parseResolver(parsed.canonical);
    assert.ok(again.ok && again.canonical === canonical, `${raw}: the canonical form parses back`);
  }
  assert.equal(canonicalResolver("UDP://9.9.9.9:53"), "udp://9.9.9.9");
  assert.ok(resolverEncrypted("https://dns.example/dns-query") && resolverEncrypted("tls://dns.example"));
  assert.ok(!resolverEncrypted("udp://dns.example") && !resolverEncrypted("tcp://dns.example"));
});

test("resolver endpoints the SDK refuses are refused, each with its reason", () => {
  const cases: [string, string][] = [
    ["", "shape"],
    ["dns.google", "shape"],
    ["8.8.8.8:53", "shape"],
    ["quic://dns.example", "scheme"],
    ["http://dns.example/dns-query", "scheme"],
    ["https://dns.example", "noPath"],
    ["https://dns.example/", "noPath"],
    ["udp://dns.example/path", "path"],
    ["tls://dns.example:0", "port"],
    ["tcp://dns.example:65536", "port"],
    ["tcp://dns.example:", "port"],
    ["https://user:pw@dns.example/dns-query", "extra"],
    ["https://dns.example/dns-query?token=1", "extra"],
    ["https://dns.example/dns-query#x", "extra"],
    ["udp://[fe80::1%25eth0]", "host"],
    ["udp://2001:db8::1", "host"],
    ["udp://exa mple.com", "host"],
    ["udp://bad_label..com", "host"],
  ];
  for (const [raw, problem] of cases) {
    const parsed = parseResolver(raw);
    assert.ok(!parsed.ok, raw);
    assert.equal(parsed.problem, problem, raw);
  }
  assert.equal(targetError("dns", "quic://dns.example"), "not_resolver");
  assert.equal(targetError("dns", "udp://9.9.9.9"), undefined);
});

test("the destination rule applies to the resolver's host on create", () => {
  assert.equal(checkDestination("dns", "udp://10.0.0.53"), "refused");
  assert.equal(checkDestination("dns", "tls://169.254.169.254"), "refused");
  assert.equal(checkDestination("dns", "tls://localhost"), "localhost");
  assert.equal(checkDestination("dns", "udp://2130706433"), "numeric");
  assert.equal(checkDestination("dns", "https://dns.google/dns-query"), undefined);
  assert.equal(checkDestination("dns", "udp://9.9.9.9"), undefined);
  // Other kinds keep their own rule.
  assert.equal(checkDestination("tcp", "127.0.0.1:53"), "refused");
});

/* ---- Names and values (lattice-sdk TestNormalizeDNSName, TestCanonicalDNSValue) ---- */

test("question names are lower case without the trailing dot, at most 253 bytes", () => {
  assert.deepEqual(normalizeDnsName("Example.COM."), { ok: true, name: "example.com" });
  assert.deepEqual(normalizeDnsName(" _dmarc.example.com "), { ok: true, name: "_dmarc.example.com" });
  assert.ok(normalizeDnsName(`${"a.".repeat(126)}a`).ok);
  assert.deepEqual(normalizeDnsName(""), { ok: false, problem: "empty" });
  assert.deepEqual(normalizeDnsName(`${"a.".repeat(127)}a`), { ok: false, problem: "long" });
  assert.deepEqual(normalizeDnsName("a..b"), { ok: false, problem: "label" });
  assert.deepEqual(normalizeDnsName(`${"a".repeat(64)}.com`), { ok: false, problem: "label" });
  assert.deepEqual(normalizeDnsName("bücher.example"), { ok: false, problem: "chars" });
});

test("expected values take the form an agent compares answers in", () => {
  assert.deepEqual(canonicalDnsValue("A", " 192.0.2.1 "), { ok: true, value: "192.0.2.1" });
  assert.deepEqual(canonicalDnsValue("AAAA", "2001:DB8:0:0::1"), { ok: true, value: "2001:db8::1" });
  assert.deepEqual(canonicalDnsValue("AAAA", "::ffff:192.0.2.1"), { ok: true, value: "::ffff:192.0.2.1" });
  assert.deepEqual(canonicalDnsValue("CNAME", "Edge.Example.NET."), { ok: true, value: "edge.example.net" });
  assert.deepEqual(canonicalDnsValue("TXT", " Keep Spaces "), { ok: true, value: " Keep Spaces " });
  assert.deepEqual(canonicalDnsValue("A", "2001:db8::1"), { ok: false, problem: "notIPv4" });
  assert.deepEqual(canonicalDnsValue("AAAA", "192.0.2.1"), { ok: false, problem: "notIPv6" });
  assert.deepEqual(canonicalDnsValue("MX", "10 mx1.example.com"), { ok: false, problem: "notName" });
  assert.deepEqual(canonicalDnsValue("TXT", "x".repeat(256)), { ok: false, problem: "txtLength" });
});

test("the expected list is one value per line, deduplicated, bounded, and empty with NXDOMAIN", () => {
  const ok = parseExpect("A", "192.0.2.1\n\n192.0.2.01x\n192.0.2.1\n192.0.2.2", "");
  assert.deepEqual(ok.values, ["192.0.2.1", "192.0.2.2"]);
  assert.deepEqual(ok.problems, [{ line: 3, problem: "notIPv4" }]);
  assert.ok(expectBlocks(ok));
  const txt = parseExpect("TXT", "v=spf1 include:a, include:b -all", "");
  assert.deepEqual(txt.values, ["v=spf1 include:a, include:b -all"], "a TXT value may hold a comma");
  const many = Array.from({ length: DNS_EXPECT_MAX + 1 }, (_, i) => `192.0.2.${i + 1}`).join("\n");
  assert.ok(parseExpect("A", many, "").tooMany);
  assert.ok(parseExpect("A", "192.0.2.1", "NXDOMAIN").withNxdomain);
  assert.ok(!expectBlocks(parseExpect("A", "", "NXDOMAIN")));
});

/* ---- Results ---- */

test("a dns failure reads as its code, and a failed run shows what came back", () => {
  assert.deepEqual(dnsFailure("dns_mismatch: the A answer for x lacks 192.0.2.9"), { code: "dns_mismatch", detail: "the A answer for x lacks 192.0.2.9" });
  assert.equal(dnsFailure("dial tcp: i/o timeout"), undefined);
  assert.equal(dnsFailure(undefined), undefined);
  const answers = ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5", "192.0.2.6"];
  assert.deepEqual(failedAnswer({ success: false, dns_rcode: "NOERROR", dns_answers: answers }), { rcode: "NOERROR", answers: answers.slice(0, 4), more: 2 });
  assert.deepEqual(failedAnswer({ success: false, dns_rcode: "SERVFAIL" }), { rcode: "SERVFAIL", answers: [], more: 0 });
  assert.equal(failedAnswer({ success: true, dns_rcode: "NOERROR" }), undefined, "a passing run needs no answer line");
  assert.equal(failedAnswer({ success: false, reason: "destination_refused" }), undefined, "an unknown run got nothing back");
  assert.equal(failedAnswer({ success: false, dns_rcode: undefined }), undefined, "a transport failure got nothing back");
});

/* ---- The check editor ---- */

const stored: MonitorView = {
  id: "mon_dns",
  name: "Resolver",
  type: "dns",
  target: "udp://9.9.9.9",
  interval_sec: 300,
  timeout_sec: 3,
  enabled: true,
  version: 4,
  node_ids: ["n1"],
  dns_name: "example.org",
  dns_type: "A",
  dns_expect: ["192.0.2.1"],
};

test("dns is offered on an M2a server and its draft round-trips the question", () => {
  assert.ok(offeredKinds(true).includes("dns"));
  assert.ok(!offeredKinds(false).includes("dns"));
  const draft = draftFromMonitor(stored);
  assert.equal(draft.dnsName, "example.org");
  assert.equal(draft.dnsExpect, "192.0.2.1");
  assert.deepEqual(buildUpdate(stored, draft, { m2a: true }), { id: "mon_dns", version: 4 }, "an unchanged question sends nothing");
});

test("a dns draft is refused where the server would refuse it", () => {
  const base = { ...emptyDraft("dns"), target: "udp://9.9.9.9", dnsName: "example.org", assignAll: true };
  assert.deepEqual(draftProblems(base, { m2a: true, newCheck: true }), []);
  assert.ok(draftProblems({ ...base, dnsName: "" }, { m2a: true }).includes("dnsName"));
  assert.ok(draftProblems({ ...base, dnsExpect: "2001:db8::1" }, { m2a: true }).includes("dnsExpect"));
  assert.ok(draftProblems({ ...base, dnsExpect: "192.0.2.1", dnsExpectRcode: "NXDOMAIN" }, { m2a: true }).includes("dnsExpect"));
  assert.ok(draftProblems({ ...base, target: "https://dns.example" }, { m2a: true }).includes("target"));
  assert.ok(draftProblems({ ...base, target: "udp://192.168.1.1" }, { m2a: true, newCheck: true }).includes("destination"));
  assert.ok(!draftProblems({ ...base, target: "udp://192.168.1.1" }, { m2a: true, newCheck: false }).includes("destination"), "an edit keeps a stored target editable");
});

test("a dns create and edit send the question in the server's canonical form", () => {
  const draft = { ...emptyDraft("dns"), target: " UDP://9.9.9.9:53 ", dnsName: "WWW.Example.org.", dnsType: "AAAA", dnsExpect: "2001:DB8::1\n2001:db8::1", assignAll: true };
  const create = buildCreate(draft, true, { m2a: true });
  assert.equal(create.target, "UDP://9.9.9.9:53");
  assert.equal(create.dns_name, "www.example.org");
  assert.equal(create.dns_type, "AAAA");
  assert.deepEqual(create.dns_expect, ["2001:db8::1"]);
  assert.equal(create.dns_expect_rcode, undefined);
  assert.equal(create.packets, undefined);

  const edited = { ...draftFromMonitor(stored), dnsExpect: "", dnsExpectRcode: "NXDOMAIN" };
  assert.deepEqual(buildUpdate(stored, edited, { m2a: true }), { id: "mon_dns", version: 4, dns_expect: [], dns_expect_rcode: "NXDOMAIN" });
  const back = { ...draftFromMonitor({ ...stored, dns_expect: undefined, dns_expect_rcode: "NXDOMAIN" }), dnsExpectRcode: "" };
  assert.equal(buildUpdate({ ...stored, dns_expect: undefined, dns_expect_rcode: "NXDOMAIN" }, back, { m2a: true }).dns_expect_rcode, "NOERROR", "clearing NXDOMAIN names NOERROR, which the server stores as absent");
});

test("another spelling of the same resolver is the same check; another resolver is a new one", () => {
  const draft = draftFromMonitor(stored);
  assert.ok(!identityChanged(stored, { ...draft, target: "udp://9.9.9.9:53" }));
  assert.ok(identityChanged(stored, { ...draft, target: "tcp://9.9.9.9" }));
  assert.equal(suggestName("dns", "https://dns.google/dns-query"), "DNS HTTPS dns.google");
});

test("a source whose agent does not report dns reads agent_too_old", () => {
  const nodes = [
    { id: "n1", name: "a", probe_methods: ["dns", "http", "icmp", "tcp"] },
    { id: "n2", name: "b", probe_methods: ["http", "icmp", "tcp"] },
  ] as never;
  const draft = { ...emptyDraft("dns"), target: "udp://9.9.9.9", dnsName: "example.org", assignAll: false, nodeIds: ["n1", "n2"] };
  assert.deepEqual(unsupportedSources(draft, nodes, true), [{ id: "n2", reason: "agent_too_old" }]);
});

/* ---- The definition editor ---- */

test("a dns definition takes resolver addresses and sends the question", () => {
  const draft = { ...withKind(emptyDefinitionDraft(), "dns"), sources: { nodes: ["n1"] }, addressText: "https://dns.example/dns-query\ntls://9.9.9.9", dnsName: "Example.org.", dnsExpect: "192.0.2.1" };
  assert.deepEqual(definitionProblems(draft, { newDefinition: true }), []);
  const save = buildDefinitionSave(draft, undefined, "x");
  assert.deepEqual(save.addresses, ["https://dns.example/dns-query", "tls://9.9.9.9"]);
  assert.equal(save.dns_name, "example.org");
  assert.deepEqual(save.dns_expect, ["192.0.2.1"]);
  assert.equal(suggestDefinitionName(draft, (id) => id, (id) => id, "fleet"), "DNS dns.example, 9.9.9.9");
  assert.ok(definitionProblems({ ...draft, addressText: "udp://10.0.0.1" }, { newDefinition: true }).includes("destination"));
  assert.ok(definitionProblems({ ...draft, addressText: "dns://9.9.9.9" }, { newDefinition: true }).includes("address"));
  assert.ok(definitionProblems({ ...draft, dnsName: "" }, { newDefinition: true }).includes("dnsName"));
  const tcp = buildDefinitionSave({ ...draft, type: "tcp", addressText: "example.com:443" }, undefined, "x");
  assert.equal(tcp.dns_name, undefined, "another method sends no dns field");
  const def = { ...save, id: "chk_1", version: 2, created_at: "", updated_at: "", summary: { monitors: 2, paths: 2, paused_targets: 0, paused_runs: 0 } } as never;
  const again = draftFromDefinition(def);
  assert.equal(again.dnsName, "example.org");
  assert.equal(again.dnsExpect, "192.0.2.1");
});
