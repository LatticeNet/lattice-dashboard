import assert from "node:assert/strict";
import { test } from "node:test";

import type { MonitorSettings } from "@/lib/api/types";

import { FINE_BYTES_PER_PATH_DAY, largeMesh, lowersRetention, projectedBytesAt, retentionBounds, retentionValid } from "../retentionModel.ts";

const SETTINGS: MonitorSettings = {
  version: 2,
  fine_retention_days: 7,
  fine_min_days: 3,
  fine_max_days: 14,
  coarse_retention_days: 35,
  raw_rows_per_path: 1440,
  paths: 100,
  measured_bytes: 31_000_000,
  projected_bytes: 73_000_000,
};

test("bounds come from the server, with design 29's defaults when it sends none", () => {
  assert.deepEqual(retentionBounds(SETTINGS), { min: 3, max: 14 });
  assert.deepEqual(retentionBounds({ fine_min_days: 0, fine_max_days: 0 }), { min: 3, max: 14 });
  assert.equal(retentionValid(3, SETTINGS), true);
  assert.equal(retentionValid(14, SETTINGS), true);
  assert.equal(retentionValid(2, SETTINGS), false);
  assert.equal(retentionValid(15, SETTINGS), false);
  assert.equal(retentionValid(7.5, SETTINGS), false);
});

test("projection moves by the fine tier's cost per path per day from the server's figure", () => {
  assert.equal(projectedBytesAt(SETTINGS, 7), 73_000_000);
  assert.equal(projectedBytesAt(SETTINGS, 14), 73_000_000 + 7 * 100 * FINE_BYTES_PER_PATH_DAY);
  assert.equal(projectedBytesAt(SETTINGS, 3), 73_000_000 - 4 * 100 * FINE_BYTES_PER_PATH_DAY);
  assert.equal(projectedBytesAt({ ...SETTINGS, projected_bytes: 0 }, 3), 0, "never below zero");
});

test("lowering frees space for reuse, and a large fast mesh warns", () => {
  assert.equal(lowersRetention(SETTINGS, 3), true);
  assert.equal(lowersRetention(SETTINGS, 7), false);
  assert.equal(largeMesh(301, 15), true);
  assert.equal(largeMesh(301, 30), false);
  assert.equal(largeMesh(300, 10), false);
  assert.equal(largeMesh(600, undefined), false);
});
