import assert from "node:assert/strict";
import { test } from "node:test";

import type { LogSource, LogSourceStatsView } from "../../../lib/api/types.ts";
import {
  logSourceFeeds,
  logSourceNameTaken,
  logSourceNamesNode,
  logViewerEmptyState,
  sortLogSources,
} from "../logsModel.ts";

function source(partial: Partial<LogSource> & { id: string }): LogSource {
  return {
    name: partial.id,
    node_id: "node-a",
    path: `/var/log/${partial.id}.log`,
    enabled: true,
    max_line_bytes: 16384,
    max_batch_lines: 500,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function stats(source_id: string, lines: number): LogSourceStatsView {
  return { source_id, node_id: "node-a", name: source_id, path: "", enabled: true, lines, bytes: lines * 80 };
}

test("no source at all is its own answer, and only once the list was read", () => {
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: true, sourceCount: 0, filterActive: false }),
    { kind: "no-sources" },
  );
  // Still loading: an unread list is not an empty one.
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: false, sourceCount: 0, filterActive: false }),
    { kind: "no-selection" },
  );
});

test("a source that holds nothing says whether it is disabled or simply quiet", () => {
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: true, sourceCount: 1, selected: { enabled: false }, heldLines: 0, filterActive: false }),
    { kind: "source-disabled" },
  );
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: true, sourceCount: 1, selected: { enabled: true }, heldLines: 0, filterActive: false }),
    { kind: "source-empty" },
  );
});

test("lines held and a filter applied means the filter matched nothing", () => {
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: true, sourceCount: 1, selected: { enabled: true }, heldLines: 82, filterActive: true }),
    { kind: "nothing-matched" },
  );
  // Lines held, no filter, query empty anyway: the page does not guess why.
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: true, sourceCount: 1, selected: { enabled: true }, heldLines: 82, filterActive: false }),
    { kind: "unknown" },
  );
});

test("unread stats are unknown, never 'nothing shipped'", () => {
  // Telling an operator nothing was ever shipped because the count has not
  // arrived would be a confident wrong answer about their own node.
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: true, sourceCount: 1, selected: { enabled: true }, filterActive: true }),
    { kind: "unknown" },
  );
  assert.deepEqual(
    logViewerEmptyState({ sourcesKnown: true, sourceCount: 1, selected: { enabled: false }, filterActive: false }),
    { kind: "unknown" },
  );
});

test("sources sort enabled first, then by name, in the list and in the empty state alike", () => {
  const sources = [
    source({ id: "zeta", enabled: false }),
    source({ id: "beta" }),
    source({ id: "alpha", name: "" }),
  ];
  assert.deepEqual(sortLogSources(sources).map((s) => s.id), ["alpha", "beta", "zeta"]);
  assert.deepEqual(logSourceFeeds(sources).map((f) => f.id), ["alpha", "beta", "zeta"]);
});

test("the empty sentence drops 'on {node}' when the name already says which node", () => {
  // A server-owned source is named after its node: "sing-box - hk-1 on hk-1"
  // would say the node twice.
  assert.equal(logSourceNamesNode(source({ id: "s", name: "sing-box - hk-1", managed: true }), "hk-1"), false);
  // A hand-made name that carries the node name gets the same treatment, case aside.
  assert.equal(logSourceNamesNode(source({ id: "s", name: "nginx-HK-1" }), "hk-1"), false);
  // A name that does not say the node keeps the clause: it is the only place the node appears.
  assert.equal(logSourceNamesNode(source({ id: "s", name: "nginx-access" }), "hk-1"), true);
  // Nothing to qualify, or nothing to qualify it with.
  assert.equal(logSourceNamesNode(undefined, "hk-1"), false);
  assert.equal(logSourceNamesNode(source({ id: "s", name: "nginx-access" }), ""), false);
});

test("a name already used on the same node is taken; the same name on another node is not", () => {
  const sources = [
    source({ id: "a", name: "singbox-hk-turin", node_id: "node-a" }),
    source({ id: "b", name: "nginx", node_id: "node-b" }),
  ];
  assert.equal(logSourceNameTaken(sources, { name: "singbox-hk-turin", nodeId: "node-a" }), true);
  // Whitespace an operator typed around the name does not make it a new name.
  assert.equal(logSourceNameTaken(sources, { name: "  singbox-hk-turin ", nodeId: "node-a" }), true);
  assert.equal(logSourceNameTaken(sources, { name: "singbox-hk-turin", nodeId: "node-b" }), false);
  assert.equal(logSourceNameTaken(sources, { name: "nginx", nodeId: "node-a" }), false);
  // Editing a source keeps its own name without colliding with itself.
  assert.equal(logSourceNameTaken(sources, { name: "singbox-hk-turin", nodeId: "node-a", excludeId: "a" }), false);
  // An unfinished form is not a collision: the other fields have their own checks.
  assert.equal(logSourceNameTaken(sources, { name: "", nodeId: "node-a" }), false);
  assert.equal(logSourceNameTaken(sources, { name: "singbox-hk-turin", nodeId: "" }), false);
});

test("feeds name the node, the state and what is held, and leave an unread count undefined", () => {
  const feeds = logSourceFeeds(
    [source({ id: "singbox", name: "singbox://legend-sg", node_id: "legend-sg" }), source({ id: "nginx", node_id: "node-b", enabled: false })],
    [stats("singbox", 82)],
  );
  assert.deepEqual(feeds, [
    { id: "singbox", name: "singbox://legend-sg", nodeId: "legend-sg", enabled: true, heldLines: 82 },
    { id: "nginx", name: "nginx", nodeId: "node-b", enabled: false, heldLines: undefined },
  ]);
});
