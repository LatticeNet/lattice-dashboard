import assert from "node:assert/strict";
import test from "node:test";

import type { Node } from "../api/types.ts";
import { evalFilterExpression } from "../filterExpressions.ts";
import { nodeMatchesTargetToken } from "../nodeFilterExpressions.ts";
import { completeQuery } from "../query/complete.ts";
import { applyQuery, compileQuery, describeFields, type CompiledQuery, type QuerySchema } from "../query/engine.ts";
import { nodeQuerySchema } from "../query/nodeFields.ts";
import { parseQuery, withoutSorts, type QueryNode } from "../query/syntax.ts";
import { compareVersions, parseDuration, parseNumber } from "../query/values.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function node(over: Partial<Node>): Node {
  return { id: over.name ?? "n", name: "n", online: true, status: "online", last_seen: ago(5), ...over } as Node;
}

const FLEET: Node[] = [
  node({
    id: "n-hk",
    name: "[cd]-gomami-hkg",
    tags: ["edge", "cd"],
    role: "relay",
    public_ip: "203.0.113.10",
    public_ipv6: "2001:db8::10",
    agent_version: "0.3.10",
    host_facts: { os: "linux", platform: "debian", platform_version: "12", arch: "amd64", hostname: "gomami" },
    geo: { country: "HK", region: "Hong Kong", city: "Kowloon", provider: "Gomami", as_org: "GOMAMI-AS", asn: 64500 },
    metrics: { cpu_percent: 91.4, memory_used: 6, memory_total: 8, disk_used: 10, disk_total: 100, load1: 2.5, net_rx_speed: 12 * 1024 ** 2, net_tx_speed: 1024, uptime_seconds: 4 * 86400 },
    agent_runtime: { allow_exec: true, allow_root_exec: true, allow_terminal: true, terminal_transport: "stream", singbox_discover: true },
    agent_source_allowlist: ["https://github.com/"],
    group_ids: ["g1"],
  }),
  node({
    id: "n-fsn",
    name: "[cd]-hetzner-fsn",
    tags: ["core"],
    public_ip: "198.51.100.7",
    agent_version: "0.3.9",
    host_facts: { os: "linux", platform: "ubuntu", arch: "arm64" },
    geo: { country: "DE", region: "Saxony", city: "Falkenstein", provider: "Hetzner" },
    metrics: { cpu_percent: 12, memory_used: 1, memory_total: 4, disk_used: 90, disk_total: 100, load1: 0.2, uptime_seconds: 3600 },
    agent_runtime: { allow_exec: true, allow_terminal: true, terminal_transport: "poll", singbox_discover: false },
    agent_launch: { singbox_discover: true },
  }),
  node({
    id: "n-mac",
    name: "studio-mac",
    tags: ["home"],
    internal_ip: "10.0.0.20",
    agent_version: "0.3.10-alpha.2",
    host_facts: { os: "darwin", platform: "darwin", arch: "arm64" },
    metrics: { cpu_percent: 40 },
  }),
  node({
    id: "n-dmit",
    name: "DMIT-4",
    status: "offline",
    online: false,
    last_seen: ago(6 * 86400),
    tags: ["edge"],
    agent_version: "0.3.8",
    host_facts: { os: "linux", arch: "amd64" },
    metrics: { cpu_percent: 10 },
  }),
  node({ id: "n-new", name: "fresh-box", status: "never_reported", online: false, last_seen: undefined }),
];

const groups: Record<string, string> = { g1: "Asia relays" };
const schema = nodeQuerySchema({ groupName: (id) => groups[id] });

function run(query: string, rows: readonly Node[] = FLEET): string[] {
  const compiled = compileQuery(query, schema);
  if (!compiled.ok) throw new Error(`${query}: ${compiled.error.code} at ${compiled.error.start}`);
  return applyQuery(rows, compiled.query, NOW).map((n) => n.id);
}

function errorOf(query: string) {
  const compiled = compileQuery(query, schema);
  assert.equal(compiled.ok, false, `${query} should be refused`);
  return (compiled as { ok: false; error: { code: string; start: number; end: number; params?: Record<string, unknown> } }).error;
}

/** The tree without offsets, as nested arrays: easier to read in a failure. */
function shape(node: QueryNode | null): unknown {
  if (!node) return null;
  switch (node.kind) {
    case "and":
    case "or":
      return [node.kind, ...node.items.map(shape)];
    case "not":
      return ["not", shape(node.item)];
    case "text":
      return node.quoted ? `"${node.value}"` : node.value;
    case "term":
      return `${node.field}${node.op}${node.values.map((v) => v.text).join(",")}`;
  }
}

