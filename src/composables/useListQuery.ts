/**
 * A list page's query (src/lib/query) as reactive state: the rows it keeps,
 * in the order it asks for, and the problem with the text when it has one.
 *
 * An invalid query keeps the last valid one running, so a half-typed
 * `cpu>` or a typo never empties the list under the operator; `stale` says
 * the rows on screen answer an earlier query, and the bar says so beside the
 * error. "The last valid one" is the last that stood still for
 * SETTLE_MS: typing `cpu>80` passes through `cpu`, a bare word that matches
 * almost nothing, and falling back to that would show the operator a list
 * for a query they never meant. A query that was invalid from the start (a
 * pasted link) runs as the empty query: every row.
 */
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref, type WritableComputedRef } from "vue";

import {
  applyQuery,
  compileQuery,
  describeFields,
  type CompiledQuery,
  type QueryFieldInfo,
  type QuerySchema,
} from "@/lib/query/engine";
import type { QueryError } from "@/lib/query/syntax";

/** How long a valid query must stand before an invalid one falls back to it. */
export const SETTLE_MS = 400;
/**
 * How long an error waits after the last keystroke before it is shown:
 * `status:` is an error for the moment between the colon and the value, and
 * flashing it there reads as a complaint about typing. Enter and leaving the
 * field show it at once (`reveal`).
 */
export const ERROR_DELAY_MS = 600;
/** How long the address bar waits after the last keystroke before it records the query. */
export const URL_WRITE_MS = 300;

/** What a query field reads from a page's query, whatever the page's rows are. */
export interface ListQueryState {
  fields: Readonly<Ref<QueryFieldInfo[]>>;
  error: Readonly<Ref<QueryError | null>>;
  shownError: Readonly<Ref<QueryError | null>>;
  reveal: () => void;
  stale: Readonly<Ref<boolean>>;
  /** The query that ran: its text, and whether it asks for anything. */
  active: Readonly<Ref<{ empty: boolean; source: string }>>;
}

export interface ListQuery<T> extends ListQueryState {
  /** The rows the query keeps, ordered by its sort (or relevance). */
  rows: Readonly<Ref<T[]>>;
  /** The problem with the text, or null. */
  error: Readonly<Ref<QueryError | null>>;
  /** The error once the typing has paused on it (or `reveal` was called); what the bar shows. */
  shownError: Readonly<Ref<QueryError | null>>;
  /** Show the current error now: Enter, or the field losing focus. */
  reveal: () => void;
  /**
   * The rows on screen answer an earlier query and the operator has been told
   * so: a page dims its list while this holds, so nobody selects or acts on
   * rows for a query they can no longer see.
   */
  invalid: Readonly<Ref<boolean>>;
  /** The rows answer an earlier, valid query because the text is not one. */
  stale: Readonly<Ref<boolean>>;
  /** The query that ran. */
  active: Readonly<Ref<CompiledQuery<T>>>;
  /** The query narrows or orders the list. */
  filtering: Readonly<Ref<boolean>>;
  /** The query carries `sort:`, which replaces the page's own order. */
  sorted: Readonly<Ref<boolean>>;
  /** Field descriptions with values read from the rows, for the bar. */
  fields: Readonly<Ref<QueryFieldInfo[]>>;
}

export function useListQuery<T>(source: Readonly<Ref<readonly T[]>>, schema: QuerySchema<T>, text: Readonly<Ref<string>>): ListQuery<T> {
  const compiled = computed(() => compileQuery(text.value, schema));
  const empty = compileQuery<T>("", schema) as { ok: true; query: CompiledQuery<T> };
  const settled = shallowRef<CompiledQuery<T>>(compiled.value.ok ? compiled.value.query : empty.query);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(compiled, (result) => {
    clearTimeout(timer);
    if (!result.ok) return;
    timer = setTimeout(() => {
      settled.value = result.query;
    }, SETTLE_MS);
  });
  onScopeDispose(() => clearTimeout(timer));

  const active = computed(() => (compiled.value.ok ? compiled.value.query : settled.value));
  const error = computed(() => (compiled.value.ok ? null : compiled.value.error));
  const rows = computed(() => applyQuery(source.value, active.value));

  // A query that arrives invalid (a pasted link) is shown at once.
  const shownError = shallowRef<QueryError | null>(error.value);
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  watch(error, (next) => {
    clearTimeout(errorTimer);
    if (!next) shownError.value = null;
    else if (shownError.value) shownError.value = next;
    else errorTimer = setTimeout(() => (shownError.value = error.value), ERROR_DELAY_MS);
  });
  onScopeDispose(() => clearTimeout(errorTimer));
  const reveal = () => {
    clearTimeout(errorTimer);
    shownError.value = error.value;
  };

  return {
    rows,
    error,
    shownError,
    reveal,
    invalid: computed(() => !!shownError.value),
    stale: computed(() => !compiled.value.ok),
    active,
    filtering: computed(() => !active.value.empty),
    sorted: computed(() => active.value.sorts.length > 0),
    fields: computed(() => describeFields(schema, source.value)),
  };
}

/**
 * The text the field edits, kept apart from the address bar it is stored in.
 * The list follows every keystroke; the address bar is written once the
 * typing pauses, because rewriting history on each key is what browsers
 * throttle, and Back should not step through a query one letter at a time.
 * A change that arrives from the address bar (Back, a pasted link) replaces
 * the text.
 */
export function useQueryText(stored: WritableComputedRef<string>, delay = URL_WRITE_MS): Ref<string> {
  const text = ref(stored.value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** What this field last wrote; the address bar echoing it back is not news. */
  let written = stored.value.trim();
  watch(text, (value) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      written = value.trim();
      stored.value = value;
    }, delay);
  });
  watch(
    () => stored.value,
    (value) => {
      const incoming = value.trim();
      if (incoming === written || incoming === text.value.trim()) return;
      clearTimeout(timer);
      written = incoming;
      text.value = value;
    },
  );
  // A pause cut short by leaving the page is dropped: the router has moved on,
  // and writing now would put this page's query on the next one.
  onScopeDispose(() => clearTimeout(timer));
  return text;
}
