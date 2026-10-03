import assert from "node:assert/strict";
import test from "node:test";

import {
  SYSTEM_WRITER,
  createTtlCache,
  filterPendingSystemApprovals,
} from "../commandPaletteModel.ts";

test("only pending items written by the server itself qualify", () => {
  const items = [
    { id: "a", status: "pending", actor_id: SYSTEM_WRITER },
    { id: "b", status: "pending", actor_id: "operator-7" },
    { id: "c", status: "approved", actor_id: SYSTEM_WRITER },
    { id: "d", status: "pending", actor_id: "" },
    { id: "e", status: "pending", actor_id: ` ${SYSTEM_WRITER} ` },
    { id: "f", status: "pending" },
    { id: "g", status: "rejected", actor_id: SYSTEM_WRITER },
  ];

  const out = filterPendingSystemApprovals(items);

  assert.deepEqual(out.map((item) => item.id), ["a", "e"]);
});

test("a fresh cache value is served without refetching", async () => {
  let calls = 0;
  let clock = 1_000;
  const cache = createTtlCache<string>(30_000, () => clock);

  const first = await cache.load(async () => {
    calls += 1;
    return "v1";
  });
  clock += 10_000; // within the 30s window
  const second = await cache.load(async () => {
    calls += 1;
    return "v2";
  });

  assert.equal(first, "v1");
  assert.equal(second, "v1");
  assert.equal(calls, 1);
});

test("an expired entry refetches, and invalidate forces a refetch", async () => {
  let calls = 0;
  let clock = 0;
  const cache = createTtlCache<number>(30_000, () => clock);
  const fetcher = async () => ++calls;

  assert.equal(await cache.load(fetcher), 1);
  clock += 30_001; // past the window
  assert.equal(await cache.load(fetcher), 2);
  cache.invalidate();
  assert.equal(await cache.load(fetcher), 3, "invalidate drops even a fresh entry");
  assert.equal(await cache.load(fetcher), 3, "and the new value is cached again");
});

test("concurrent loads share one in-flight fetch", async () => {
  let calls = 0;
  const cache = createTtlCache<string>(30_000, () => 0);
  const fetcher = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "shared";
  };

  const [a, b, c] = await Promise.all([cache.load(fetcher), cache.load(fetcher), cache.load(fetcher)]);

  assert.equal(calls, 1);
  assert.deepEqual([a, b, c], ["shared", "shared", "shared"]);
});

test("a failed fetch is not cached. The next load retries", async () => {
  let calls = 0;
  const cache = createTtlCache<string>(30_000, () => 0);

  await assert.rejects(
    cache.load(async () => {
      calls += 1;
      throw new Error("offline");
    }),
    /offline/,
  );
  const retried = await cache.load(async () => {
    calls += 1;
    return "recovered";
  });

  assert.equal(retried, "recovered");
  assert.equal(calls, 2);
});

/* ------------------------------------------------------------------ */
/* Search ranking and id jumps                                          */
/* ------------------------------------------------------------------ */

import {
  normalizeSearch,
  paletteIdJump,
  paletteJumpLocation,
  paletteMatchScore,
  paletteTermsKey,
  rankPaletteEntries,
  type PaletteEntry,
} from "../commandPaletteModel.ts";

const entry = (key: string, group: PaletteEntry["group"], label: string, extra: Partial<PaletteEntry<null>> = {}): PaletteEntry<null> => ({
  key,
  group,
  label,
  payload: null,
  ...extra,
});

test("search folds case, width and spacing", () => {
  assert.equal(normalizeSearch("  ＤＭＩＴ   LA "), "dmit la");
});

test("a node is found by name, id, address and tag, and every word must land", () => {
  const node = entry("node:node_7", "node", "dmit-la-1", {
    detail: "154.17.2.9",
    terms: ["node_7xq", "154.17.2.9", "2605:6400::1", "10.0.0.7", "metix", "us-west"],
  });
  assert.ok(paletteMatchScore(node, "dmit") > 0);
  assert.ok(paletteMatchScore(node, "node_7x") > 0);
  assert.ok(paletteMatchScore(node, "154.17") > 0);
  assert.ok(paletteMatchScore(node, "2605:6400") > 0);
  assert.ok(paletteMatchScore(node, "metix") > 0);
  assert.ok(paletteMatchScore(node, "dmit la") > 0, "a word of the name hyphen-split");
  assert.equal(paletteMatchScore(node, "dmit tokyo"), 0, "a word that lands nowhere drops the entry");
  assert.equal(paletteMatchScore(node, ""), 0);
});

test("a label hit outranks a term hit, and a prefix outranks a middle", () => {
  const nodes = entry("page:nodes", "page", "Nodes", { terms: ["server machine host"] });
  const profiles = entry("page:profiles", "page", "Node Profiles");
  const upcoming = entry("page:upcoming", "page", "Upcoming", { terms: ["renew renewal expiry"] });
  assert.equal(paletteMatchScore(nodes, "nodes"), 100, "the whole label");
  assert.equal(paletteMatchScore(profiles, "nodes"), 0, "no word of Node Profiles starts with nodes");
  assert.ok(paletteMatchScore(nodes, "server") > 0 && paletteMatchScore(nodes, "server") < paletteMatchScore(nodes, "nod"));
  assert.ok(paletteMatchScore(profiles, "pro") > paletteMatchScore(profiles, "ofil"), "a word prefix beats a middle");
  assert.ok(paletteMatchScore(upcoming, "renew") > 0, "a verb finds the page that does it");
  assert.ok(paletteMatchScore(upcoming, "upc") > paletteMatchScore(upcoming, "renew"));
});

