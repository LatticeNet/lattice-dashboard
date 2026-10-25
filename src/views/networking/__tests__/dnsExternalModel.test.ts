import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { DNSCertCheckView, DNSDeploymentView } from "@/lib/api";
import {
  buildExternalDnsBody,
  canPlanDeployment,
  canPublishDeployment,
  certExpiry,
  certVerdict,
  externalHostnameProblem,
  formatListeners,
  isExternalHostnameValid,
  isObservedEngine,
  listenSummary,
  certPortCandidates,
  certShown,
  linkedCertWatch,
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

test("the certificate countdown warns inside the window it was given and treats a zero time as unknown", () => {
  const now = new Date("2026-09-04T00:00:00Z");
  assert.deepEqual(certExpiry("2026-11-17T00:00:00Z", now, 30), { tone: "ok", days: 74 });
  assert.deepEqual(certExpiry("2026-09-20T00:00:00Z", now, 30), { tone: "warn", days: 16 });
  assert.deepEqual(certExpiry("2026-08-30T00:00:00Z", now, 30), { tone: "expired", days: -5 });
  // The window is the caller's, not this module's: the same date is a warning
  // against a sixty-day watch and fine against a seven-day one.
  assert.equal(certExpiry("2026-10-20T00:00:00Z", now, 60).tone, "warn");
  assert.equal(certExpiry("2026-10-20T00:00:00Z", now, 7).tone, "ok");
  // Go's zero time survives omitempty and must not read as a lapsed certificate.
  assert.deepEqual(certExpiry("0001-01-01T00:00:00Z", now, 30), { tone: "unknown", days: 0 });
  assert.deepEqual(certExpiry(undefined, now, 30), { tone: "unknown", days: 0 });
  assert.deepEqual(certExpiry("not a date", now, 30), { tone: "unknown", days: 0 });
});

// ── Deployments table layout ──────────────────────────────────────────────

test("DnsView's table holds the columns a resolver is compared by, and one row menu", () => {
  // Design 23, 4.4: eleven columns and four inline buttons became the row a
  // resolver is scanned by, with the rest in the sheet.
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  const block = view.slice(view.indexOf("const columns = computed"), view.indexOf("]);", view.indexOf("const columns = computed")));
  const keys = [...block.matchAll(/key: "(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "node", "listen", "hostname", "status", "reality", "actions"]);
  assert.match(block, /key: "actions"[^}]*pin: "end"/);
  const actions = view.slice(view.indexOf("#cell-actions="), view.indexOf("</DataTable>"));
  assert.match(actions, /<RowMenu\b/);
  assert.doesNotMatch(actions, /<Button\b/, "inline row buttons are back beside the menu");
});

test("the drift findings are read in the sheet, not squeezed into the Reality cell", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  const cell = view.slice(view.indexOf("#cell-reality="), view.indexOf("#cell-actions="));
  assert.ok(cell.length > 0, "DnsView no longer has a reality cell");
  assert.doesNotMatch(cell, /driftFindings|drift\.findings/, "the findings list is back inside the table cell");
  const sheet = view.slice(view.indexOf("<ObjectSheet"), view.indexOf("</ObjectSheet>"));
  assert.match(sheet, /v-for="\(finding, index\) in driftFindings\(openDep\)"/);
});

// ── The observed body ─────────────────────────────────────────────────────

const externalForm = {
  id: "dns_2",
  name: "lan resolver",
  node_id: "node_ob46mh4ltshdpkhc",
  hostname: " resolver.lan.example ",
  listeners: [{ protocol: "udp", port: "53" }, { protocol: "tcp", port: 6053 }],
  cert_not_after: "2026-11-17",
};

test("editing an observed record hands its exposure and zones back untouched", () => {
  // The server replaces rather than merges: an absent zones is nilled and an
  // absent exposure defaults to public, so a save from a form that shows
  // neither would silently publish a mesh-only resolver and drop its zones.
  const carried = {
    exposure: "mesh",
    zones: [
      { suffix: "lan.example", mode: "forward", upstreams: ["10.0.0.1"] },
      { suffix: "corp.example", mode: "block" },
    ],
  };
  const body = buildExternalDnsBody(externalForm, carried);
  assert.equal(body.exposure, "mesh");
  assert.deepEqual(body.zones, carried.zones);
  assert.equal(body.id, "dns_2");
  assert.equal(body.engine, "external");
  assert.equal(body.hostname, "resolver.lan.example");
  assert.deepEqual(body.listeners, [
    { protocol: "udp", port: 53 },
    { protocol: "tcp", port: 6053 },
  ]);
  assert.equal(body.cert_not_after, "2026-11-17T00:00:00Z");
});

test("a new observed record carries nothing and lets the server default", () => {
  const body = buildExternalDnsBody({ ...externalForm, id: undefined, cert_not_after: "" });
  assert.equal(body.exposure, "public");
  assert.deepEqual(body.zones, []);
  assert.equal("id" in body, false);
  assert.equal("cert_not_after" in body, false);
});

test("an exposure the server would refuse is not passed back through", () => {
  // Failing the whole save over a field the form never showed is worse than
  // the server's own default.
  const body = buildExternalDnsBody(externalForm, { exposure: "internal", zones: [] });
  assert.equal(body.exposure, "public");
  assert.equal(buildExternalDnsBody(externalForm, { exposure: " PUBLIC ", zones: [] }).exposure, "public");
  assert.equal(buildExternalDnsBody(externalForm, { exposure: " Mesh ", zones: [] }).exposure, "mesh");
});

test("DnsView builds the observed body through the carrying builder", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  assert.match(view, /buildExternalDnsBody\(/);
  assert.doesNotMatch(view, /exposure:\s*"public",\s*\n\s*zones:\s*\[\],/, "the observed body still hard-codes both fields");
});

// ── The observed hostname ─────────────────────────────────────────────────

test("an unqualified observed hostname is named as such, not just marked red", () => {
  assert.equal(externalHostnameProblem("dns-malibu"), "not_fqdn");
  assert.equal(externalHostnameProblem("  "), "empty");
  assert.equal(externalHostnameProblem(""), "empty");
  assert.equal(externalHostnameProblem(" dns.roobli.org "), undefined);
  assert.equal(isExternalHostnameValid("dns-malibu"), false);
  assert.equal(isExternalHostnameValid("dns.roobli.org"), true);
});

test("the observed hostname field says what is wrong and points a reader at it", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  // A red border with no message is not a message. The listener port and the
  // TLS target already do this; the hostname was the one field that did not.
  assert.match(view, /errExternalHostname/, "the hostname field still has no error string");
  assert.match(view, /id="dns-external-hostname-error"/);
  assert.match(view, /role="alert"/);
  assert.match(view, /:aria-describedby="externalHostnameError \? 'dns-external-hostname-error' : undefined"/);
  assert.match(view, /externalHostnameError/);
});

