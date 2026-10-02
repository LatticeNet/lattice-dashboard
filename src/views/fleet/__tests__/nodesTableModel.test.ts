import assert from "node:assert/strict";
import { test } from "node:test";

import type { Node } from "../../../lib/api/types.ts";
import {
  nameParts,
  DEFAULT_HIDDEN_COLUMNS,
  NODE_COLUMNS,
  agentVersions,
  canonicalLayoutQuery,
  compareNodeIdentity,
  nodeGroupByCodec,
  nodeGroupKey,
  nodeGroupOrder,
  nodeGroupSummary,
  nodeListCodec,
  nodeSearchCodec,
  nodeStatusFilterCodec,
  parseHiddenColumns,
  searchScore,
  serializeHiddenColumns,
  shownPercent,
  uniformColumns,
} from "../nodesTableModel.ts";

const node = (id: string, over: Partial<Node> = {}): Node => ({ id, name: id, online: true, status: "online", ...over } as Node);

test("the default columns are node, address, agent, last seen, CPU and tags; status is not a column", () => {
  const shown = NODE_COLUMNS.filter((column) => !DEFAULT_HIDDEN_COLUMNS.has(column.id)).map((column) => column.id);
  assert.deepEqual(shown, ["name", "address", "agent", "lastSeen", "cpu", "tags"]);
  assert.ok(!NODE_COLUMNS.some((column) => column.id === "status"));
});

test("hidden columns round-trip; never configured gets the defaults, empty keeps every column", () => {
  assert.deepEqual([...parseHiddenColumns(null)].sort(), [...DEFAULT_HIDDEN_COLUMNS].sort());
  assert.deepEqual([...parseHiddenColumns("")], []);
  const hidden = parseHiddenColumns("cpu,name,nope,tags");
  assert.deepEqual([...hidden].sort(), ["cpu", "tags"]);
  assert.equal(serializeHiddenColumns(hidden), "cpu,tags");
});

test("a column that prints one value on every node leaves for the head", () => {
  const nodes = [
    node("a", { agent_version: "0.3.9", role: "edge", name: "[cd]-a" }),
    node("b", { agent_version: "0.3.9", role: "edge", name: "[Metix]-b" }),
  ];
  assert.deepEqual(uniformColumns(nodes, ["agent", "role", "owner", "archOs"]), [
    { id: "agent", value: "0.3.9" },
    { id: "role", value: "edge" },
  ]);
  // One node is not a pattern; an empty value everywhere is not a value.
  assert.deepEqual(uniformColumns(nodes.slice(0, 1), ["agent"]), []);
  assert.deepEqual(uniformColumns([node("x"), node("y")], ["role"]), []);
});

test("agent versions are distinct and newest first", () => {
  const nodes = [{ agent_version: "0.3.8" }, { agent_version: "0.3.10" }, { agent_version: "0.3.9" }, { agent_version: "" }, { agent_version: "0.3.9" }];
  assert.deepEqual(agentVersions(nodes), ["0.3.10", "0.3.9", "0.3.8"]);
});

test("a printed percent is what the sort ranks", () => {
  assert.equal(shownPercent(7.51), 8);
  assert.equal(shownPercent(7.92), 8);
  assert.equal(shownPercent(140), 100);
  assert.equal(shownPercent(undefined), undefined);
});

test("owners group by size with the unowned last; statuses worst first; versions newest first", () => {
  const nodes = [
    node("1", { name: "[cd]-a" }),
    node("2", { name: "[Metix]-b" }),
    node("3", { name: "[Metix]-c", status: "offline", online: false }),
    node("4", { name: "plain" }),
    node("5", { name: "[cd]-d", agent_version: "0.3.10" }),
    node("6", { name: "[cd]-e", agent_version: "0.3.9", status: "never_reported", online: false }),
  ];
  assert.equal(nodeGroupKey(nodes[0]!, "owner"), "cd");
  assert.deepEqual(nodeGroupOrder(nodes, "owner"), ["cd", "Metix", ""]);
  assert.deepEqual(nodeGroupOrder(nodes, "status"), ["never_reported", "offline", "online"]);
  assert.deepEqual(nodeGroupOrder(nodes, "agent"), ["0.3.10", "0.3.9", ""]);
  assert.deepEqual(nodeGroupOrder(nodes, "none"), []);
});

