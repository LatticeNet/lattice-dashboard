import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A guard for a bug that is invisible until someone edits the field.
 *
 * `v-model` on an input carrying `type="number"` yields a NUMBER, whatever the
 * form's TypeScript type claims, and that includes the shared Input wrapper
 * because Vue reads the rendered element's type rather than the component's
 * signature. A validator that then calls a string method on the value throws
 * inside a submit handler, so the button appears to do nothing.
 *
 * This shipped twice in DnsView (record TTL and hostname record TTL), where
 * both fields were declared `string`, initialised `"300"` and `"60"`, and
 * trimmed on submit. Nothing in the type system caught it because the lie was
 * introduced by the DOM.
 *
 * Read values through `lib/formValue.ts` instead. It coerces before trimming.
 */
const SRC = new URL("../../", import.meta.url).pathname;
const STRING_METHODS = "trim|toLowerCase|toUpperCase|startsWith|endsWith|padStart|padEnd|charAt";

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) vueFiles(full, out);
    else if (entry.endsWith(".vue")) out.push(full);
  }
  return out;
}

/** v-model targets on elements that carry type="number", per file. */
function numericBindings(source: string): string[] {
  const found: string[] = [];
  for (const tag of source.match(/<(?:Input|input)\b[^>]*>/gs) ?? []) {
    if (!tag.includes('type="number"')) continue;
    const model = /v-model(?:\.[a-z]+)?="([^"]+)"/.exec(tag);
    if (model?.[1]) found.push(model[1].split(".").pop()!);
  }
  return [...new Set(found)];
}

test("no string method is called on a value bound to a numeric input", () => {
  const offenders: string[] = [];

  for (const file of vueFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const leaf of numericBindings(source)) {
      const pattern = new RegExp(`\\b${leaf}\\b(?:\\.value)?\\.(?:${STRING_METHODS})\\s*\\(`, "g");
      for (const hit of source.match(pattern) ?? []) {
        offenders.push(`${file.slice(SRC.length)}: ${hit}`);
      }
    }
  }

  assert.deepEqual(offenders, []);
});

test("the guard can actually see the bug it exists for", () => {
  const broken = `
    <template><Input v-model="form.ttl" type="number" /></template>
    <script>const body = form.ttl.trim() ? 1 : 2;</script>
  `;
  assert.deepEqual(numericBindings(broken), ["ttl"]);
  assert.match(broken, new RegExp(`\\bttl\\b\\.(?:${STRING_METHODS})\\s*\\(`));
});
