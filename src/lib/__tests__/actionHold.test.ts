import assert from "node:assert/strict";
import { test } from "node:test";

import { createActionHold, undoSlot } from "../actionHold.ts";

/** A clock and timers the test moves by hand. */
function fakeTime() {
  let clock = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => clock,
    setTimer: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        clock = due[1].at;
        due[1].run();
      }
      clock = end;
    },
  };
}

function setup(blocked = () => false) {
  const time = fakeTime();
  let changes = 0;
  const hold = createActionHold({ holdMs: 10_000, recheckMs: 500, blocked: () => blocked(), changed: () => changes++, ...time });
  return { hold, time, changes: () => changes };
}

test("rows acted on in turn are released together, when the last action's time is up", () => {
  const { hold, time } = setup();
  // Acknowledge DMIT-4, then bandwagon-dc6 3 s later, under Open.
  hold.begin(["dmit4", "bandwagon", "dmit1"]);
  hold.acked("dmit4");
  time.advance(3_000);
  hold.begin(["dmit4", "bandwagon", "dmit1"]);
  hold.acked("bandwagon");
  // At 10.1 s DMIT-4's own time is up, but bandwagon is still held: DMIT-4
  // must stay, or DMIT-1's Acknowledge slides under bandwagon's point.
  time.advance(7_100);
  assert.deepEqual([...hold.state().pinned].sort(), ["bandwagon", "dmit4"]);
  assert.deepEqual(hold.state().order, ["dmit4", "bandwagon", "dmit1"]);
  assert.equal(hold.state().undoable.has("dmit4"), true);
  // Both go at once when bandwagon's time is up.
  time.advance(2_900);
  assert.equal(hold.state().pinned.size, 0);
  assert.equal(hold.state().undoable.size, 0);
  assert.equal(hold.state().order, null);
});

test("the group stays while blocked (a pointer over the list, keyboard focus on an Undo) and goes when that ends", () => {
  let pointerOver = true;
  const { hold, time } = setup(() => pointerOver);
  hold.begin(["a", "b"]);
  hold.acked("a");
  time.advance(60_000);
  assert.equal(hold.state().pinned.has("a"), true, "a pointer resting on the list keeps every row where it is");
  pointerOver = false;
  hold.check();
  assert.equal(hold.state().pinned.size, 0, "pointerleave releases at once");
});

test("a blocked group is checked again on its own, so it goes soon after the block ends without an event", () => {
  let blocked = true;
  const { hold, time } = setup(() => blocked);
  hold.begin(["a"]);
  hold.snoozed("a");
  time.advance(12_000);
  assert.equal(hold.state().pinned.has("a"), true);
  blocked = false;
  time.advance(500);
  assert.equal(hold.state().pinned.size, 0);
});

test("check() before the time is up releases nothing", () => {
  const { hold, time } = setup();
  hold.begin(["a"]);
  hold.acked("a");
  time.advance(4_000);
  hold.check();
  assert.equal(hold.state().pinned.has("a"), true);
});

test("an Undo that landed keeps the row pinned and its Undo inert until the list shows it open", () => {
  const { hold, time } = setup();
  hold.begin(["dmit4", "bandwagon"]);
  hold.acked("dmit4");
  time.advance(2_000);
  hold.begin();
  hold.undone("dmit4");
  const state = hold.state();
  // Before the re-read the row still says acknowledged: it must not leave
  // Open, and no Acknowledge may appear where the Undo was.
  assert.equal(state.pinned.has("dmit4"), true);
  assert.equal(undoSlot("dmit4", "acknowledged", state), "settling");
  // Once the list shows it open, Acknowledge comes back in the same place.
  assert.equal(undoSlot("dmit4", "open", state), null);
  // The Undo restarted the group's time: the pointer that pressed it is still there.
  time.advance(9_000);
  assert.equal(hold.state().pinned.has("dmit4"), true);
  time.advance(1_000);
  assert.equal(hold.state().pinned.size, 0);
});

test("a row offers Undo from the moment its Acknowledge lands, before the list is read again", () => {
  const { hold } = setup();
  hold.begin(["a"]);
  hold.acked("a");
  assert.equal(undoSlot("a", "open", hold.state()), "undo");
  assert.equal(undoSlot("a", "acknowledged", hold.state()), "undo");
  assert.equal(undoSlot("b", "open", hold.state()), null);
});

test("acknowledging again after an Undo offers Undo again", () => {
  const { hold } = setup();
  hold.begin(["a"]);
  hold.acked("a");
  hold.undone("a");
  hold.acked("a");
  assert.equal(undoSlot("a", "open", hold.state()), "undo");
});

test("a refused Undo closes the row's Undo but keeps its pin", () => {
  const { hold } = setup();
  hold.begin(["a"]);
  hold.acked("a");
  hold.closeUndo("a");
  assert.equal(undoSlot("a", "acknowledged", hold.state()), null);
  assert.equal(hold.state().pinned.has("a"), true);
});

test("release() drops the group at once, and a second release changes nothing", () => {
  const { hold, changes } = setup(() => true);
  hold.begin(["a"]);
  hold.acked("a");
  const before = changes();
  hold.release();
  assert.equal(hold.state().pinned.size, 0);
  assert.equal(hold.state().order, null);
  assert.equal(changes(), before + 1);
  hold.release();
  assert.equal(changes(), before + 1);
});

test("a later action keeps the order already held when it does not pass one", () => {
  const { hold } = setup();
  hold.begin(["a", "b", "c"]);
  hold.begin(undefined);
  assert.deepEqual(hold.state().order, ["a", "b", "c"]);
});
