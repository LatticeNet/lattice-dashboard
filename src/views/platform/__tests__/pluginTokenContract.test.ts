import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PLUGIN_TOKEN_NAMES } from "../pluginTokenContract.ts";

const css = readFileSync(fileURLToPath(new URL("../../../style/app.css", import.meta.url)), "utf8");
const frameHost = readFileSync(fileURLToPath(new URL("../PluginFrameHost.vue", import.meta.url)), "utf8");
const palettes = readFileSync(fileURLToPath(new URL("../../../theme/palettes.ts", import.meta.url)), "utf8");

/**
 * The declarations of one top-level rule, by selector. Deliberately not a CSS
 * parser: it takes the first brace after the selector and walks to its match,
 * which is all a flat `:root { ... }` block needs, and it never looks inside
 * `@theme inline`, which is the whole point of the check.
 */
function declarationsOf(selector: string): Map<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `app.css has no top-level "${selector}" rule`);
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1], match[2].trim());
  }
  return found;
}

const root = declarationsOf(":root");
const dark = declarationsOf(".dark");

/** The tokens whose value is a colour or an elevation, so a theme must repaint them. */
const THEMED = new Set(
  PLUGIN_TOKEN_NAMES.filter(
    (name) => !name.startsWith("--radius") && !name.startsWith("--space-") && !name.startsWith("--text-")
      && !name.startsWith("--row-h") && !name.startsWith("--duration-")
      && name !== "--ease-out" && name !== "--font-mono",
  ),
);

test("the contract names nothing twice", () => {
  assert.equal(new Set(PLUGIN_TOKEN_NAMES).size, PLUGIN_TOKEN_NAMES.length);
});

test("every published token is declared in a plain :root rule", () => {
  // A token declared only inside `@theme inline` is baked into the generated
  // utilities and may never reach the compiled `:root`. getComputedStyle then
  // reads it as "", the frame receives an empty string, and the plugin falls
  // back to its own value with nothing on screen to say so. That failure hides
  // for as long as the two values happen to agree.
  const missing = PLUGIN_TOKEN_NAMES.filter((name) => !root.has(name));
  assert.deepEqual(missing, [], "declare these in the plain :root block of app.css, not only in @theme inline");
});

test("no published token is empty", () => {
  for (const name of PLUGIN_TOKEN_NAMES) {
    assert.notEqual(root.get(name), "", `${name} is declared with no value`);
  }
});

test("every themed token is repainted by .dark", () => {
  // The light value of a status colour on a dark console is the exact bug the
  // eleven-colour bridge left every plugin to work around by hand.
  const unpainted = [...THEMED].filter((name) => !dark.has(name));
  assert.deepEqual(unpainted, [], "these cross to plugin frames as their light value on a dark console");
});

test("the dark theme adds no token the light theme lacks", () => {
  const orphans = PLUGIN_TOKEN_NAMES.filter((name) => dark.has(name) && !root.has(name));
  assert.deepEqual(orphans, []);
});

test("the radius steps and the mono stack agree with their @theme inline copies", () => {
  const theme = declarationsOf("@theme inline");
  for (const name of ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--font-mono"]) {
    assert.ok(theme.has(name), `${name} left @theme inline; the utilities read it there`);
    assert.equal(
      root.get(name)?.replace(/\s+/g, " "),
      theme.get(name)?.replace(/\s+/g, " "),
      `${name} is declared twice with two different values`,
    );
  }
});

test("the frame host publishes the shared list and keeps no copy of its own", () => {
  assert.ok(
    frameHost.includes('import { PLUGIN_TOKEN_NAMES } from "./pluginTokenContract"'),
    "PluginFrameHost must read the contract, not restate it",
  );
  assert.ok(frameHost.includes("PLUGIN_TOKEN_NAMES.map"), "designTokens must be built from the contract");
  assert.equal(
    /const TOKEN_NAMES\s*=/.test(frameHost),
    false,
    "a second list in the view is how the eleven-colour payload outlived its own decision",
  );
});

test("the contract carries every group the plugins were re-deriving", () => {
  const groups: Record<string, string[]> = {
    status: ["--success", "--success-foreground", "--warning", "--warning-foreground", "--info", "--info-foreground"],
    radius: ["--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius"],
    rows: ["--row-h", "--row-h-compact"],
    spacing: ["--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-6", "--space-7"],
    type: ["--font-mono", "--text-body", "--text-mono"],
    ink: ["--success-text", "--warning-text", "--info-text"],
    elevation: ["--shadow-overlay", "--shadow-raised"],
    motion: ["--duration-fast", "--duration-base", "--ease-out"],
  };
  const published = new Set<string>(PLUGIN_TOKEN_NAMES);
  for (const [group, names] of Object.entries(groups)) {
    const absent = names.filter((name) => !published.has(name));
    assert.deepEqual(absent, [], `the ${group} group is incomplete`);
  }
});

