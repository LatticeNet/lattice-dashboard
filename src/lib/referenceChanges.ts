/**
 * The operator's own writes to objects that name other objects (design 32
 * S3b). A node group's Used by and a node's Network section read what names
 * the group or reaches the node; when this session saves or deletes such an
 * object, an open view reads again instead of showing the state from before
 * the write. The API client reports the writes (afterReferenceChange), the
 * views listen (useRefreshOnReturn). In-page only: another tab is covered by
 * the focus and visibility refresh.
 *
 * Pure TS, so `node --test` covers it directly.
 */

export type ReferenceKind = "outbound_policy" | "check" | "group";

type Listener = (kind: ReferenceKind) => void;

const listeners = new Set<Listener>();

export function notifyReferenceChange(kind: ReferenceKind): void {
  for (const listener of [...listeners]) listener(kind);
}

/** Subscribes; the returned function unsubscribes. */
export function onReferenceChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A write's result, passed through, with the listeners told once it succeeded. */
export function afterReferenceChange<T>(kind: ReferenceKind, write: Promise<T>): Promise<T> {
  return write.then((result) => {
    notifyReferenceChange(kind);
    return result;
  });
}

/**
 * Whether a return to the page (window focus, the tab becoming visible)
 * should read again: both events fire for one return, so a second within
 * gapMs of the last read is the same return.
 */
export function returnRefreshDue(lastAt: number | undefined, now: number, gapMs = 1000): boolean {
  return lastAt === undefined || now - lastAt >= gapMs;
}