function tree(query: string): unknown {
  const parsed = parseQuery(query);
  assert.ok(parsed.ok, `${query} should parse`);
  return shape(parsed.tree);
}

/* ------------------------------------------------------------------ */
/* Grammar                                                             */
/* ------------------------------------------------------------------ */

test("space is AND, OR and | bind tighter, parentheses group", () => {
  assert.deepEqual(tree("a b"), ["and", "a", "b"]);
  assert.deepEqual(tree("a AND b"), ["and", "a", "b"]);
  assert.deepEqual(tree("a b OR c"), ["and", "a", ["or", "b", "c"]]);
  assert.deepEqual(tree("a | b c"), ["and", ["or", "a", "b"], "c"]);
  assert.deepEqual(tree("(a b) OR c"), ["or", ["and", "a", "b"], "c"]);
  assert.deepEqual(tree("x OR (a b)"), ["or", "x", ["and", "a", "b"]]);
});

test("-term, -(group) and NOT term negate; a minus inside a word is a character", () => {
  assert.deepEqual(tree("-a b"), ["and", ["not", "a"], "b"]);
  assert.deepEqual(tree("-(a OR b)"), ["not", ["or", "a", "b"]]);
  assert.deepEqual(tree("NOT a b"), ["and", ["not", "a"], "b"]);
  assert.deepEqual(tree("sing-box -cap:root"), ["and", "sing-box", ["not", "cap:root"]]);
});

test("field terms: operators, comma lists and quoted values", () => {
  assert.deepEqual(tree("cpu>80 cpu:>=80% mem<=50 disk<10 name:=a ip=1"), ["and", "cpu>80", "cpu>=80%", "mem<=50", "disk<10", "name=a", "ip=1"]);
  assert.deepEqual(tree("status:offline,degraded"), "status:offline,degraded");
  assert.deepEqual(tree('name:"edge sg" "OR"'), ["and", "name:edge sg", '"OR"']);
  // Text, not fields: a quoted key, an IPv6 address, host:port with a dotted host.
  assert.deepEqual(tree('"node:x" 2001:db8::1 example.com:443'), ["and", '"node:x"', "2001:db8::1", "example.com:443"]);
});

test("sort: is pulled out of the top level, in order, and refused anywhere else", () => {
  const parsed = parseQuery("tag:edge sort:-cpu sort:name,-last_seen");
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.sorts.map((s) => [s.field, s.desc]), [["cpu", true], ["name", false], ["last_seen", true]]);
  assert.deepEqual(shape(parsed.tree), "tag:edge");
  for (const nested of ["(sort:cpu)", "a OR sort:cpu", "sort:cpu OR a", "-sort:cpu", "OR(a, sort:cpu)"]) {
    const result = parseQuery(nested);
    assert.equal(result.ok, false, nested);
    assert.equal(!result.ok && result.error.code, "sortNested", nested);
  }
});

test("withoutSorts takes the sort terms out and keeps the rest as typed", () => {
  assert.equal(withoutSorts("tag:edge sort:-cpu cpu>80 sort:name,-id"), "tag:edge cpu>80");
  assert.equal(withoutSorts("sort:cpu"), "");
  assert.equal(withoutSorts('name:"a  b" sort:cpu'), 'name:"a  b"', "spaces inside quotes are left alone");
  assert.equal(withoutSorts("sort:cpu tag:edge"), "tag:edge");
  assert.equal(withoutSorts("cpu> sort:cpu"), "cpu>", "a query that does not parse still loses its sort words");
});

test("errors carry the code and the offending span", () => {
  const cases: [string, string, number, number][] = [
    ["(a b", "unclosedParen", 0, 1],
    ["a b)", "unexpectedParen", 3, 4],
    ['name:"edge', "unclosedQuote", 5, 10],
    ["a OR", "danglingOperator", 2, 4],
    ["OR a", "danglingOperator", 0, 2],
    ["a | | b", "danglingOperator", 2, 3],
    ["a AND", "danglingOperator", 2, 5],
    ["a -", "nothingToNegate", 2, 3],
    ["()", "emptyGroup", 0, 2],
    ["a, b", "strayComma", 1, 2],
    ["NOT(a, b)", "notArity", 0, 9],
    ["AND()", "callArity", 0, 5],
    ["status:offline,", "emptyValue", 14, 15],
  ];
  for (const [query, code, start, end] of cases) {
    const parsed = parseQuery(query);
    assert.equal(parsed.ok, false, query);
    if (parsed.ok) continue;
    assert.deepEqual([parsed.error.code, parsed.error.start, parsed.error.end], [code, start, end], query);
  }
});