/* ── contrast ──────────────────────────────────────────────────────────────
   The console publishes colours to surfaces it does not own, so a pair that
   fails AA fails in every plugin frame at once and nobody who ships the plugin
   can fix it. These four checks are the arithmetic, not an opinion: OKLCH to
   linear sRGB to relative luminance to the WCAG ratio. They cost nothing and
   they caught the two failures that prompted them (a --warning status label at
   2.5:1 on a white card, and the teal primary button's label at 3.2:1). */

function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

/** Relative luminance of an `oklch(L C H)` literal, gamut-clamped like a display. */
function luminance(color: string): number {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(color.trim());
  assert.ok(m, `not a plain oklch() literal: ${color}`);
  const [r, g, b] = oklchToSrgb(Number(m[1]), Number(m[2]), Number(m[3]));
  const channel = (x: number) => Math.min(1, Math.max(0, x));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

test("the status ink steps read as text on both light grounds", () => {
  for (const ink of ["--success-text", "--warning-text", "--info-text"]) {
    for (const ground of ["--card", "--background"]) {
      const ratio = contrast(root.get(ink)!, root.get(ground)!);
      assert.ok(ratio >= AA, `${ink} on ${ground} is ${ratio.toFixed(2)}:1, under AA for a status label`);
    }
  }
});

/**
 * The other direction: the `-foreground` that sits ON a fill. Dark clears AA
 * everywhere. Light does not for two of them, and both are the console's own
 * filled badge variants (`bg-success text-success-foreground`,
 * `bg-info text-info-foreground` in components/ui/badge/badgeVariants.ts), so
 * closing them means darkening two fills across every console surface that
 * uses them. That is a console colour decision rather than part of the plugin
 * token contract, so the two are named with the numbers they measure and this
 * fails if a third joins them.
 */
const KNOWN_FILL_PAIRS_BELOW_AA = new Set(["light --success", "light --info"]);

test("nothing new drops below AA on a filled surface", () => {
  const failing: string[] = [];
  for (const [scheme, block] of [["light", root], ["dark", dark]] as const) {
    for (const name of ["success", "warning", "info", "primary", "destructive"]) {
      const ratio = contrast(block.get(`--${name}-foreground`)!, block.get(`--${name}`)!);
      if (ratio < AA) failing.push(`${scheme} --${name}`);
    }
  }
  const unexpected = failing.filter((pair) => !KNOWN_FILL_PAIRS_BELOW_AA.has(pair));
  assert.deepEqual(unexpected, [], "a label on this fill now reads under 4.5:1");
});

/**
 * Every palette's light `--primary` with the `--primary-foreground` it ships.
 * app.css is only the pre-mount fallback; the theme store repaints the family
 * from this table on the first frame, so this is the pair the operator sees.
 */
function lightButtonPairs(): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of palettes.matchAll(/^ {2}(\w+): \{[\s\S]*?^ {4}light: make\("([^"]+)",\s*"([^"]+)"/gm)) {
    out.set(m[1], contrast(m[3], m[2]));
  }
  return out;
}

/**
 * The three accents that are Lattice's own identity. The rest of the table
 * mirrors shadcn-vue v3, and four of those mirrors pair their light accent with
 * a near-white label below AA. Recolouring someone else's brand ramp is a
 * decision for whoever picks it, so they are named here rather than silently
 * asserted away: the set may shrink, and this fails if it grows.
 */
const HOUSE_PALETTES = ["teal", "claude", "lattice"];
const KNOWN_BELOW_AA = new Set(["green", "rose", "orange", "red"]);

test("the house palettes keep their button label readable", () => {
  // Fixed in this pass: teal, the default the console actually paints, shipped
  // a 3.2:1 label on the control that saves, applies and confirms.
  const pairs = lightButtonPairs();
  assert.ok(pairs.size >= 10, "the palette table stopped matching; the check would pass vacuously");
  for (const name of HOUSE_PALETTES) {
    const ratio = pairs.get(name);
    assert.ok(ratio !== undefined, `${name} left the palette table`);
    assert.ok(ratio >= AA, `the ${name} button label is ${ratio.toFixed(2)}:1, under AA`);
  }
});

test("no further palette drops below AA on its button label", () => {
  const failing = [...lightButtonPairs()].filter(([, ratio]) => ratio < AA).map(([name]) => name);
  const unexpected = failing.filter((name) => !KNOWN_BELOW_AA.has(name));
  assert.deepEqual(unexpected, [], "these light palettes now pair a label under 4.5:1 on their accent");
});
