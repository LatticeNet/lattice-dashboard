/**
 * Reading a form field whose type you cannot actually rely on.
 *
 * `v-model` on an input that carries `type="number"` hands back a number, not
 * the string the field was declared as. Vue decides this from the rendered
 * element, so a shared Input wrapper that receives `type` as a fallthrough
 * attribute triggers it too, and the component's own TypeScript signature says
 * nothing about it. The result is a field typed `string` that holds a number
 * from the first keystroke, and a validator that calls `.trim()` on it throws.
 *
 * The failure mode is nasty because the throw happens inside a submit handler:
 * the button appears to do nothing, and whether anyone ever sees why depends on
 * where that handler's error is rendered.
 *
 * So form values are read through here rather than being trusted.
 */

/** A field value as the operator entered it, trimmed, whatever its runtime type. */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** True when the operator actually put something in the field. */
export function hasFieldText(value: unknown): boolean {
  return fieldText(value).length > 0;
}

/**
 * A finite number from a field, or undefined when it is blank or not a number.
 * Returns undefined rather than NaN, because NaN spreads silently into a
 * request body while undefined is caught by the shape.
 */
export function fieldNumber(value: unknown): number | undefined {
  const text = fieldText(value);
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
