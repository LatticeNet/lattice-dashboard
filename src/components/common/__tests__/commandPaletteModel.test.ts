import assert from "node:assert/strict";
import test from "node:test";

import {
  SYSTEM_WRITER,
  StaleLoadError,
  VPN_USERS_PAGE,
  createTtlCache,
  filterPendingSystemApprovals,
  paletteListAccess,
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

/** A fetch the test resolves by hand, standing in for a read still on the wire. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a read still in flight when the cache is invalidated never lands, and the next load reads again", async () => {
  const cache = createTtlCache<string>(30_000, () => 0);
  const oldRead = deferred<string>();
  const before = cache.load(() => oldRead.promise);
  // The principal changes while the old principal's read is on the wire.
  cache.invalidate();
  let newReads = 0;
  const after = cache.load(async () => {
    newReads += 1;
    return "new principal's list";
  });
  oldRead.resolve("old principal's list");

  await assert.rejects(before, StaleLoadError, "the old read rejects instead of resolving into state");
  assert.equal(await after, "new principal's list", "a load after invalidate does not join the disowned read");
  assert.equal(newReads, 1);
  assert.equal(await cache.load(async () => "unused"), "new principal's list", "and only the new answer is cached");
});

test("a failed read that invalidate overtook rejects as stale, so the caller keeps what the invalidating code set", async () => {
  const cache = createTtlCache<string>(30_000, () => 0);
  const read = deferred<string>();
  const load = cache.load(() => read.promise);
  cache.invalidate();
  read.reject(new Error("offline"));
  await assert.rejects(load, StaleLoadError);
});

test("the palette reads each list only behind the gate of the page that opens it", () => {
  const pages = (...names: string[]) => new Set(names);
  const scopes = (...granted: string[]) => (scope: string) => granted.includes(scope);

  assert.deepEqual(paletteListAccess(pages(), scopes("proxy:admin")), { nodes: false, approvals: false, identities: false, shares: false });
  assert.deepEqual(paletteListAccess(pages("nodes", "approvals"), scopes()), { nodes: true, approvals: true, identities: false, shares: false });
  // Identities need vpn-core's Users page in the sidebar, which carries that page's own scope.
  assert.equal(paletteListAccess(pages(VPN_USERS_PAGE), scopes()).identities, true);
  assert.equal(paletteListAccess(pages("plugin:latticenet.vpn-core:lines"), scopes()).identities, false);
  // Publishing is offered without proxy:admin, so the share list needs both.
  assert.equal(paletteListAccess(pages("platform-publishing"), scopes()).shares, false);
  assert.equal(paletteListAccess(pages(), scopes("proxy:admin")).shares, false);
  assert.equal(paletteListAccess(pages("platform-publishing"), scopes("proxy:admin")).shares, true);
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

/* ------------------------------------------------------------------ */
/* VPN identities, shares and recent objects                            */
/* ------------------------------------------------------------------ */

import {
  RECENT_OBJECTS_MAX,
  objectState,
  paletteIdentities,
  paletteShares,
  pushRecentObject,
  readRecentObjects,
  serializeRecentObjects,
} from "../commandPaletteModel.ts";

test("identities keep the address, name, state and expiry, and nothing else of the answer", () => {
  const answer = {
    count: 3,
    users: [
      {
        id: "vpnuser_alice",
        email: "alice@example.com",
        name: "Alice",
        enabled: true,
        expires_at: "2026-11-01T00:00:00Z",
        group: "family",
        credentials: [{ protocol: "vless", has_secret: true }],
        bindings: [{ line_hash_id: "l1", enabled: true }],
        quota_bytes: 1_000,
        used_bytes: 10,
      },
      // Go writes an unset time.Time as year 1 even with omitempty.
      { id: "vpnuser_bob", email: "bob@example.com", enabled: false, expires_at: "0001-01-01T00:00:00Z" },
      { id: "", email: "nobody@example.com" },
      { id: "vpnuser_noemail", email: "" },
      null,
      "junk",
    ],
  };
  const identities = paletteIdentities(answer);
  assert.deepEqual(identities, [
    { id: "vpnuser_alice", email: "alice@example.com", name: "Alice", enabled: true, expiresAt: "2026-11-01T00:00:00Z", group: "family" },
    { id: "vpnuser_bob", email: "bob@example.com", enabled: false },
  ]);
  assert.ok(!JSON.stringify(identities).includes("credentials"), "credential descriptors never reach the palette");
  assert.deepEqual(paletteIdentities(undefined), []);
  assert.deepEqual(paletteIdentities({ users: "nope" }), []);
});

test("shares keep the name and state and drop the token, the link itself", () => {
  const shares = paletteShares([
    { id: "share_1", slug: "family-clash", token: "tok_secret_abc", enabled: true, expires_at: "2027-01-01T00:00:00Z", source: { kind: "plugin" } },
    { id: "share_2", slug: "travel", token: "tok_secret_def", enabled: false },
    { id: "share_3", slug: "", token: "tok_secret_ghi" },
  ]);
  assert.deepEqual(shares, [
    { id: "share_1", slug: "family-clash", enabled: true, expiresAt: "2027-01-01T00:00:00Z" },
    { id: "share_2", slug: "travel", enabled: false },
  ]);
  assert.ok(!JSON.stringify(shares).includes("tok_secret"), "no token survives the projection");
  assert.equal(paletteShares({ shares: [{ id: "share_4", slug: "wrapped", token: "t" }] }).length, 1, "a wrapped list reads too");
});

test("an object is off before it is expired, and expired only once its time has passed", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(objectState({ enabled: true }, now), "on");
  assert.equal(objectState({ enabled: true, expiresAt: "2026-10-03T12:00:01Z" }, now), "on");
  assert.equal(objectState({ enabled: true, expiresAt: "2026-10-03T12:00:00Z" }, now), "expired");
  assert.equal(objectState({ enabled: false, expiresAt: "2026-01-01T00:00:00Z" }, now), "off");
});

