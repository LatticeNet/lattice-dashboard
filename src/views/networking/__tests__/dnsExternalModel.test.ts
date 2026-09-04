import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { DNSDeploymentView } from "@/lib/api";
import {
  DNS_COLUMN_SIZING,
  buildExternalDnsBody,
  canPlanDeployment,
  canPublishDeployment,
  certExpiry,
  certVerdict,
  dnsHostnameSizing,
  dnsVisibleColumns,
  driftTone,
  externalHostnameProblem,
  formatListeners,
  isExternalHostnameValid,
  isObservedEngine,
  isObservedOnlyTable,
  listenSummary,
  listenerProcesses,
  lookupCertWatch,
  tlsTargetHost,
  reservedWidthPx,
  reservesWidth,
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

test("an uncheckable drift verdict is a warning, not a neutral badge", () => {
  assert.equal(driftTone("ok"), "success");
  assert.equal(driftTone("drift"), "destructive");
  assert.equal(driftTone("unknown"), "warning");
  assert.equal(driftTone(undefined), "warning");
});

// ── Deployments table layout ──────────────────────────────────────────────

test("the Reality column reserves width instead of only capping it", () => {
  // A cap lets auto layout squeeze the column to its longest word, which is
  // what shredded two drift findings over nine lines at 1440.
  assert.equal(reservesWidth(DNS_COLUMN_SIZING.reality), true);
  assert.ok(
    reservedWidthPx(DNS_COLUMN_SIZING.reality) >= 180,
    "the drift verdict and the certificate countdown need at least 180px",
  );
  // The space has to come from somewhere: the two mono columns that cannot
  // shrink on their own are capped so they stop hoarding it.
  assert.equal(reservesWidth(DNS_COLUMN_SIZING.node), false);
  assert.equal(reservesWidth(DNS_COLUMN_SIZING.hostname), false);
  assert.match(DNS_COLUMN_SIZING.node, /max-w-\[/);
  assert.match(DNS_COLUMN_SIZING.hostname, /max-w-\[/);
});

test("a max-width alone does not count as a reservation", () => {
  assert.equal(reservesWidth("max-w-[280px]"), false);
  assert.equal(reservesWidth("w-[280px]"), true);
  assert.equal(reservesWidth("min-w-[240px] max-w-[280px]"), true);
  assert.equal(reservesWidth(undefined), false);
  assert.equal(reservedWidthPx("max-w-[280px]"), 0);
  assert.equal(reservedWidthPx("w-[300px] min-w-[280px]"), 280);
});

test("DnsView gives the Reality column the reserved sizing and caps the columns it takes from", () => {
  // Grounding: the sizing constants are worth nothing if the table stops using
  // them, and a table-layout claim cannot be asserted any other way from here.
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  assert.match(view, /key:\s*"reality"[^]*?class:\s*DNS_COLUMN_SIZING\.reality/);
  assert.match(view, /key:\s*"node"[^]*?class:\s*DNS_COLUMN_SIZING\.node/);
  assert.match(view, /key:\s*"hostname"[^]*?class:\s*dnsHostnameSizing\(observedOnly\.value\)/);
  assert.doesNotMatch(view, /class:\s*"max-w-\[280px\]"/, "the Reality column is back on a bare cap");
});

test("the drift findings are rendered at the table's width, not inside the Reality column", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  const cell = view.slice(
    view.indexOf('#cell-reality='),
    view.indexOf('#row-detail='),
  );
  assert.ok(cell.length > 0, "DnsView no longer has a reality cell and a row-detail panel");
  assert.doesNotMatch(cell, /drift\.findings/, "the findings list is back inside the table cell");
  assert.match(cell, /driftFindingsToggle/, "the cell no longer offers a way to open the findings");

  const detail = view.slice(view.indexOf('#row-detail='));
  assert.match(detail, /v-for="\(finding, index\) in driftFindings\(dep\)"/);

  // The panel is inert unless DataTable is told which rows are open.
  assert.match(view, /:row-expanded="isDriftOpen"/);

  // DataTable has to carry the slot, or the panel renders nowhere.
  const table = readFileSync(new URL("../../../components/common/DataTable.vue", import.meta.url), "utf8");
  assert.match(table, /name="row-detail"/);
  assert.match(table, /:colspan="spannedColumns"/);
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

test("a table of nothing but observed records is observed-only, an empty one is not", () => {
  assert.equal(isObservedOnlyTable([observedRow, observedRow]), true);
  assert.equal(isObservedOnlyTable([observedRow, deployedRow]), false);
  assert.equal(isObservedOnlyTable([deployedRow]), false);
  // Nothing loaded is not the same claim as nothing deployed, and dropping
  // columns off an empty table would only make the header lie while it fills.
  assert.equal(isObservedOnlyTable([]), false);
});

test("the two intent columns leave an observed-only table, and nothing else does", () => {
  const kept = dnsVisibleColumns(allColumns, true).map((column) => column.key);
  assert.deepEqual(kept, ["name", "node", "listen", "exposure", "zones", "hostname", "status", "reality", "actions"]);
  assert.equal(kept.includes("credential"), false, "Credential prints one dot per observed row");
  assert.equal(kept.includes("published"), false, "Last publish attempt prints one dot per observed row");
  assert.deepEqual(dnsVisibleColumns(allColumns, false), allColumns, "a mixed table loses a column");
});

test("the hostname turns its ceiling into a floor once the intent columns are gone", () => {
  // The hostname is what a certificate watch is pointed at, so it is the value
  // the operator came to read; `resolver.xuezhan…` is not that value.
  const wide = dnsHostnameSizing(true);
  assert.equal(reservesWidth(wide), true, "the observed-only hostname column still only caps its width");
  assert.ok(reservedWidthPx(wide) >= 200, `reserved ${reservedWidthPx(wide)}px, too little for a real resolver name`);
  assert.match(wide, /whitespace-nowrap/);

  const capped = dnsHostnameSizing(false);
  assert.equal(reservesWidth(capped), false, "a mixed table lets the hostname take width from Reality");
  assert.equal(capped, DNS_COLUMN_SIZING.hostname);
});

test("DnsView renders the visible columns, and stops truncating the reserved hostname", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  assert.match(view, /:columns="visibleColumns"/);
  assert.match(view, /const visibleColumns = computed\(\(\) => dnsVisibleColumns\(columns\.value, observedOnly\.value\)\)/);
  const cell = view.slice(view.indexOf("#cell-hostname="), view.indexOf("#cell-status="));
  assert.match(cell, /observedOnly \? 'font-mono text-xs' : 'truncate font-mono text-xs'/);
});

// ── Who owns the expiry question ──────────────────────────────────────────

const NOW = new Date("2026-09-04T00:00:00Z");

/** The production watch: dns.roobli.org on the DoH port, failing under 30 days. */
const watch60 = { id: "mon_tls_dns", name: "dns.roobli.org certificate", type: "tls", target: "dns.roobli.org:8443", threshold_days: 60, enabled: true };
const watch7 = { ...watch60, id: "mon_tls_short", threshold_days: 7 };
const tcpMonitor = { id: "mon_tcp", name: "plain DNS", type: "tcp", target: "dns.roobli.org:53", enabled: true };

test("a tls target names a host, whatever port it was dialled on", () => {
  assert.equal(tlsTargetHost("dns.roobli.org:8443"), "dns.roobli.org");
  assert.equal(tlsTargetHost("DNS.Roobli.ORG:853"), "dns.roobli.org");
  // A bracketed literal keeps its address and loses the brackets, so it can be
  // compared with a hostname the same way everything else is.
  assert.equal(tlsTargetHost("[2606:4700::1111]:853"), "2606:4700::1111");
  assert.equal(tlsTargetHost(undefined), "");
});

test("the watch for a hostname is the enabled tls monitor pointed at it, and nothing else", () => {
  assert.equal(lookupCertWatch("dns.roobli.org", [tcpMonitor, watch60]).state, "watched");
  assert.equal(lookupCertWatch("DNS.roobli.org ", [watch60]).state, "watched");
  // A tcp probe on the same host is not a certificate watch.
  assert.equal(lookupCertWatch("dns.roobli.org", [tcpMonitor]).state, "unwatched");
  assert.equal(lookupCertWatch("dns.roobli.org", [{ ...watch60, enabled: false }]).state, "unwatched");
  assert.equal(lookupCertWatch("resolver.xuezhang.example", [watch60]).state, "unwatched");
  // No monitor list is not a claim that nothing watches: a token without
  // monitor:read cannot see one either way, and must not say so.
  assert.equal(lookupCertWatch("dns.roobli.org", undefined).state, "unknown");
  assert.equal(lookupCertWatch("", [watch60]).state, "unknown");
});

test("a missing threshold falls to the server's own default, not to no threshold", () => {
  const found = lookupCertWatch("dns.roobli.org", [{ ...watch60, threshold_days: undefined }]);
  assert.equal(found.state, "watched");
  assert.equal(found.thresholdDays, 14);
  assert.equal(lookupCertWatch("dns.roobli.org", [watch60]).thresholdDays, 60);
});

test("the row's verdict is the watch's verdict, so the two pages cannot disagree", () => {
  // 55 days left. The operator set the watch to 60, so the watch is failing;
  // the row used to print this in neutral grey against its own hard-coded 30.
  const cert = "2026-10-29T00:00:00Z";
  assert.equal(certVerdict(cert, NOW, lookupCertWatch("dns.roobli.org", [watch60])).tone, "warn");
  // The reverse: 25 days against a seven-day watch that is green. The row used
  // to go amber on its own.
  const nearer = "2026-09-29T00:00:00Z";
  assert.equal(certVerdict(nearer, NOW, lookupCertWatch("dns.roobli.org", [watch7])).tone, "ok");
});

test("an unwatched row states that, rather than inventing a verdict nothing acts on", () => {
  const none = lookupCertWatch("resolver.xuezhang.example", [watch60]);
  assert.equal(none.state, "unwatched");
  assert.equal(none.thresholdDays, 0);
  // 15 days left and nothing watching: neutral, with the row saying why.
  assert.equal(certVerdict("2026-09-19T00:00:00Z", NOW, none).tone, "ok");
  // An expiry already in the past is a fact and is still called out.
  assert.equal(certVerdict("2026-08-30T00:00:00Z", NOW, none).tone, "expired");
});

test("DnsView resolves the watch and links both directions", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  assert.match(view, /lookupCertWatch\(dep\.hostname, certWatches\.value\)/);
  assert.match(view, /certVerdict\(dep\.cert_not_after, new Date\(\), certWatch\(dep\)\)/);
  assert.doesNotMatch(view, /certExpiry\(/, "the row is judging the expiry on its own again");
  // Watched and unwatched look different, and both reach Monitoring.
  const cell = view.slice(view.indexOf("#cell-reality="), view.indexOf("#row-detail="));
  assert.match(cell, /certWatch\(dep\)\.state === 'watched'/);
  assert.match(cell, /certWatch\(dep\)\.state === 'unwatched'/);
  assert.match(cell, /name: 'monitor-detail'/);
  assert.match(cell, /name: 'monitoring'/);
  // And the create dialog's prose reference is a link the reader can follow.
  assert.match(view, /networking\.dns\.certWatchSetUp/);
});