test("a group row counts its members and names the ones not reporting, worst first", () => {
  const summary = nodeGroupSummary([
    node("1", { name: "[Metix]-DMIT-4", status: "offline", online: false }),
    node("2", { name: "[Metix]-DMIT-1" }),
    node("3", { name: "[Metix]-gpu", status: "never_reported", online: false }),
    node("4", { name: "[Metix]-malibu", status: "degraded" }),
    node("5", { name: "[Metix]-kix", status: "disabled", disabled: true }),
  ]);
  assert.deepEqual(summary, { total: 5, online: 1, degraded: 1, disabled: 1, down: ["gpu", "DMIT-4"] });
});

test("search ranks exact over prefix over substring over subsequence, and mac finds darwin", () => {
  const n = node("node_1", { name: "gomami-hkg", public_ip: "203.0.113.9", host_facts: { os: "darwin", hostname: "air" } as Node["host_facts"] });
  assert.equal(searchScore(n, "gomami-hkg"), 100);
  assert.equal(searchScore(n, "gom"), 70);
  assert.equal(searchScore(n, "113"), 50);
  assert.equal(searchScore(n, "gmhk"), 20);
  assert.equal(searchScore(n, "mac"), 60);
  assert.equal(searchScore(n, "zzz"), 0);
});

test("identity orders by name then id, so two nodes sharing a name never trade places", () => {
  assert.ok(compareNodeIdentity({ id: "b", name: "x" }, { id: "a", name: "x" }) > 0);
  assert.ok(compareNodeIdentity({ id: "a", name: "a" }, { id: "b", name: "b" }) < 0);
});

test("the address keys: owner grouping, an empty search and no list are the bare URL", () => {
  assert.equal(nodeGroupByCodec.parse(undefined), "owner");
  assert.equal(nodeGroupByCodec.parse("tag"), "owner");
  assert.equal(nodeGroupByCodec.parse("status"), "status");
  assert.equal(nodeGroupByCodec.format("owner"), undefined);
  assert.equal(nodeGroupByCodec.format("none"), "none");
  assert.equal(nodeSearchCodec.format("  "), undefined);
  assert.equal(nodeSearchCodec.format("dmit"), "dmit");
  assert.deepEqual(nodeListCodec.parse("root, terminal,root,"), ["root", "terminal"]);
  assert.equal(nodeListCodec.format([]), undefined);
  assert.equal(nodeListCodec.format(["root", "no-source"]), "root,no-source");
});

test("the status filter reads one status word and writes all as the bare URL", () => {
  assert.equal(nodeStatusFilterCodec.parse("offline"), "offline");
  assert.equal(nodeStatusFilterCodec.parse("queued"), "all");
  assert.equal(nodeStatusFilterCodec.parse(undefined), "all");
  assert.equal(nodeStatusFilterCodec.format("all"), undefined);
  assert.equal(nodeStatusFilterCodec.format("never_reported"), "never_reported");
});

test("an old ?view=card|list link moves to ?layout=, and ?layout= wins", () => {
  assert.deepEqual(canonicalLayoutQuery({ view: "card", status: "offline" }), {
    layout: "card",
    query: { status: "offline", layout: "card" },
  });
  assert.deepEqual(canonicalLayoutQuery({ view: "card", layout: "list" }), { layout: "list", query: { layout: "list" } });
  assert.equal(canonicalLayoutQuery({ layout: "card" }), null);
  // ?view= that is not a layout is a layer name; it is not Nodes' to move.
  assert.equal(canonicalLayoutQuery({ view: "history" }), null);
});

test("a long name keeps its last part, so siblings stay apart when cut", () => {
  assert.deepEqual(nameParts("Aaitr-Frontier-NAT"), ["Aaitr-Frontier", "-NAT"]);
  assert.deepEqual(nameParts("Aaitr-Frontier-VDS"), ["Aaitr-Frontier", "-VDS"]);
  assert.deepEqual(nameParts("cloudcone-la"), ["cloudcone-la", ""]);
  assert.deepEqual(nameParts("[OpenJobs-Data]-gpu-box"), ["[OpenJobs-Data]-gpu", "-box"]);
  assert.deepEqual(nameParts("averyverylongnamewithoutbreaks"), ["averyverylongnamewithoutbr", "eaks"]);
});
