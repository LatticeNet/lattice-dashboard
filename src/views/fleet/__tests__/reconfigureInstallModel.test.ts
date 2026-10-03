import assert from "node:assert/strict";
import { test } from "node:test";

import { reconfigureInstall } from "../reconfigureInstallModel.ts";

test("a node on the pinned release reinstalls it and does not move", () => {
  assert.deepEqual(reconfigureInstall("v0.3.9", "0.3.9", "linux"), { target: "v0.3.9", current: "0.3.9", moves: false });
});

test("a node on a newer prerelease or an older release moves to the pinned release", () => {
  assert.equal(reconfigureInstall("v0.3.9", "0.3.10-alpha.1", "linux")?.moves, true);
  assert.equal(reconfigureInstall("v0.3.9", "0.3.8", "linux")?.moves, true);
});

test("a node that never reported a version gets the install note without a move", () => {
  assert.deepEqual(reconfigureInstall("v0.3.9", "", "linux"), { target: "v0.3.9", current: "", moves: false });
  assert.deepEqual(reconfigureInstall("v0.3.9", undefined, "linux"), { target: "v0.3.9", current: "", moves: false });
});

test("the manual command installs nothing, and an older server names no release", () => {
  assert.equal(reconfigureInstall("v0.3.9", "0.3.10-alpha.1", "manual"), undefined);
  assert.equal(reconfigureInstall(undefined, "0.3.9", "linux"), undefined);
  assert.equal(reconfigureInstall("  ", "0.3.9", "linux"), undefined);
});
