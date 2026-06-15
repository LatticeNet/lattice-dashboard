import assert from "node:assert/strict";
import test from "node:test";

import { logSourcePayload, logQueryString, toRFC3339 } from "./logs.js";

test("logSourcePayload trims and omits empty optional fields", () => {
  assert.deepEqual(logSourcePayload({
    name: " nginx ",
    node_id: " node-a ",
    path: " /var/log/nginx/error.log ",
    max_line_bytes: "",
    max_batch_lines: "0",
    enabled: true,
  }), {
    name: "nginx",
    node_id: "node-a",
    path: "/var/log/nginx/error.log",
    enabled: true,
  });
});

test("logSourcePayload includes id and positive caps", () => {
  assert.deepEqual(logSourcePayload({
    id: " ls1 ",
    name: "x",
    node_id: "n",
    path: "/var/log/x",
    max_line_bytes: "2048",
    max_batch_lines: "100",
    enabled: false,
  }), {
    id: "ls1",
    name: "x",
    node_id: "n",
    path: "/var/log/x",
    max_line_bytes: 2048,
    max_batch_lines: 100,
    enabled: false,
  });
});

test("toRFC3339 strips fractional seconds and rejects empty/invalid", () => {
  assert.equal(toRFC3339("2026-06-15T12:00:00Z"), "2026-06-15T12:00:00Z");
  assert.equal(toRFC3339(""), "");
  assert.equal(toRFC3339("not-a-date"), "");
});

test("logQueryString builds a filtered, capped query", () => {
  const qs = logQueryString({
    source_id: "ls1",
    q: " error ",
    since: "2026-06-15T12:00:00Z",
    until: "",
    limit: "5000",
    before_seq: 42,
  });
  const parsed = new URLSearchParams(qs);
  assert.equal(parsed.get("source_id"), "ls1");
  assert.equal(parsed.get("q"), "error");
  assert.equal(parsed.get("since"), "2026-06-15T12:00:00Z");
  assert.equal(parsed.has("until"), false);
  assert.equal(parsed.get("limit"), "1000"); // clamped
  assert.equal(parsed.get("before_seq"), "42");
});