test("recent objects are read only for the principal that stored them", () => {
  const items = [
    { kind: "identity", id: "vpnuser_alice" },
    { kind: "node", id: "node_020" },
  ] as const;
  const raw = serializeRecentObjects("usr_cdcd", items);
  assert.deepEqual(readRecentObjects(raw, "usr_cdcd"), items);
  assert.deepEqual(readRecentObjects(raw, "usr_other"), [], "another operator's list is not shown");
  assert.deepEqual(readRecentObjects(raw, undefined), [], "nothing is shown signed out");
  assert.deepEqual(readRecentObjects(null, "usr_cdcd"), []);
  assert.deepEqual(readRecentObjects("{not json", "usr_cdcd"), []);
  assert.deepEqual(readRecentObjects(JSON.stringify(items), "usr_cdcd"), [], "an unowned list (the old shape) is not read");
});

test("stored recent objects are cleaned: unknown kinds, bad ids and repeats dropped, capped", () => {
  const raw = JSON.stringify({
    owner: "usr_cdcd",
    items: [
      { kind: "node", id: "node_1" },
      { kind: "task", id: "task_1" },
      { kind: "node", id: "" },
      { kind: "node", id: "x".repeat(129) },
      { kind: "node", id: "node_1" },
      { kind: "share", id: "share_1", label: "travel", token: "tok" },
      { kind: "approval", id: "approval_1" },
      { kind: "identity", id: "vpnuser_1" },
      { kind: "node", id: "node_2" },
      { kind: "node", id: "node_3" },
    ],
  });
  const read = readRecentObjects(raw, "usr_cdcd");
  assert.equal(read.length, RECENT_OBJECTS_MAX);
  assert.deepEqual(read, [
    { kind: "node", id: "node_1" },
    { kind: "share", id: "share_1" },
    { kind: "approval", id: "approval_1" },
    { kind: "identity", id: "vpnuser_1" },
    { kind: "node", id: "node_2" },
  ]);
});

test("opening an object again moves it first, and the list stays capped", () => {
  let list = pushRecentObject([], { kind: "node", id: "node_1" });
  list = pushRecentObject(list, { kind: "identity", id: "vpnuser_1" });
  list = pushRecentObject(list, { kind: "node", id: "node_1" });
  assert.deepEqual(list, [
    { kind: "node", id: "node_1" },
    { kind: "identity", id: "vpnuser_1" },
  ]);
  for (let index = 2; index < 9; index += 1) list = pushRecentObject(list, { kind: "share", id: `share_${index}` });
  assert.equal(list.length, RECENT_OBJECTS_MAX);
  assert.equal(list[0]?.id, "share_8");
  assert.ok(!serializeRecentObjects("usr_cdcd", list).includes("label"), "only kind and id are stored");
});

test("an identity is found by any part of its address", () => {
  const alice = entry("identity:vpnuser_alice", "identity", "alice@example.com", { detail: "Alice", terms: ["vpnuser_alice", "Alice", "family"] });
  assert.ok(paletteMatchScore(alice, "alice") >= 80);
  assert.ok(paletteMatchScore(alice, "example") >= 60, "the domain is a word of the label");
  assert.ok(paletteMatchScore(alice, "family") > 0, "and the group a term");
  assert.equal(paletteMatchScore(alice, "bob"), 0);
});
