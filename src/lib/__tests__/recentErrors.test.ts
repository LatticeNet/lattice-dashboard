import assert from "node:assert/strict";
import test from "node:test";

import { ErrorLog, RECENT_ERRORS_MAX, REPEAT_WINDOW_MS } from "../recentErrors.ts";

test("errors are listed newest first and capped", () => {
  const log = new ErrorLog();
  for (let i = 0; i < RECENT_ERRORS_MAX + 5; i += 1) log.add(`failure ${i}`, 1_000_000 + i * 60_000);
  assert.equal(log.list.length, RECENT_ERRORS_MAX);
  assert.equal(log.list[0]!.message, `failure ${RECENT_ERRORS_MAX + 4}`);
  assert.equal(log.list[RECENT_ERRORS_MAX - 1]!.message, "failure 5");
});

test("the same error again within a few seconds is counted, later it is listed again", () => {
  const log = new ErrorLog();
  log.add("Disable node failed: forbidden (request_id: r1)", 0);
  log.add("Disable node failed: forbidden (request_id: r1)", REPEAT_WINDOW_MS);
  assert.equal(log.list.length, 1);
  assert.equal(log.list[0]!.count, 2);
  assert.equal(log.list[0]!.at, REPEAT_WINDOW_MS);
  log.add("Disable node failed: forbidden (request_id: r1)", REPEAT_WINDOW_MS * 3);
  assert.equal(log.list.length, 2);
  // A different detail is a different error.
  log.add("Plan refused", REPEAT_WINDOW_MS * 3, "line-user add needs identity read");
  log.add("Plan refused", REPEAT_WINDOW_MS * 3, "managed-line rollout needs vpncore:admin");
  assert.equal(log.list.length, 4);
});

test("blank messages are not recorded, and clear empties the list", () => {
  const log = new ErrorLog();
  log.add("   ", 0);
  assert.equal(log.list.length, 0);
  log.add("Rotation failed", 0);
  assert.equal(log.clear().length, 0);
  // Ids keep counting after a clear, so a list key never repeats.
  const [entry] = log.add("Rotation failed", 1);
  assert.equal(entry!.id, 2);
});

test("the log belongs to one principal: a sign-out or another operator starts it empty", () => {
  const log = new ErrorLog();
  assert.equal(log.belongTo("user:alice"), true);
  log.add("Reveal failed: unauthorized (request_id: r7)", 0);
  // The same principal again (a refresh after sign-in) keeps the list.
  assert.equal(log.belongTo("user:alice"), false);
  assert.equal(log.list.length, 1);
  // Signed out or expired: nobody owns it, and nothing is left to read.
  assert.equal(log.belongTo(undefined), true);
  assert.equal(log.list.length, 0);
  // Errors shown while signed out (stale reads refused after expiry) do not
  // follow the next operator in.
  log.add("Refresh failed: unauthorized", 1);
  assert.equal(log.belongTo("user:bob"), true);
  assert.deepEqual(log.list, []);
});