/* ------------------------------------------------------------------ */
/* The old forms                                                       */
/* ------------------------------------------------------------------ */

test("every old call form parses as it did", () => {
  assert.deepEqual(tree("AND(exec, root, NOT(sing-box))"), ["and", "exec", "root", ["not", "sing-box"]]);
  assert.deepEqual(tree("OR(linux, darwin, amd64, arm64)"), ["or", "linux", "darwin", "amd64", "arm64"]);
  assert.deepEqual(tree("AND(cd)"), "cd");
  assert.deepEqual(tree("and(a,b)"), ["and", "a", "b"]);
  assert.deepEqual(tree("Or(a , b)"), ["or", "a", "b"]);
  assert.deepEqual(tree("NOT (x)"), ["not", "x"]);
  assert.deepEqual(tree("AND (a, b)"), ["and", "a", "b"]);
  // Empty arguments were dropped.
  assert.deepEqual(tree("OR(a,,b,)"), ["or", "a", "b"]);
  // Inside a call the comma separates arguments, never a value list.
  assert.deepEqual(tree("AND(agent:exec,tag:cd)"), ["and", "agent:exec", "tag:cd"]);
  assert.deepEqual(tree("OR(tag:a,b)"), ["or", "tag:a", "b"]);
  assert.deepEqual(tree("AND(agent:exec, tag:cd, region:HK)"), ["and", "agent:exec", "tag:cd", "region:HK"]);
  assert.deepEqual(tree("OR(AND(a, b), NOT(c))"), ["or", ["and", "a", "b"], ["not", "c"]]);
});

test("the old errors are still errors", () => {
  for (const [query, oldError] of [
    ["NOT(a, b)", "NOT expects exactly one expression"],
    ["NOT()", "NOT expects exactly one expression"],
    ["AND()", "AND expects at least one expression"],
    ["OR()", "OR expects at least one expression"],
    ["AND(a", "Unclosed parenthesis"],
    ["AND(a))", "Unexpected closing parenthesis"],
  ] as const) {
    assert.equal(evalFilterExpression(query, () => true).error, oldError);
    assert.equal(parseQuery(query).ok, false, query);
  }
});

/**
 * The task target filter's prefixed tokens (agent:, config:, os:, arch:,
 * tag:, role:, region:, name:) inside every call form: the new evaluator
 * picks the same nodes the old one did.
 */
test("old target expressions select the same nodes", () => {
  const corpus = [
    "AND(agent:exec, tag:cd, region:HK)",
    "AND(agent:exec, agent:root)",
    "OR(agent:stream, agent:poll)",
    "NOT(agent:root)",
    "AND(config:terminal, NOT(config:stream))",
    "OR(os:darwin, os:amd64)",
    "os:macos",
    "AND(tag:edge, NOT(role:relay))",
    "OR(region:hk, region:saxony)",
    "AND(name:hetzner, os:linux)",
    "AND(OR(tag:edge, tag:home), NOT(agent:singbox))",
    "agent:sing-box",
    "agent:no-source",
    "AND(agent:singbox-drift)",
  ];
  for (const query of corpus) {
    const before = FLEET.filter((n) => evalFilterExpression(query, (token) => nodeMatchesTargetToken(n, token)).value).map((n) => n.id);
    assert.deepEqual(run(query).sort(), before.sort(), query);
  }
});

/* ------------------------------------------------------------------ */
/* Field types                                                         */
/* ------------------------------------------------------------------ */

test("string and list fields: contains, exact, wildcard and aliases", () => {
  assert.deepEqual(run("name:hetz"), ["n-fsn"]);
  assert.deepEqual(run("name:=studio-mac"), ["n-mac"]);
  assert.deepEqual(run("name:=studio"), []);
  assert.deepEqual(run("name:*-fsn"), ["n-fsn"]);
  assert.deepEqual(run("name:[cd]*").sort(), ["n-fsn", "n-hk"]);
  assert.deepEqual(run("tag:edge").sort(), ["n-dmit", "n-hk"]);
  assert.deepEqual(run("tag:relay"), ["n-hk"], "role counts as a tag");
  assert.deepEqual(run("ip:2001:db8"), ["n-hk"], "IPv6 addresses are searched");
  assert.deepEqual(run("ip:10.0.*"), ["n-mac"]);
  assert.deepEqual(run("os:macos"), ["n-mac"], "mac aliases darwin");
  assert.deepEqual(run("os:amd64").sort(), ["n-dmit", "n-hk"], "os: still reads the arch, as ?os=amd64 did");
  assert.deepEqual(run("group:asia"), ["n-hk"]);
  assert.deepEqual(run("provider:hetzner"), ["n-fsn"]);
  assert.deepEqual(run("provider:AS64500"), ["n-hk"]);
  assert.deepEqual(run("region:kowloon"), ["n-hk"]);
});