// ── An observed-only table ────────────────────────────────────────────────

const observedRow = { engine: "external" };
const deployedRow = { engine: "coredns" };
const allColumns = [
  { key: "name" },
  { key: "node" },
  { key: "listen" },
  { key: "exposure" },
  { key: "zones" },
  { key: "hostname" },
  { key: "status" },
  { key: "reality" },
  { key: "credential" },
  { key: "published" },
  { key: "actions" },
];

test("the hostname cell prints the whole hostname", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  const cell = view.slice(view.indexOf("#cell-hostname="), view.indexOf("#cell-status="));
  assert.ok(cell.length > 0);
  assert.doesNotMatch(cell, /truncate/, "the hostname cell clips again");
  assert.doesNotMatch(cell, /:title=/, "a tooltip is back standing in for the value");
});

// ── Which expiry, and who judges it ───────────────────────────────────────

const NOW = new Date("2026-09-04T00:00:00Z");

/** The production watch: dns.roobli.org on the DoH port, linked to the record. */
const watch60: DNSCertCheckView = {
  monitor_id: "mon_tls_dns",
  name: "operator dnsproxy certificate (dns.roobli.org:8443)",
  target: "dns.roobli.org:8443",
  threshold_days: 60,
  enabled: true,
};
const watch7: DNSCertCheckView = { ...watch60, monitor_id: "mon_tls_short", threshold_days: 7 };

test("the sheet prefers the measured expiry over the typed date, and says which it shows", () => {
  const measured = { ...watch60, cert_not_after: "2027-01-20T00:00:00Z", measured_at: "2026-09-03T12:00:00Z" };
  // Measured later than the typed date: the endpoint's certificate is the
  // truth, not the sooner of the two.
  const shown = certShown({
    cert_not_after: "2026-11-17T00:00:00Z",
    cert_checks: [measured],
    cert_expiry: { not_after: "2027-01-20T00:00:00Z", source: "measured", monitor_id: "mon_tls_dns" },
  });
  assert.equal(shown.source, "measured");
  assert.equal(shown.notAfter, "2027-01-20T00:00:00Z");
  assert.equal(shown.check?.monitor_id, "mon_tls_dns");

  // Nothing measured yet: the typed date, labelled as typed.
  const typed = certShown({ cert_not_after: "2026-11-17T00:00:00Z", cert_expiry: { not_after: "2026-11-17T00:00:00Z", source: "typed" } });
  assert.deepEqual(typed, { notAfter: "2026-11-17T00:00:00Z", source: "typed" });
  // An answer without the choice still shows the typed field as typed.
  assert.equal(certShown({ cert_not_after: "2026-11-17T00:00:00Z" }).source, "typed");
  // A zero time from Go is no date at all.
  assert.deepEqual(certShown({ cert_not_after: "0001-01-01T00:00:00Z" }), { notAfter: "", source: "none" });
  assert.deepEqual(certShown({}), { notAfter: "", source: "none" });
});

