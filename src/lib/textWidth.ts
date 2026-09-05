/**
 * Text width in the page's own font, for layout that has to be known before
 * a layout pass: a pinned table column sized to its longest value cannot wait
 * for the cells to render and then read them back.
 *
 * Measured on a canvas 2D context rather than estimated per character. The
 * console's strict CSP (script-src 'self') does not govern canvas contexts,
 * but a browser or an embedder may still refuse one, so the measurer is
 * optional: callers keep an estimate for when it is undefined.
 */
export type TextMeasure = (text: string) => number;

export function createTextMeasurer(font: string): TextMeasure | undefined {
  if (typeof document === "undefined") return undefined;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return undefined;
    context.font = font;
    return (text) => context.measureText(text).width;
  } catch {
    return undefined;
  }
}

/** The CSS font shorthand for the body face at the given weight and size. */
export function bodyFont(weight: number, sizePx: number): string {
  const family =
    (typeof document !== "undefined" && getComputedStyle(document.body).fontFamily) || "system-ui, sans-serif";
  return `${weight} ${sizePx}px ${family}`;
}