test("enum fields check the word against the vocabulary", () => {
  assert.deepEqual(run("status:offline"), ["n-dmit"]);
  assert.deepEqual(run("status:never"), ["n-new"], "never stands for never_reported");
  assert.deepEqual(run("status:offline,never").sort(), ["n-dmit", "n-new"]);
  assert.deepEqual(run("cap:singbox"), ["n-hk"], "singbox is not singbox-drift");
  assert.deepEqual(run("cap:drift"), ["n-fsn"]);
  assert.deepEqual(run("cap:sing-box"), ["n-hk"]);
  const error = errorOf("status:ofline");
  assert.equal(error.code, "unknownValue");
  assert.deepEqual([error.start, error.end], [7, 13]);
  assert.match(String(error.params?.values), /never_reported/);
});

test("flags and bool fields", () => {
  assert.deepEqual(run("is:offline"), ["n-dmit"]);
  assert.deepEqual(run("is:never"), ["n-new"]);
  assert.deepEqual(run("-is:online").sort(), ["n-dmit", "n-new"]);
  assert.deepEqual(run("is:drift"), ["n-fsn"]);
  assert.deepEqual(run("online:no").sort(), ["n-dmit", "n-new"]);
  assert.equal(errorOf("is:onlin").code, "unknownFlag");
  assert.equal(errorOf("is:onlin").params?.suggestion, "online");
  assert.equal(errorOf("online:maybe").code, "badBool");
});

test("numbers take the field's unit, and stale metrics are not readings", () => {
  assert.deepEqual(run("cpu>80"), ["n-hk"]);
  assert.deepEqual(run("cpu>=40%").sort(), ["n-hk", "n-mac"]);
  assert.deepEqual(run("cpu<20"), ["n-fsn"], "DMIT-4 is offline: its 10% is a memory");
  assert.deepEqual(run("cpu:40"), ["n-mac"]);
  assert.deepEqual(run("mem>50"), ["n-hk"]);
  assert.deepEqual(run("disk>=90"), ["n-fsn"]);
  assert.deepEqual(run("load>1"), ["n-hk"]);
  assert.deepEqual(run("rx>10MiB"), ["n-hk"]);
  assert.deepEqual(run("rx>10MiB/s"), ["n-hk"]);
  assert.deepEqual(run("tx<2k"), ["n-hk"]);
  const error = errorOf("tag:edge cpu>eighty");
  assert.deepEqual([error.code, error.start, error.end], ["badNumber", 13, 19]);
  assert.equal(errorOf("cpu>80MiB").code, "badNumber");
  assert.equal(errorOf("name>3").code, "noCompare");
});

test("durations and times: ages and dates", () => {
  assert.deepEqual(run("uptime>3d"), ["n-hk"]);
  assert.deepEqual(run("uptime<2h"), ["n-fsn"]);
  assert.deepEqual(run("uptime>1h30m"), ["n-hk"]);
  assert.deepEqual(run("last_seen>1d"), ["n-dmit"], "longer ago than a day");
  assert.deepEqual(run("last_seen<1m").sort(), ["n-fsn", "n-hk", "n-mac"]);
  assert.deepEqual(run("last_seen<2026-10-05"), ["n-dmit"]);
  assert.deepEqual(run("seen>=2026-10-08T11:00Z").sort(), ["n-fsn", "n-hk", "n-mac"]);
  assert.equal(errorOf("uptime:3d").code, "needsCompare");
  assert.equal(errorOf("uptime>3days").code, "badDuration");
  assert.equal(errorOf("last_seen>yesterday").code, "badTime");
});