test("the watch is a linked check, found through the link and never by hostname", () => {
  assert.equal(linkedCertWatch({ cert_checks: [watch60] }, true).state, "watched");
  // Nothing linked, or only a paused check: nothing judges the expiry.
  assert.equal(linkedCertWatch({ cert_checks: [] }, true).state, "unwatched");
  assert.equal(linkedCertWatch({}, true).state, "unwatched");
  assert.equal(linkedCertWatch({ cert_checks: [{ ...watch60, enabled: false }] }, true).state, "unwatched");
  // Without monitor:read the page cannot know, and must not say "unwatched".
  assert.equal(linkedCertWatch({ cert_checks: [watch60] }, false).state, "unknown");
  // The check that measured the shown expiry judges it.
  const both = linkedCertWatch(
    { cert_checks: [watch7, watch60], cert_expiry: { not_after: "2027-01-20T00:00:00Z", source: "measured", monitor_id: "mon_tls_dns" } },
    true,
  );
  assert.equal(both.check?.monitor_id, "mon_tls_dns");
  assert.equal(both.thresholdDays, 60);
  // A missing threshold falls to the server's own default, not to no threshold.
  assert.equal(linkedCertWatch({ cert_checks: [{ ...watch60, threshold_days: 0 }] }, true).thresholdDays, 14);
});

test("the row's verdict is the linked check's verdict, so the two pages cannot disagree", () => {
  // 55 days left against a 60-day check: the check is failing, and so is the row.
  const cert = "2026-10-29T00:00:00Z";
  assert.equal(certVerdict(cert, NOW, linkedCertWatch({ cert_checks: [watch60] }, true)).tone, "warn");
  // 25 days against a seven-day check that is green.
  const nearer = "2026-09-29T00:00:00Z";
  assert.equal(certVerdict(nearer, NOW, linkedCertWatch({ cert_checks: [watch7] }, true)).tone, "ok");
});

test("an unwatched row states that, rather than inventing a verdict nothing acts on", () => {
  const none = linkedCertWatch({ cert_checks: [] }, true);
  assert.equal(none.thresholdDays, 0);
  // 15 days left and nothing watching: neutral, with the row saying why.
  assert.equal(certVerdict("2026-09-19T00:00:00Z", NOW, none).tone, "ok");
  // An expiry already in the past is a fact and is still called out.
  assert.equal(certVerdict("2026-08-30T00:00:00Z", NOW, none).tone, "expired");
});

test("a measure offers every tcp listener and ticks the ones that look like DoT or DoH", () => {
  const dep = {
    hostname: "DNS.roobli.org",
    listeners: [
      { protocol: "udp", port: 53 },
      { protocol: "tcp", port: 53 },
      { protocol: "udp", port: 2053 },
      { protocol: "tcp", port: 2053 },
      { protocol: "tcp", port: 8443 },
    ],
    cert_checks: [{ ...watch60, target: "dns.roobli.org:8443" }],
  };
  const candidates = certPortCandidates(dep);
  assert.deepEqual(
    candidates.map((c) => [c.port, c.suggested, c.measuredBy?.monitor_id]),
    [
      [53, false, undefined],
      // Plain DNS answers on udp and tcp alike; a TLS listener is tcp alone.
      [2053, false, undefined],
      [8443, true, "mon_tls_dns"],
    ],
  );
  assert.deepEqual(certPortCandidates({ hostname: "dns.roobli.org", listeners: [{ protocol: "udp", port: 853 }] }), []);
});

test("DnsView reads the watch through the link and offers the measure", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  assert.match(view, /linkedCertWatch\(dep, canReadMonitors\.value\)/);
  assert.match(view, /certVerdict\(certShown\(dep\)\.notAfter, new Date\(\), certWatch\(dep\)\)/);
  assert.doesNotMatch(view, /lookupCertWatch|tlsTargetHost/, "the page matches checks by hostname again");
  assert.doesNotMatch(view, /certExpiry\(/, "the row is judging the expiry on its own again");
  const sheet = view.slice(view.indexOf("<ObjectSheet"), view.indexOf("</ObjectSheet>"));
  assert.match(sheet, /certShown\(openDep\)\.source === 'measured'/, "the sheet no longer says which expiry it shows");
  assert.match(sheet, /certWatch\(openDep\)\.state === 'unwatched'/);
  assert.match(sheet, /openMeasure\(openDep\)/);
  assert.match(sheet, /name: 'monitor-detail'/);
  assert.match(sheet, /name: 'monitoring'/);
  assert.match(view, /api\.dns\.measureCert\(dep\.id, measurePorts\.value\)/);
  // And the create dialog's prose reference is a link the reader can follow.
  assert.match(view, /networking\.dns\.certWatchSetUp/);
});
