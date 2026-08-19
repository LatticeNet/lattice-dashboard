import assert from "node:assert/strict";
import test from "node:test";

import { PluginFrameLifecycle } from "../pluginFrameModel.ts";

function lifecycle(options: { now?: () => number; maxRotations?: number; windowMs?: number } = {}) {
  let counter = 0;
  return new PluginFrameLifecycle({
    createNonce: () => `nonce-${++counter}`,
    ...options,
  });
}

test("the first load of an element is a normal handshake", () => {
  const frame = lifecycle();
  const first = frame.nonce;

  assert.deepEqual(frame.noteLoad(), { action: "handshake" });
  assert.equal(frame.nonce, first, "the boot nonce must survive its own load");
});

test("a reload revokes the session and rotates the nonce", () => {
  const frame = lifecycle();
  const boot = frame.nonce;
  frame.noteLoad();

  const outcome = frame.noteLoad();

  assert.equal(outcome.action, "rotate");
  assert.notEqual(frame.nonce, boot, "a replaced document must not inherit the live nonce");
  assert.equal(outcome.action === "rotate" && outcome.nonce, frame.nonce);
});

// Regression: rotation used to be expressed as a fragment-only `src` change, which the
// browser resolves as a same-document navigation. So no `load` fired, the rotating flag
// stuck, and the NEXT real reload took an early-return branch that skipped dispose and
// nonce rotation entirely, carrying a bridge session across a document replacement.
test("every reload rotates. A second reload is never silently trusted", () => {
  const frame = lifecycle();
  const boot = frame.nonce;

  assert.deepEqual(frame.noteLoad(), { action: "handshake" });

  const first = frame.noteLoad();
  assert.equal(first.action, "rotate");
  const afterFirst = frame.nonce;

  // The remounted element boots: that is its own first load, not a rotation.
  assert.deepEqual(frame.noteLoad(), { action: "handshake" });
  assert.equal(frame.nonce, afterFirst, "the remounted element keeps the nonce it booted with");

  // The second reload must rotate again rather than reuse the live session.
  const second = frame.noteLoad();
  assert.equal(second.action, "rotate");

  const nonces = [boot, afterFirst, frame.nonce];
  assert.equal(new Set(nonces).size, 3, "each document generation must get a distinct nonce");
});

test("a reload loop is capped instead of spinning frame churn forever", () => {
  const frame = lifecycle({ maxRotations: 3, windowMs: 10_000, now: () => 1_000 });
  frame.noteLoad();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(frame.noteLoad().action, "rotate", `rotation ${attempt + 1} is within budget`);
    frame.noteLoad(); // the remounted element boots
  }

  assert.deepEqual(frame.noteLoad(), { action: "exhausted" }, "past the cap the frame stays down");
});

test("the rotation budget refills once the window passes", () => {
  let clock = 1_000;
  const frame = lifecycle({ maxRotations: 1, windowMs: 10_000, now: () => clock });
  frame.noteLoad();

  assert.equal(frame.noteLoad().action, "rotate");
  frame.noteLoad();
  assert.equal(frame.noteLoad().action, "exhausted", "budget is spent inside the window");

  clock += 10_001;
  assert.equal(frame.noteLoad().action, "rotate", "a later reload is legitimate again");
});
