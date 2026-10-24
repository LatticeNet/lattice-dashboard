/**
 * A save's refusal and conflict state for an editor (design 32 R6; the pure
 * half is lib/saveRefusal.ts, the footer is SaveRefusal.vue).
 *
 * The editor marks each control with data-field="<request path>" (the path
 * the server names, such as "targets" or "interval_sec") inside root, and
 * hands every caught save error to handle():
 *
 *   - a version conflict rereads the object through reread, keeps the
 *     editor open with its draft, and names the compared paths that changed
 *     between the version the editor opened (base) and the server's now;
 *   - any other refusal keeps its message, and when the server named a
 *     field, focuses the control that edits it and marks it invalid,
 *     described by the message, until the operator edits the draft or
 *     clear() runs.
 *
 * The editor answers the conflict itself: reload theirs (take latest as the
 * new base and draft) or save mine over it (save the draft naming latest's
 * version).
 */
import { nextTick, onBeforeUnmount, ref, shallowRef, watch, type Ref, type WatchSource } from "vue";

import { changedFields, isVersionConflict, refusalOf, resolveField, type SaveRefusal } from "@/lib/saveRefusal";

export interface SaveConflict<T> {
  /** The server's version now: what reload takes, and whose version an overwrite names. */
  latest: T;
  /** The compared paths that differ between the opened version and latest. */
  changed: string[];
}

export interface SaveRefusalOptions {
  /** The element whose [data-field] descendants are the editor's controls. */
  root: Ref<HTMLElement | null | undefined>;
  /** The request paths a conflict compares, in the order it names them. */
  compared: readonly string[];
  /** The draft: an edit clears a field refusal, which no longer describes it. */
  draft?: WatchSource<unknown>;
}

export interface HandleOptions<T> {
  /** The message when the error carries none. */
  fallback: string;
  /** The version the editor opened, in the request's shape. */
  base: unknown;
  /** Reads the object again for a conflict. */
  reread: () => Promise<T>;
  /** latest in the request's shape, when it differs (a view with extras). */
  shape?: (latest: T) => unknown;
}

let sequence = 0;

const FOCUSABLE = "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function useSaveRefusal<T>(options: SaveRefusalOptions) {
  const refusal = ref<SaveRefusal>();
  const conflict = shallowRef<SaveConflict<T>>();
  /** The registered path the refusal marked, undefined when none. */
  const marked = ref<string>();
  const messageId = `save-refusal-${++sequence}`;

  // What the mark changed on the control, to put back.
  let undo: (() => void) | undefined;

  function unmark(): void {
    undo?.();
    undo = undefined;
    marked.value = undefined;
  }

  function mark(field: string | undefined): void {
    unmark();
    const root = options.root.value;
    if (!root || !field) return;
    const holders = Array.from(root.querySelectorAll<HTMLElement>("[data-field]"));
    const path = resolveField(
      field,
      holders.map((el) => el.dataset.field ?? ""),
    );
    const holder = holders.find((el) => el.dataset.field === path);
    if (!holder || !path) return;
    const control = holder.matches(FOCUSABLE) ? holder : holder.querySelector<HTMLElement>(FOCUSABLE);
    const priorInvalid = control?.getAttribute("aria-invalid");
    const priorDescribed = control?.getAttribute("aria-describedby");
    holder.dataset.invalid = "true";
    if (control) {
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", [priorDescribed, messageId].filter(Boolean).join(" "));
      control.focus({ preventScroll: false });
      control.scrollIntoView?.({ block: "nearest" });
    }
    marked.value = path;
    undo = () => {
      delete holder.dataset.invalid;
      if (!control) return;
      if (priorInvalid === null) control.removeAttribute("aria-invalid");
      else control.setAttribute("aria-invalid", priorInvalid ?? "");
      if (priorDescribed === null) control.removeAttribute("aria-describedby");
      else control.setAttribute("aria-describedby", priorDescribed ?? "");
    };
  }

  /** Forgets the refusal and the conflict, and unmarks the field. */
  function clear(): void {
    unmark();
    refusal.value = undefined;
    conflict.value = undefined;
  }

  /**
   * Takes a caught save error: "conflict" when someone saved in between (the
   * draft stays), "refused" otherwise.
   */
  async function handle(error: unknown, how: HandleOptions<T>): Promise<"conflict" | "refused"> {
    unmark();
    refusal.value = undefined;
    if (isVersionConflict(error)) {
      try {
        const latest = await how.reread();
        const shaped = how.shape ? how.shape(latest) : latest;
        conflict.value = { latest, changed: changedFields(how.base, shaped, options.compared) };
        return "conflict";
      } catch (reread) {
        // The draft stays either way; say why the newer version is not shown.
        refusal.value = refusalOf(reread, how.fallback);
        return "refused";
      }
    }
    conflict.value = undefined;
    refusal.value = refusalOf(error, how.fallback);
    await nextTick();
    mark(refusal.value.field);
    return "refused";
  }

  if (options.draft) {
    watch(
      options.draft,
      () => {
        if (refusal.value && !conflict.value) {
          unmark();
          refusal.value = undefined;
        }
      },
      { deep: true },
    );
  }
  onBeforeUnmount(unmark);

  return { refusal, conflict, marked, messageId, handle, clear };
}