test("groups come by their best match, the fixed order breaking a tie, best first inside, capped", () => {
  const entries = [
    entry("page:approvals", "page", "Approvals", { terms: ["approve review plan"] }),
    entry("approval:a1", "approval", "Agent update", { detail: "dmit-la-1", terms: ["approve", "approval_a1"] }),
    entry("action:system", "action", "Approve all system events"),
    entry("approval:a2", "approval", "SSH Guard arm", { terms: ["approve", "approval_a2"] }),
    entry("approval:a3", "approval", "Line user add", { terms: ["approve", "approval_a3"] }),
    entry("node:n1", "node", "approve-test-node"),
  ];
  const ranked = rankPaletteEntries(entries, "approve", { approval: 2 });
  // Action and node both start with "approve" (80): the action leads on the tie.
  // Approvals and the page match only by a word (30): approvals first on the tie.
  assert.deepEqual(ranked.map((e) => e.key), ["action:system", "node:n1", "approval:a1", "approval:a2", "page:approvals"]);
});

test("typing a node's name puts the nodes above an approval that only mentions the node", () => {
  const entries = [
    entry("approval:a1", "approval", "Agent update", { detail: "[Metix]-DMIT-4 · agentupdate", terms: ["approve", "[Metix]-DMIT-4"] }),
    entry("node:n4", "node", "[Metix]-DMIT-4", { detail: "198.51.100.24" }),
    entry("node:n1", "node", "[Metix]-DMIT-1", { detail: "198.51.100.21" }),
  ];
  assert.deepEqual(rankPaletteEntries(entries, "dmit").map((e) => e.key), ["node:n4", "node:n1", "approval:a1"]);
});

test("a pasted id's jump leads whatever else matches better", () => {
  const entries = [
    entry("node:n20", "node", "node_020", { terms: ["node_020"] }),
    entry("jump:node_020", "jump", "Open node node_020", { terms: ["node_020"] }),
  ];
  assert.deepEqual(rankPaletteEntries(entries, "node_020").map((e) => e.key), ["jump:node_020", "node:n20"]);
});

test("ranking an empty query returns nothing; the palette shows its browse lists instead", () => {
  assert.deepEqual(rankPaletteEntries([entry("page:nodes", "page", "Nodes")], "   "), []);
});

test("a pasted approval, task or node id is a jump to that object", () => {
  assert.deepEqual(paletteIdJump(" approval_1rt7dbzk8xm3wq2n "), { kind: "approval", id: "approval_1rt7dbzk8xm3wq2n" });
  assert.deepEqual(paletteIdJump("TASK_ABCD2345EFGH6723"), { kind: "task", id: "task_abcd2345efgh6723" });
  assert.deepEqual(paletteIdJump("node_020"), { kind: "node", id: "node_020" });
  assert.equal(paletteIdJump("approval_"), null);
  assert.equal(paletteIdJump("approval_ab"), null, "too short to be an id");
  assert.equal(paletteIdJump("approvals"), null);
  assert.equal(paletteIdJump("audit_abcdefgh"), null, "only the three kinds with a page to open");
  assert.equal(paletteIdJump("approval_abcd/../../x"), null);
});

test("jumps open the sheet on the object's page, or the node's own page", () => {
  assert.deepEqual(paletteJumpLocation({ kind: "approval", id: "approval_x1y2" }), { path: "/approvals", query: { open: "approval_x1y2" } });
  assert.deepEqual(paletteJumpLocation({ kind: "task", id: "task_x1y2" }), { path: "/tasks", query: { open: "task_x1y2" } });
  assert.deepEqual(paletteJumpLocation({ kind: "node", id: "node_x1y2" }), { path: "/nodes/node_x1y2" });
});

test("search words come from the destination, official plugin pages included", () => {
  assert.equal(paletteTermsKey({ name: "upcoming" }), "upcoming");
  assert.equal(paletteTermsKey({ name: "network-ssh-guard" }), "sshGuard");
  assert.equal(paletteTermsKey({ name: "groups" }), null, "a label that already says it needs no words");
  assert.equal(paletteTermsKey({ name: "plugin:latticenet.vpn-core:users", plugin: { id: "latticenet.vpn-core" }, route: "users" }), "vpnUsers");
  assert.equal(paletteTermsKey({ name: "plugin:latticenet.sub-store:sub-store", plugin: { id: "latticenet.sub-store" }, route: "sub-store" }), "subStore");
  assert.equal(paletteTermsKey({ name: "plugin:example.leases:leases", plugin: { id: "example.leases" }, route: "leases" }), null);
});
