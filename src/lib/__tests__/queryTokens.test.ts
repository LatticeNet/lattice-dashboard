import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatTokens,
  parseTokens,
  readTokenQuery,
  scanQueryWords,
  tokenFilterCount,
  tokenParams,
  writeTokenQuery,
  type TokenGrammar,
  type TokenResolvers,
} from "../queryTokens.ts";

// An Audit-shaped grammar: the keys wave 2 moves onto the bar. The token key
// and the HTTP parameter differ only where the API spells it differently.
const AUDIT: TokenGrammar = {
  fields: [
    { key: "node", kind: "list", resolve: "node", param: "node_id" },
    { key: "actor", kind: "value", param: "actor_id" },
    { key: "action", kind: "value" },
    { key: "decision", kind: "enum", values: ["allow", "deny", "observe"] },
  ],
  flags: [{ name: "failed", param: "failed_only" }],
};

const NODES = [
  { id: "node_a1", name: "[cd]-DMIT-2" },
  { id: "node_b2", name: "hetzner-fsn" },
];

const RESOLVERS: TokenResolvers = {
  node: {
    toId: (value) => NODES.find((n) => n.id === value || n.name.toLowerCase() === value.toLowerCase())?.id,
    label: (id) => NODES.find((n) => n.id === id)?.name ?? id,
  },
};

test("the scanner splits on space, keeps quoted values whole, and records what was bare", () => {
  assert.deepEqual(scanQueryWords('  node:a   action:"x y"  free '), [
    { word: "node:a", bare: 6 },
    { word: "action:x y", bare: 7 },
    { word: "free", bare: 4 },
  ]);
  assert.deepEqual(scanQueryWords('action:"a \\"b\\" c"').map((w) => w.word), ['action:a "b" c']);
  assert.deepEqual(scanQueryWords('"unclosed').map((w) => w.word), ["unclosed"]);
  assert.deepEqual(scanQueryWords(""), []);
});

test("tokens land on their keys, names resolve to ids, and free text is kept", () => {
  const parsed = parseTokens("node:[cd]-DMIT-2,hetzner-fsn actor:cdcd decision:DENY,allow failed network.apply", AUDIT, RESOLVERS);
  assert.deepEqual(parsed.values, { node: "node_a1,node_b2", actor: "cdcd" });
  assert.deepEqual(parsed.enums, { decision: ["allow", "deny"] });
  assert.deepEqual(parsed.flags, ["failed"]);
  assert.equal(parsed.text, "network.apply");
  assert.deepEqual(parsed.problems, []);
});

test("a prefix that is not a key, a quoted key and a quoted flag are all free text", () => {
  const parsed = parseTokens('example.com:443 "node:x" "failed" [::1]:22', AUDIT, RESOLVERS);
  assert.deepEqual(parsed.values, {});
  assert.deepEqual(parsed.flags, []);
  assert.equal(parsed.text, "example.com:443 node:x failed [::1]:22");
});

test("is:failed reads like the bare flag", () => {
  assert.deepEqual(parseTokens("is:failed", AUDIT).flags, ["failed"]);
});

test("problems are named per token, and a name nobody knows is kept as typed", () => {
  const parsed = parseTokens("node:ghost decision:maybe action:", AUDIT, RESOLVERS);
  assert.equal(parsed.values.node, "ghost");
  assert.equal(parsed.enums.decision, undefined);
  assert.deepEqual(parsed.problems, [
    { token: "node:ghost", kind: "unresolved" },
    { token: "decision:maybe", kind: "unknown-value" },
    { token: "action:", kind: "empty-value" },
  ]);
});

test("formatting names what it can, quotes what needs it, and parses back to the same values", () => {
  const parsed = parseTokens('node:node_b2 action:"task run" decision:deny "node:x" failed', AUDIT, RESOLVERS);
  const text = formatTokens(parsed, AUDIT, RESOLVERS);
  assert.equal(text, 'node:hetzner-fsn action:"task run" decision:deny failed "node:x"');
  const again = parseTokens(text, AUDIT, RESOLVERS);
  assert.deepEqual({ ...again, problems: [] }, { ...parsed, problems: [] });
});

test("a URL holds the HTTP parameter names, so one address is one API call", () => {
  const parsed = parseTokens("node:[cd]-DMIT-2 actor:cdcd decision:deny failed apply", AUDIT, RESOLVERS);
  const query = writeTokenQuery({ view: "changes", node_id: "old", open: "e1" }, AUDIT, parsed);
  assert.deepEqual(query, {
    view: "changes",
    open: "e1",
    node_id: "node_a1",
    actor_id: "cdcd",
    decision: "deny",
    failed_only: "1",
    q: "apply",
  });
  assert.deepEqual(readTokenQuery(query, AUDIT), {
    values: { node: "node_a1", actor: "cdcd" },
    enums: { decision: ["deny"] },
    flags: ["failed"],
    text: "apply",
  });
});

test("a hand-edited URL cannot send an enum value the grammar does not know", () => {
  assert.deepEqual(readTokenQuery({ decision: "deny,drop" }, AUDIT).enums, { decision: ["deny"] });
  assert.deepEqual(readTokenQuery({ decision: "drop" }, AUDIT).enums, {});
});

test("the grammar lists every parameter it owns, and the filter count leaves free text out", () => {
  assert.deepEqual(tokenParams(AUDIT), ["node_id", "actor_id", "action", "decision", "failed_only", "q"]);
  const parsed = parseTokens("node:a decision:allow,deny failed text", AUDIT);
  assert.equal(tokenFilterCount(parsed, AUDIT), 4);
  assert.equal(tokenFilterCount(parsed, AUDIT, ["decision"]), 2);
});
