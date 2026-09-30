import assert from "node:assert/strict";
import { test } from "node:test";

import { taskCountsTile } from "../taskCountsModel.ts";

const COUNTS = { queued: 0, running: 0, stalled: 1, failed_24h: 5, finished_24h: 31, total: 1771, generated_at: "2026-09-30T08:00:00Z" };

test("production on 2026-09-30: nothing queued, one stalled, five failed in a day", () => {
  const tile = taskCountsTile({ data: COUNTS });
  assert.equal(tile.state, "ready");
  // Worst first, so a narrow tile that truncates keeps what needs a hand.
  assert.deepEqual(tile.parts, [
    { key: "stalled", n: 1, tone: "warning" },
    { key: "failed_24h", n: 5, tone: "destructive" },
    { key: "queued", n: 0, tone: "default" },
  ]);
  assert.equal(tile.status, "stalled");
  assert.equal(tile.stale, false);
});

test("a quiet queue says 0 queued and drills nowhere in particular", () => {
  const tile = taskCountsTile({ data: { ...COUNTS, stalled: 0, failed_24h: 0 } });
  assert.deepEqual(tile.parts, [{ key: "queued", n: 0, tone: "default" }]);
  assert.equal(tile.status, undefined);
  assert.equal(taskCountsTile({ data: { ...COUNTS, stalled: 0, queued: 2, running: 1 } }).status, "queued");
  assert.equal(taskCountsTile({ data: { ...COUNTS, stalled: 0, running: 1 } }).status, "leased");
});

test("before the first answer the tile is reading, and a failed read is not read, never unknown", () => {
  assert.equal(taskCountsTile({}).state, "reading");
  assert.equal(taskCountsTile({ error: Object.assign(new Error("boom"), { status: 502 }) }).state, "failed");
  assert.equal(taskCountsTile({ error: new Error("network") }).state, "failed");
  assert.equal(taskCountsTile({ error: Object.assign(new Error("denied"), { status: 403 }) }).state, "forbidden");
});

test("a 404 is a server without the read, and claims no count even with an old answer", () => {
  const tile = taskCountsTile({ data: COUNTS, error: Object.assign(new Error("not found"), { status: 404 }) });
  assert.equal(tile.state, "unsupported");
  assert.deepEqual(tile.parts, []);
});

test("a failed refresh keeps the last good counts and says they are stale", () => {
  const tile = taskCountsTile({ data: COUNTS, error: Object.assign(new Error("timeout"), { status: 504 }) });
  assert.equal(tile.state, "ready");
  assert.equal(tile.stale, true);
  assert.equal(tile.parts.length, 3);
});