test("versions compare by segment", () => {
  assert.equal(compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersions("v0.3.9", "0.3.9"), 0);
  assert.equal(compareVersions("0.3.10-alpha.2", "0.3.10"), -1);
  assert.deepEqual(run("agent<0.3.10").sort(), ["n-dmit", "n-fsn", "n-mac"]);
  assert.deepEqual(run("agent>=0.3.10"), ["n-hk"]);
  assert.deepEqual(run("agent:0.3.1"), ["n-hk", "n-mac"]);
  assert.deepEqual(run("agent:exec").sort(), ["n-fsn", "n-hk"], "agent:exec is still the capability");
  assert.equal(errorOf("agent>latest").code, "badVersion");
});

test("unknown fields are errors with a suggestion; IPv6 stays text", () => {
  const error = errorOf("tag:edge stauts:offline");
  assert.deepEqual([error.code, error.start, error.end, error.params?.suggestion], ["unknownField", 9, 15, "status"]);
  assert.deepEqual(run("fe80::1"), []);
  assert.deepEqual(run("2001:db8::10"), ["n-hk"]);
  assert.equal(errorOf("sort:cpuu").code, "unknownSort");
  assert.equal(errorOf("sort:cpuu").params?.suggestion, "cpu");
  assert.equal(errorOf("sort:online").code, "unknownSort", "flags do not sort");
});

/* ------------------------------------------------------------------ */
/* Text, relevance and sort                                            */
/* ------------------------------------------------------------------ */

test("a bare word is the fuzzy search the Nodes page had", () => {
  assert.deepEqual(run("gmhk"), ["n-hk"], "subsequence");
  assert.deepEqual(run("hetzner"), ["n-fsn"]);
  assert.deepEqual(run("mac"), ["n-mac"], "a name and the darwin alias");
  assert.deepEqual(run("exec").sort(), ["n-fsn", "n-hk"], "a capability word finds the capability");
  assert.deepEqual(run("203.0.113"), ["n-hk"]);
  assert.deepEqual(run('"gomami-hkg"'), ["n-hk"]);
  assert.deepEqual(run('"gmhk"'), [], "a quoted word is not fuzzy");
});

test("a negated bare word is a substring, not a subsequence", () => {
  // "fsn" is a subsequence of "[cd]-hetzner-fsn" and of nothing else as a substring.
  assert.deepEqual(run("-fsn").sort(), ["n-dmit", "n-hk", "n-mac", "n-new"]);
  // "dmt" is a subsequence of "dmit-4"; negated it must not drop DMIT-4.
  assert.ok(run("-dmt").includes("n-dmit"));
});

test("relevance floats exact and prefix matches without a sort", () => {
  const rows = [node({ id: "a", name: "xx-edge-yy" }), node({ id: "b", name: "edge" }), node({ id: "c", name: "edgerunner" })];
  assert.deepEqual(run("edge", rows), ["b", "c", "a"]);
});

test("sort: orders by type, repeats break ties, and missing values go last", () => {
  assert.deepEqual(run("sort:-cpu"), ["n-hk", "n-mac", "n-fsn", "n-dmit", "n-new"]);
  assert.deepEqual(run("sort:cpu"), ["n-fsn", "n-mac", "n-hk", "n-dmit", "n-new"]);
  assert.deepEqual(run("sort:-agent"), ["n-hk", "n-mac", "n-fsn", "n-dmit", "n-new"], "0.3.10 above its alpha, above 0.3.9");
  assert.deepEqual(run("sort:status").slice(0, 2), ["n-new", "n-dmit"], "attention order");
  assert.deepEqual(run("sort:-last_seen").at(-1), "n-new");
  assert.deepEqual(run("tag:edge sort:name"), ["n-hk", "n-dmit"]);
  // Two keys: arch first, then the name inside each arch.
  assert.deepEqual(run("sort:arch,name -is:never"), ["n-hk", "n-dmit", "n-fsn", "n-mac"]);
  assert.deepEqual(run("sort:arch sort:-name -is:never"), ["n-dmit", "n-hk", "n-mac", "n-fsn"]);
});

test("an empty query keeps every row in the page's order", () => {
  const compiled = compileQuery("   ", schema) as { ok: true; query: CompiledQuery<Node> };
  assert.ok(compiled.ok && compiled.query.empty);
  assert.deepEqual(applyQuery(FLEET, compiled.query, NOW), FLEET);
});

