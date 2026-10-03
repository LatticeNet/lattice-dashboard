/**
 * Keyboard for a keyboard operator (r1-ux item 18b). The pure decisions, so
 * they can be tested without a browser; useKeyboardShortcuts wires them to
 * the window and the DOM.
 *
 *   /            the page's search field
 *   j k, ↓ ↑     next and previous row, while a row has focus (DataTable)
 *   [ ]          previous and next row in the open sheet
 *   g then a key a page (g n Nodes, g a Approvals, ...)
 *   ?            the list of these
 *
 * None of them fire while the operator types (a field, a select, an
 * editable region), inside Terminal (the shell owns its keys), with Ctrl,
 * Cmd or Alt held (the browser's and the palette's), or while a dialog or
 * menu has the keyboard, except the sheet keys, which exist for the sheet.
 */

export type KeyTarget = "terminal" | "editable" | "other";

/** Where a key lands: the shell's input, a field the operator types in, or anything else. */
export function keyTargetOf(el: Element | null): KeyTarget {
  if (!el) return "other";
  // xterm's hidden input: every key there is the shell's.
  if (el.classList.contains("xterm-helper-textarea") || el.closest(".xterm")) return "terminal";
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable) return "editable";
  return "other";
}

/** `g` then this key goes to that destination (a nav name), when the principal can open it. */
export const GO_KEYS: Readonly<Record<string, string>> = {
  h: "overview",
  n: "nodes",
  a: "approvals",
  t: "tasks",
  u: "upcoming",
  i: "inventory",
  m: "monitoring",
  l: "audit",
  v: "plugin:latticenet.vpn-core:users",
};

/** How long a `g` waits for its second key. */
export const GO_TIMEOUT_MS = 1500;

export type ShortcutAction =
  | { kind: "focus-search" }
  | { kind: "step-sheet"; direction: -1 | 1 }
  | { kind: "go-pending" }
  | { kind: "go"; page: string }
  | { kind: "help" };

export interface ShortcutKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export interface ShortcutContext {
  target: KeyTarget;
  /** An object sheet is open. */
  sheetOpen: boolean;
  /** The open sheet is modal (below 768 px): the page behind it is out of reach. */
  sheetModal: boolean;
  /** Another dialog (palette, confirm, this list) or a menu has the keyboard. */
  overlayOpen: boolean;
  /** A `g` was pressed and is waiting for its second key. */
  goPending: boolean;
}

export function shortcutFor(event: ShortcutKeyEvent, ctx: ShortcutContext): ShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (ctx.target !== "other" || ctx.overlayOpen) return null;
  const key = event.key;
  if (ctx.goPending) {
    const page = GO_KEYS[key.toLowerCase()];
    return page && !ctx.sheetModal ? { kind: "go", page } : null;
  }
  if (event.repeat && key !== "[" && key !== "]") return null;
  if (ctx.sheetOpen && (key === "[" || key === "]")) return { kind: "step-sheet", direction: key === "[" ? -1 : 1 };
  if (ctx.sheetModal) return null;
  if (key === "/") return { kind: "focus-search" };
  if (key === "g") return { kind: "go-pending" };
  if (key === "?") return { kind: "help" };
  return null;
}

/**
 * The row to focus after a key on a row, or -1 when the key is not a move.
 * A list does not wrap: the last row stays the last, so holding j stops at
 * the end rather than jumping back to the top unseen.
 */
export function nextRowIndex(count: number, current: number, key: string): number {
  if (count <= 0) return -1;
  const at = current < 0 || current >= count ? -1 : current;
  switch (key) {
    case "ArrowDown":
    case "j":
      return at < 0 ? 0 : Math.min(at + 1, count - 1);
    case "ArrowUp":
    case "k":
      return at < 0 ? 0 : Math.max(at - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return -1;
  }
}

/** The row `direction` away from the open one, or -1 at either end or when none is open. */
export function steppedRowIndex(count: number, current: number, direction: -1 | 1): number {
  if (current < 0 || current >= count) return -1;
  const next = current + direction;
  return next >= 0 && next < count ? next : -1;
}
