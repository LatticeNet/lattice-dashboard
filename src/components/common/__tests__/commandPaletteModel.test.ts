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