test("the value parsers", () => {
  assert.equal(parseNumber("80%", "percent"), 80);
  assert.equal(parseNumber("80", "percent"), 80);
  assert.equal(parseNumber("1.5GB", "bytes"), 1.5e9);
  assert.equal(parseNumber("2GiB", "bytes"), 2 * 1024 ** 3);
  assert.equal(parseNumber("10MBps", "rate"), 10e6);
  assert.equal(parseNumber("10%", "plain"), undefined);
  assert.equal(parseDuration("90"), 90);
  assert.equal(parseDuration("1w2d"), 9 * 86400);
  assert.equal(parseDuration("2 hours"), undefined);
});

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

test("completion: field names, is:, sort: and values", () => {
  const fields = describeFields(schema, FLEET);
  const labels = (input: string, caret = input.length) => completeQuery(input, caret, fields).items.map((item) => item.label);

  assert.deepEqual(labels("sta").slice(0, 1), ["status"]);
  assert.ok(labels("seen").includes("last_seen"), "aliases find their field");
  assert.equal(completeQuery("cp", 2, fields).items[0]!.insert, "cpu>", "a number field opens with a comparison");
  assert.equal(completeQuery("st", 2, fields).items.find((i) => i.label === "status")!.insert, "status:");
  assert.deepEqual(labels("is:off"), ["is:offline"]);
  assert.deepEqual(completeQuery("offl", 4, fields).items[0], { label: "is:offline", insert: "is:offline ", kind: "flag", hint: "common.listQuery.fields.offline", type: "bool" }, "a flag field completes as is:");
  assert.deepEqual(labels("sort:-cp"), ["sort:-cpu"]);
  assert.deepEqual(labels("tag:ed"), ["edge"]);
  assert.deepEqual(labels("tag:e"), ["edge", "core", "home", "relay"], "prefix matches first");
  assert.deepEqual(labels("status:offline,nev"), ["never_reported"]);
  const value = completeQuery("tag:edge status:offline,ne", 26, fields);
  assert.equal(value.start, 24, "a list member replaces only itself");
  assert.deepEqual(labels("group:"), ["Asia relays"]);
  assert.equal(completeQuery("group:", 6, fields).items[0]!.insert, '"Asia relays" ', "values with spaces are quoted");
  assert.deepEqual(labels("cpu>"), [], "numbers have no value list");
  assert.deepEqual(labels(""), []);
  assert.deepEqual(labels('name:"a'), []);
  // Mid-query, after a minus: the word, not the minus, is replaced.
  const mid = completeQuery("tag:edge -is:of sort:cpu", 15, fields);
  assert.deepEqual([mid.items[0]!.label, mid.start, mid.end], ["is:offline", 13, 15]);
});

test("a schema of plain records works the same way", () => {
  interface Row {
    host: string;
    port: number[];
    up: boolean;
  }
  const rows: Row[] = [
    { host: "a", port: [22, 58394], up: true },
    { host: "b", port: [22], up: false },
    { host: "c", port: [], up: true },
  ];
  const s: QuerySchema<Row> = {
    fields: [
      { key: "host", type: "string", get: (r) => r.host },
      { key: "port", type: "number", get: (r) => r.port },
      { key: "up", type: "bool", flag: true, get: (r) => r.up },
    ],
    text: (r) => [r.host],
  };
  const ids = (q: string) => {
    const c = compileQuery(q, s);
    assert.ok(c.ok, q);
    return applyQuery(rows, (c as { ok: true; query: CompiledQuery<Row> }).query).map((r) => r.host);
  };
  assert.deepEqual(ids("port:22"), ["a", "b"]);
  assert.deepEqual(ids("port>1024"), ["a"]);
  assert.deepEqual(ids("-port:22"), ["c"]);
  assert.deepEqual(ids("is:up sort:-port"), ["a", "c"]);
});

test("a page field shadows a shared field of the same name, and the menu offers it once", () => {
  interface Row {
    region: string;
    geo: string;
  }
  const rows: Row[] = [
    { region: "LA", geo: "us" },
    { region: "Tokyo", geo: "jp" },
  ];
  const s: QuerySchema<Row> = {
    fields: [
      { key: "region", type: "string", get: (r) => r.region },
      { key: "georegion", aliases: ["region", "geo"], type: "string", get: (r) => r.geo },
    ],
    text: (r) => [r.region],
  };
  const c = compileQuery("region:tok", s);
  assert.ok(c.ok);
  assert.deepEqual(applyQuery(rows, (c as { ok: true; query: CompiledQuery<Row> }).query).map((r) => r.region), ["Tokyo"]);
  const info = describeFields(s, rows);
  assert.deepEqual(info.map((f) => [f.key, f.aliases]), [["region", []], ["georegion", ["geo"]]]);
});
