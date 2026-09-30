import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OFFLINE_MINUTES,
  formatOfflineDelay,
  nodeOfflinePolicy,
  parseDelayTag,
  ruleRoutesNodeOffline,
} from "../nodeOfflineModel.ts";

test("a rule routes node.offline by name, by * or by listing nothing", () => {
  assert.equal(ruleRoutesNodeOffline({ event_types: ["monitor.down", "node.offline"] }), true);
  assert.equal(ruleRoutesNodeOffline({ event_types: ["*"] }), true);
  assert.equal(ruleRoutesNodeOffline({ event_types: [] }), true);
  assert.equal(ruleRoutesNodeOffline({ event_types: null }), true);
  assert.equal(ruleRoutesNodeOffline({ event_types: ["node.online", "monitor.down"] }), false);
});

test("delay tags parse the same way the server reads them", () => {
  const cases: [string, number | null][] = [
    ["offline-alert-after:3h", 180],
    [" Offline-Alert-After:45m ", 45],
    ["offline-alert-after:2m", 2],
    ["offline-alert-after:168h", 168 * 60],
    ["offline-alert-after:1m", null],
    ["offline-alert-after:169h", null],
    ["offline-alert-after:3d", null],
    ["offline-alert-after:0h", null],
    ["offline-alert-after:3", null],
    ["offline-alert-after:+3h", null],
    ["offline-alert-after: 3h", null],
    ["offline-alert-after:99999999h", null],
    ["cd", null],
  ];
  for (const [tag, want] of cases) assert.equal(parseDelayTag(tag), want, tag);
});

test("policy: quiet wins, the longest delay wins, a bad tag is reported and falls back", () => {
  const policy = nodeOfflinePolicy([
    { id: "n1", name: "[cd]-mac-air", tags: ["cd", "offline-alert-after:3h"] },
    { id: "n2", name: "[cd]-xiaoxin", tags: ["offline-alert-after:30m", "offline-alert-after:3h"] },
    { id: "n3", name: "edge", tags: ["offline-alert-after:45m"] },
    { id: "n4", name: "laptop", tags: ["offline-alert-after:3h", "no-offline-alert"] },
    { id: "n5", name: "typo", tags: ["offline-alert-after:3d"] },
    { id: "n6", tags: [] },
    { id: "n7", name: "plain", tags: null },
  ]);
  assert.deepEqual(policy.delayed, [
    { name: "[cd]-mac-air", minutes: 180 },
    { name: "[cd]-xiaoxin", minutes: 180 },
    { name: "edge", minutes: 45 },
  ]);
  assert.deepEqual(policy.quiet, ["laptop"]);
  assert.deepEqual(policy.invalid, [{ name: "typo", tag: "offline-alert-after:3d" }]);
  // typo, n6 (named by id) and plain page after the default.
  assert.equal(policy.defaultCount, 3);
  assert.equal(DEFAULT_OFFLINE_MINUTES, 10);
});

test("delays read as minutes under an hour and hours after", () => {
  assert.equal(formatOfflineDelay(10), "10 min");
  assert.equal(formatOfflineDelay(180), "3 h");
  assert.equal(formatOfflineDelay(90), "1 h 30 min");
});
