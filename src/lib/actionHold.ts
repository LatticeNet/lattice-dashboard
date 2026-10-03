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
  /** Undo landed: Acknowledge comes back once the list shows the row open (undoSlot). */
  undone(id: string): void;
  /** The row can no longer be undone (the server refused): it shows what its state allows. */
  closeUndo(id: string): void;
  /** Something blocked() reads may have changed: release now if the group may go. */
  check(): void;
  /** Drop the group at once: the view changed under it (a filter, a search). */
  release(): void;
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

  let state: ActionHoldState = { order: null, undoable: EMPTY, undone: EMPTY, pinned: EMPTY };
  let deadline = 0;
  let timer: unknown;

  function active(): boolean {
    return state.order !== null || state.undoable.size > 0 || state.pinned.size > 0;
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
    set({ order: null, undoable: EMPTY, undone: EMPTY, pinned: EMPTY });
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
    undone(id) {
      extend();
      if (state.undoable.has(id)) set({ undone: plus(state.undone, id) });
    },
    closeUndo(id) {
      set({ undoable: minus(state.undoable, id), undone: minus(state.undone, id) });
    },
    check,
    release,
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
