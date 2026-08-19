/**
 * When a picker must stop being a picker.
 *
 * A Select with nothing in it is worse than a text field: it looks like the
 * answer exists and refuses to give it. The rules for giving up are the same
 * whichever list is behind the field, so they live here rather than being
 * re-derived per picker, and they are checkable without a DOM.
 */
export type PickerDegradeReason =
  /** The caller cannot read the list this field would offer. */
  | "scope"
  /** The list request failed. */
  | "failed"
  /** The list loaded and is empty. */
  | "empty"
  /** The bound value is not in the loaded list, so a Select would silently drop it. */
  | "unknown";

export interface PickerStateInput {
  canRead: boolean;
  failed: boolean;
  /** The list has resolved at least once. */
  loaded: boolean;
  optionCount: number;
  /** True when the current value appears among the options. */
  valueKnown: boolean;
  /** The field currently holds something. */
  hasValue: boolean;
}

/**
 * Returns why the field cannot offer a list, or undefined when it can.
 *
 * Order matters: a missing scope explains a failed request, and a failed
 * request explains an empty list, so reporting the earliest cause is what
 * makes the message actionable.
 */
export function pickerDegradeReason(input: PickerStateInput): PickerDegradeReason | undefined {
  if (!input.canRead) return "scope";
  if (input.failed) return "failed";
  // Still loading: keep the Select and let the skeleton speak, rather than
  // flashing a text input that turns into a dropdown a moment later.
  if (!input.loaded) return undefined;
  if (input.optionCount === 0) return "empty";
  if (input.hasValue && !input.valueKnown) return "unknown";
  return undefined;
}
