/**
 * The hold behind an incident list's Acknowledge, Undo and Snooze
 * (useIncidentActions), kept free of Vue and the DOM so it can be tested.
 *
 * An action holds the rows in the order they were shown and pins the row it
 * acted on, so that row stays listed under a filter it no longer matches
 * (Acknowledge or Snooze under Open). Everything the actions hold is released
 * together, as one group. A row released on its own clock while a later one
 * is still held would close its gap and slide the rows below it under a
 * pointer that has not moved, where the next press acknowledges an incident
 * nobody chose.
 *
 * The group goes once the last action is `holdMs` old and `blocked()` no
 * longer reports anything that needs the rows where they are (the caller's
 * pointer over the list, keyboard focus on an Undo). While blocked it asks
 * again every `recheckMs`, and at once whenever `check()` is called.
 *
 * Anything else an action leaves on screen for the same time joins the same
 * group through `keep()`: End now's ended banner line, which would otherwise
 * expire on its own clock and move the whole list below it.
 */

export interface ActionHoldState {
  /** Row ids in the order they had when an action was pressed, while that order is held. */
  order: readonly string[] | null;
  /** Rows whose Acknowledge landed: they show Undo in Acknowledge's place. */
  undoable: ReadonlySet<string>;
  /** Undoable rows whose Undo landed: Undo stays, inert, until the list shows them open. */
  undone: ReadonlySet<string>;
  /** Rows that stay listed whatever the filter says. */
  pinned: ReadonlySet<string>;
  /** Other keys the caller keeps on screen until the group goes (ended banner lines). */
  kept: ReadonlySet<string>;
}

export interface ActionHoldOptions {
  holdMs: number;
  /** True while something on screen still needs the rows where they are. */
  blocked: () => boolean;
  /** Called after every change to the state. */
  changed: () => void;
  recheckMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export interface ActionHold {
  state(): ActionHoldState;
  /** An action was pressed on rows shown in `order` (omitted: keep the order already held). */
  begin(order?: readonly string[]): void;
  /** Acknowledge landed: the row offers Undo and stays listed. */
  acked(id: string): void;
  /** Snooze was pressed: the row stays listed. */
  snoozed(id: string): void;
  /** Something else was acted on and stays on screen with the group (`kept`). */
  keep(key: string): void;
  /** Undo landed: Acknowledge comes back once the list shows the row open (undoSlot). */
  undone(id: string): void;
  /** The row can no longer be undone (the server refused): it shows what its state allows. */
  closeUndo(id: string): void;
  /** Something blocked() reads may have changed: release now if the group may go. */
  check(): void;
  /** Whether the group's time is up and only a block keeps it: a pointer move may then free it. */
  due(): boolean;
  /** Drop the group at once: the view changed under it (a filter, a search). */
  release(): void;
  /**
   * Put the rows in their place now (the operator pressed Show) but keep
   * what `keep()` holds: an ended banner line above the list going at the
   * same moment would move the whole list under the finger that pressed.
   */
  releaseRows(): void;
  dispose(): void;
}

const EMPTY: ReadonlySet<string> = new Set();

function plus(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return set.has(id) ? set : new Set([...set, id]);
}

function minus(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

export function createActionHold(options: ActionHoldOptions): ActionHold {
  const recheckMs = options.recheckMs ?? 500;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());

  let state: ActionHoldState = { order: null, undoable: EMPTY, undone: EMPTY, pinned: EMPTY, kept: EMPTY };
  let deadline = 0;
  let timer: unknown;

  function active(): boolean {
    return state.order !== null || state.undoable.size > 0 || state.pinned.size > 0 || state.kept.size > 0;
  }

  function arm(ms: number): void {
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      check();
    }, ms);
  }

  function set(next: Partial<ActionHoldState>): void {
    state = { ...state, ...next };
    options.changed();
  }

  /** Every action restarts the group's time: the pointer that pressed it is still there. */
  function extend(): void {
    deadline = now() + options.holdMs;
    arm(options.holdMs);
  }

  function release(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (!active()) return;
    set({ order: null, undoable: EMPTY, undone: EMPTY, pinned: EMPTY, kept: EMPTY });
  }

  function check(): void {
    if (!active()) return;
    const left = deadline - now();
    if (left > 0) return arm(left);
    if (options.blocked()) return arm(recheckMs);
    release();
  }

  return {
    state: () => state,
    begin(order) {
      extend();
      if (order?.length) set({ order: [...order] });
    },
    acked(id) {
      extend();
      set({ undoable: plus(state.undoable, id), undone: minus(state.undone, id), pinned: plus(state.pinned, id) });
    },
    snoozed(id) {
      extend();
      set({ pinned: plus(state.pinned, id) });
    },
    keep(key) {
      extend();
      set({ kept: plus(state.kept, key) });
    },
    undone(id) {
      extend();
      if (state.undoable.has(id)) set({ undone: plus(state.undone, id) });
    },
    closeUndo(id) {
      set({ undoable: minus(state.undoable, id), undone: minus(state.undone, id) });
    },
    check,
    due: () => active() && now() >= deadline,
    release,
    releaseRows() {
      if (state.order === null && state.undoable.size === 0 && state.pinned.size === 0) return;
      set({ order: null, undoable: EMPTY, undone: EMPTY, pinned: EMPTY });
      if (!active()) release();
    },
    dispose() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

/**
 * What a row shows in Acknowledge's place. "undo" from the moment its
 * Acknowledge lands (the list may still say open until it is read again);
 * "settling", an inert Undo, from the moment its Undo lands until the list
 * shows it open; then null, and the row shows what its state allows. So
 * neither press leaves an Acknowledge under the pointer before the list
 * agrees, where a second press would act again.
 */
export function undoSlot(id: string, state: string, hold: Pick<ActionHoldState, "undoable" | "undone">): "undo" | "settling" | null {
  if (!hold.undoable.has(id)) return null;
  if (!hold.undone.has(id)) return "undo";
  return state === "acknowledged" ? "settling" : null;
}

/** A rectangle in viewport pixels, as getBoundingClientRect gives it. */
export interface ZoneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where the pointer is, for `blocked()`. A mouse or pen is tracked by its
 * position and compared with the zone's rectangle when the hold asks, not by
 * the zone's pointerenter and pointerleave: a modal menu sets
 * `pointer-events: none` on the body, which fires pointerleave on the list
 * while the pointer has not moved, and nothing fires pointerenter again when
 * the menu closes. A finger does not hover, so after a tap the hold stays
 * until the page scrolls.
 */
export interface PointerWatch {
  /** A pointer moved or went down at (x, y). */
  pointer(type: string, x: number, y: number, down: boolean): void;
  /** The mouse left the window. */
  left(): void;
  /** The page scrolled; true when that ended a finger's hold. */
  scrolled(): boolean;
  /** Whether the pointer still needs what is in `zone` to stay where it is. */
  holds(zone: ZoneRect | null): boolean;
}

export function createPointerWatch(): PointerWatch {
  let at: { x: number; y: number } | null = null;
  let touched = false;
  return {
    pointer(type, x, y, down) {
      if (type === "touch") {
        if (down) touched = true;
        return;
      }
      at = { x, y };
      touched = false;
    },
    left() {
      at = null;
    },
    scrolled() {
      if (!touched) return false;
      touched = false;
      return true;
    },
    holds(zone) {
      if (touched) return true;
      if (!at || !zone) return false;
      return at.x >= zone.left && at.x <= zone.right && at.y >= zone.top && at.y <= zone.bottom;
    },
  };
}
