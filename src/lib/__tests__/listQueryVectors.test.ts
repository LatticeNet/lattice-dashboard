/**
 * The shared list query vectors (src/lib/query/vectors.ts and vectors.json),
 * byte-identical in lattice-plugin-bridge, which runs them against its port
 * of this core and, in CI, against this core too. A failure here means the
 * grammar or the engine changed: port the change to the bridge and update the
 * vectors in both repositories in the same sitting.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as complete from "../query/complete.ts";
import * as engine from "../query/engine.ts";
import * as syntax from "../query/syntax.ts";
import * as values from "../query/values.ts";
import { runQueryVectors, type QueryCore, type QueryVectors } from "../query/vectors.ts";

const vectors = JSON.parse(readFileSync(new URL("../query/vectors.json", import.meta.url), "utf8")) as QueryVectors;

test("the shared list query vectors pass against the console's core", () => {
  // The core's generic signatures are wider than the runner's plain-data schema; the vectors check behaviour, not types.
  const core = { ...syntax, ...engine, ...complete, ...values } as unknown as QueryCore;
  assert.deepEqual(runQueryVectors(core, vectors), []);
});
