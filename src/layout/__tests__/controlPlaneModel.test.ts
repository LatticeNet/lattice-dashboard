import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildControlPlaneIdentity,
  controlPlaneInitials,
  controlPlaneKind,
} from "../controlPlaneModel.ts";

test("a loopback origin is a copy, whatever it serves", () => {
  // The console looks identical on both; the address bar was the only thing
  // separating "approve this plan" from "poke at a copy".
  assert.equal(controlPlaneKind("localhost:5273"), "local");
  assert.equal(controlPlaneKind("127.0.0.1:8088"), "local");
  assert.equal(controlPlaneKind("lab.local"), "local");
  assert.equal(controlPlaneKind("box.internal"), "local");
  assert.equal(controlPlaneKind("lattice.roobli.org"), "remote");
});

test("the version is never guessed", () => {
  const identity = buildControlPlaneIdentity({ host: "lattice.roobli.org" });
  assert.equal(identity.version, "");
  assert.equal(identity.kind, "remote");
});

test("dashboard drift needs both halves to be known", () => {
  const known = buildControlPlaneIdentity({
    host: "lattice.roobli.org",
    dashboardRef: "aaa",
    expectedDashboardRef: "bbb",
  });
  assert.equal(known.dashboardDrift, true);

  const half = buildControlPlaneIdentity({ host: "lattice.roobli.org", dashboardRef: "aaa" });
  assert.equal(half.dashboardDrift, false);
});

test("the rail marker comes from the host, not from a setting", () => {
  assert.equal(controlPlaneInitials("localhost:5273"), "dev");
  assert.equal(controlPlaneInitials("lattice.roobli.org"), "lat");
});
