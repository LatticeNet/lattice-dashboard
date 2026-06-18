/**
 * Shared latency-color scale — the single source of truth for how round-trip
 * latency is colored across the console (sparklines, heatmap cells, uplot/SVG
 * charts, badges). Mirrors NodeGet's `pingLatencyConfig` ping bands.
 *
 * Everything is token-based so colors re-theme automatically with light/dark
 * and the active brand palette: classes resolve to the OKLCH `--success`,
 * `--chart-2`, `--warning`, `--destructive` design tokens in src/style/app.css.
 *
 * Bands (ms): <=50 excellent, <=100 good, <=200 fair, <=250 degraded, >250 poor.
 */

export interface LatencySegment {
  /** Inclusive upper bound for this band, in milliseconds. `Infinity` = catch-all. */
  maxMs: number;
  /** Base design token name, e.g. "success" (consumers prefix text-/bg-/stroke-). */
  class: string;
  /** Matching CSS custom property, e.g. "--success", for SVG stroke/fill. */
  varName: string;
}

/**
 * Latency bands ordered ascending by `maxMs`. The first segment whose `maxMs`
 * is >= the measured value wins, so the last entry (`Infinity`) is the
 * catch-all for the slowest probes.
 */
export const LATENCY_SEGMENTS: LatencySegment[] = [
  { maxMs: 50, class: "success", varName: "--success" },
  { maxMs: 100, class: "chart-2", varName: "--chart-2" },
  { maxMs: 200, class: "warning", varName: "--warning" },
  { maxMs: 250, class: "warning", varName: "--warning" },
  { maxMs: Infinity, class: "destructive", varName: "--destructive" },
];

/** Token used when a probe reported packet loss (no successful sample). */
export const LOSS_CLASS = "destructive";
/** Token used when a probe timed out before any reply. */
export const TIMEOUT_CLASS = "muted-foreground";

/** CSS custom property for {@link LOSS_CLASS}, for SVG stroke/fill. */
export const LOSS_VAR = "--destructive";
/** CSS custom property for {@link TIMEOUT_CLASS}, for SVG stroke/fill. */
export const TIMEOUT_VAR = "--muted-foreground";

/** Resolve the band for a latency value; `null`/`undefined`/non-finite → timeout band. */
function segmentFor(ms: number | null | undefined): LatencySegment | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const value = Math.max(0, ms);
  return LATENCY_SEGMENTS.find((segment) => value <= segment.maxMs) ?? LATENCY_SEGMENTS[LATENCY_SEGMENTS.length - 1]!;
}

/**
 * Base token name for a latency value — `null`/`undefined`/non-finite map to
 * {@link TIMEOUT_CLASS}. Prefix it yourself, e.g. `text-${latencyClass(ms)}`.
 */
export function latencyClass(ms: number | null | undefined): string {
  return segmentFor(ms)?.class ?? TIMEOUT_CLASS;
}

/**
 * Tailwind text-color class for a latency value (e.g. `"text-success"`),
 * convenient for badges, numeric labels and inline glyphs.
 */
export function latencyTextClass(ms: number | null | undefined): string {
  return `text-${latencyClass(ms)}`;
}

/**
 * Tailwind background-color class for a latency value (e.g. `"bg-success"`),
 * convenient for heatmap cells and bar fills.
 */
export function latencyBgClass(ms: number | null | undefined): string {
  return `bg-${latencyClass(ms)}`;
}

/**
 * `var(--token)` string for a latency value — use for inline SVG `stroke`/`fill`
 * or uplot series strokes where a raw CSS color is required. Returns the timeout
 * token's var for missing/non-finite values.
 */
export function latencyVar(ms: number | null | undefined): string {
  const varName = segmentFor(ms)?.varName ?? TIMEOUT_VAR;
  return `var(${varName})`;
}
