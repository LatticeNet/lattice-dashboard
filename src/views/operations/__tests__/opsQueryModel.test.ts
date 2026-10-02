import assert from "node:assert/strict";
import { test } from "node:test";

import { pageBounds, rangeWindow, readOffset, readRange, writeOffset, writeRange } from "../opsQueryModel.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");

test("a range is read from the address, and an unknown one is the page's default", () => {
  assert.deepEqual(readRange({}, "24h"), { range: "24h", since: "", until: "" });
  assert.deepEqual(readRange({ range: "7d" }, "24h"), { range: "7d", since: "", until: "" });
  assert.deepEqual(readRange({ range: "fortnight" }, "24h"), { range: "24h", since: "", until: "" });
  assert.deepEqual(readRange({ range: "custom", since: "2026-09-01T00:00:00+08:00", until: "junk" }, "24h"), {
    range: "custom",
    since: "2026-08-31T16:00:00.000Z",
    until: "",
  });
});

test("writing a range keeps other keys, drops the page offset, and the default is the bare URL", () => {
  assert.deepEqual(writeRange({ view: "all", q: "x", offset: "50" }, { range: "24h", since: "", until: "" }, "24h"), { view: "all", q: "x" });
  assert.deepEqual(writeRange({ since: "old" }, { range: "7d", since: "", until: "" }, "24h"), { range: "7d" });
  assert.deepEqual(
    writeRange({}, { range: "custom", since: "2026-09-01T00:00:00.000Z", until: "" }, "24h"),
    { range: "custom", since: "2026-09-01T00:00:00.000Z" },
  );
});

test("a window is UTC with Z, and all has no bounds", () => {
  assert.deepEqual(rangeWindow({ range: "24h", since: "", until: "" }, NOW), { from: "2026-09-29T12:00:00.000Z" });
  assert.deepEqual(rangeWindow({ range: "all", since: "", until: "" }, NOW), {});
  assert.deepEqual(rangeWindow({ range: "custom", since: "2026-09-01T00:00:00.000Z", until: "" }, NOW), { from: "2026-09-01T00:00:00.000Z", to: undefined });
});

test("the server page offset is read and written, first page bare", () => {
  assert.equal(readOffset({}), 0);
  assert.equal(readOffset({ offset: "100" }), 100);
  assert.equal(readOffset({ offset: "-5" }), 0);
  assert.equal(readOffset({ offset: "2.5" }), 0);
  assert.deepEqual(writeOffset({ q: "x", offset: "50" }, 0), { q: "x" });
  assert.deepEqual(writeOffset({ q: "x" }, 100), { q: "x", offset: "100" });
  assert.deepEqual(pageBounds(50, 50), { from: 51, to: 100 });
  assert.deepEqual(pageBounds(0, 0), { from: 0, to: 0 });
});
