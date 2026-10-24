/**
 * Whether the operator's last input was a key press rather than a pointer.
 *
 * A focus that a script moves (a sheet landing on its title) shows its ring
 * only after a key press. Browsers treat a script's focus on a page nobody
 * has touched yet as keyboard focus, so a sheet opened from a link drew a
 * ring around its title that no one had asked for.
 */
let keyboard = false;
let watching = false;

/** Starts listening, once per page; capture phase, so no handler can hide an input from it. */
export function watchInputModality(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) keyboard = true;
    },
    true,
  );
  window.addEventListener("pointerdown", () => (keyboard = false), true);
}

export function lastInputWasKeyboard(): boolean {
  return keyboard;
}
