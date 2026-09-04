import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PLUGIN_TOKEN_NAMES } from "../pluginTokenContract.ts";

const css = readFileSync(fileURLToPath(new URL("../../../style/app.css", import.meta.url)), "utf8");
const frameHost = readFileSync(fileURLToPath(new URL("../PluginFrameHost.vue", import.meta.url)), "utf8");

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
    elevation: ["--shadow-overlay", "--shadow-raised"],
    motion: ["--duration-fast", "--duration-base", "--ease-out"],
  };
  const published = new Set<string>(PLUGIN_TOKEN_NAMES);
  for (const [group, names] of Object.entries(groups)) {
    const absent = names.filter((name) => !published.has(name));
    assert.deepEqual(absent, [], `the ${group} group is incomplete`);
  }
});
