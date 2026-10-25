/**
 * Editors keep the operator's work (design 32 R6).
 *
 * A refused save names the request field at fault (ApiError.field, a path
 * into the request body such as "targets.exclude[1]"), and the editor
 * focuses and marks the control that edits it. A save that lost a race
 * (ApiError.isVersionConflict) keeps the editor open with the draft, names
 * the fields that changed on the server, and offers to reload theirs or to
 * save the draft over the new version.
 *
 * This module is the pure half: matching a server path to the controls an
 * editor registered, and comparing the version the editor opened with the
 * server's current one. useSaveRefusal and SaveRefusal.vue are the rest.
 * Shared by the check, check definition, outbound policy and DNS deployment
 * editors.
 */
import { ApiError } from "@/lib/api/client";

/** A refused save as an editor shows it. */
export interface SaveRefusal {
  message: string;
  /** The server's path, when it named one. */
  field?: string;
}

/**
 * The registered control path that edits field: the longest registered path
 * equal to field or an ancestor of it, so "targets.exclude[1]" lands on a
 * control registered as "targets.exclude" or "targets". Undefined when no
 * control edits it.
 */
export function resolveField(field: string | undefined, registered: readonly string[]): string | undefined {
  if (!field) return undefined;
  let best: string | undefined;
  for (const path of registered) {
    const covers = field === path || field.startsWith(`${path}.`) || field.startsWith(`${path}[`);
    if (covers && (best === undefined || path.length > best.length)) best = path;
  }
  return best;
}

/** The path's steps: keys and array indexes. */
export function pathSteps(path: string): (string | number)[] {
  const steps: (string | number)[] = [];
  for (const part of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) {
      steps.push(part);
      continue;
    }
    if (match[1]) steps.push(match[1]);
    for (const index of (match[2] ?? "").matchAll(/\[(\d+)\]/g)) steps.push(Number(index[1]));
  }
  return steps;
}

/** The value at path in value, undefined when the path leads nowhere. */
export function valueAt(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const step of pathSteps(path)) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[step];
  }
  return at;
}

/**
 * The same value for comparing: an absent list or object reads as an empty
 * one and an absent string as "", so a field the server omits when empty
 * does not read as changed.
 */
function comparable(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) return value.length ? value.map(comparable) : null;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => [key, comparable(v)] as const)
      .filter(([, v]) => v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return value;
}

/**
 * The paths whose values differ between base (the version the editor
 * opened) and current (the server's version now), in the order given.
 */
export function changedFields(base: unknown, current: unknown, paths: readonly string[]): string[] {
  return paths.filter((path) => JSON.stringify(comparable(valueAt(base, path))) !== JSON.stringify(comparable(valueAt(current, path))));
}

/** The longest value a conflict quotes; longer strings end in an ellipsis. */
const CONFLICT_VALUE_MAX = 60;

/**
 * What a changed field holds on the server now, as the conflict quotes it:
 * a trimmed string, a finite number as text, or a boolean (the footer says
 * on or off). Undefined for empty values, lists and objects, which the
 * conflict names by label only: a list of node ids or a selector is noise
 * in a sentence.
 */
export function conflictValue(value: unknown): string | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > CONFLICT_VALUE_MAX ? `${text.slice(0, CONFLICT_VALUE_MAX - 1)}\u2026` : text;
}

/** The quotable server values of paths in current (conflictValue), by path. */
export function theirValues(current: unknown, paths: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const path of paths) {
    const value = conflictValue(valueAt(current, path));
    if (value !== undefined) out[path] = value;
  }
  return out;
}

/** What a refusal's focus reads of a focusable control inside the marked holder. */
export interface FocusCandidate {
  tag: string;
  type?: string;
  role?: string;
  /** A radio, or role="radio", that is the chosen option. */
  checked?: boolean;
}

/**
 * Which of the marked holder's focusable controls, in document order, a
 * refusal focuses: the chosen option of a choice, else the first control
 * that takes input, else the first other widget. -1 when only buttons and
 * links are left, and the holder takes focus itself: in a selector the
 * first button removes a chip, one keypress from losing it.
 */
export function refusalFocusIndex(candidates: readonly FocusCandidate[]): number {
  const rank = (c: FocusCandidate): number => {
    const choice = c.role === "radio" || (c.tag === "input" && c.type === "radio");
    if (choice && c.checked) return 0;
    if (c.tag === "textarea" || c.tag === "select" || (c.tag === "input" && !choice && c.type !== "checkbox")) return 1;
    if (c.tag === "input" || c.role) return 2;
    if (c.tag !== "button" && c.tag !== "a") return 3;
    return Number.POSITIVE_INFINITY;
  };
  let best = -1;
  let bestRank = Number.POSITIVE_INFINITY;
  candidates.forEach((c, i) => {
    const r = rank(c);
    if (r < bestRank) {
      best = i;
      bestRank = r;
    }
  });
  return best;
}

/** Whether error is a save that lost a race to another save. */
export function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.isVersionConflict;
}

/** A caught save error as a refusal, with fallback when it carries no message. */
export function refusalOf(error: unknown, fallback: string): SaveRefusal {
  if (error instanceof ApiError) return { message: error.serverMessage || error.message || fallback, field: error.field };
  return { message: error instanceof Error && error.message ? error.message : fallback };
}
