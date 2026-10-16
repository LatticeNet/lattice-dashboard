/**
 * The console's colour tokens as values a canvas can paint.
 *
 * The tokens are OKLCH custom properties (src/style/app.css) and change with
 * the theme and the operator's palette. A canvas chart cannot read `var()`,
 * so this resolves a token through a probe element's computed colour and
 * paints it once into a 1x1 canvas to read back plain RGBA, which every
 * canvas accepts whatever colour syntax the browser computed. Call it again
 * after a theme change; nothing here caches.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

let probe: HTMLSpanElement | null = null;
let pixel: CanvasRenderingContext2D | null = null;

function probeElement(): HTMLSpanElement {
  if (probe?.isConnected) return probe;
  probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.width = "0";
  probe.style.height = "0";
  probe.style.overflow = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  return probe;
}

function pixelContext(): CanvasRenderingContext2D | null {
  if (pixel) return pixel;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  pixel = canvas.getContext("2d", { willReadFrequently: true });
  return pixel;
}

/** A token (`--success`) or any CSS colour, as RGBA; `fallback` when the browser cannot paint it. */
export function resolveColor(token: string, fallback: Rgba = { r: 128, g: 128, b: 128, a: 1 }): Rgba {
  if (typeof document === "undefined") return fallback;
  const el = probeElement();
  el.style.color = token.startsWith("--") ? `var(${token})` : token;
  const computed = getComputedStyle(el).color;
  const ctx = pixelContext();
  if (!ctx || !computed) return fallback;
  ctx.clearRect(0, 0, 1, 1);
  // An unparseable colour leaves fillStyle as it was; start from a sentinel to tell.
  ctx.fillStyle = "#010203";
  ctx.fillStyle = computed;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (r === 1 && g === 2 && b === 3 && a === 255 && computed.replace(/\s/g, "") !== "rgb(1,2,3)") return fallback;
  return { r: r!, g: g!, b: b!, a: a! / 255 };
}

/** `rgba()` text for a resolved colour, with its alpha multiplied by `alpha`. */
export function rgba(color: Rgba, alpha = 1): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.round(color.a * alpha * 1000) / 1000})`;
}

/** Calls `onChange` when the theme or palette changes (the root's class or inline style). */
export function watchTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(() => onChange());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => observer.disconnect();
}

/** A font family token (`--font-mono`) as the family list a canvas `font` can take. */
export function resolveFontFamily(token: string, fallback = "ui-monospace, monospace"): string {
  if (typeof document === "undefined") return fallback;
  const el = probeElement();
  el.style.fontFamily = token.startsWith("--") ? `var(${token})` : token;
  const family = getComputedStyle(el).fontFamily;
  el.style.fontFamily = "";
  return family || fallback;
}
