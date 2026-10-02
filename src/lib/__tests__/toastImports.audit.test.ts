import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Error toasts last 15 s and land in the recent errors list only because
 * every view goes through lib/toast.ts. One file importing toast from
 * vue-sonner directly would bring back the 4 s error that takes the server's
 * reason with it, silently. The toaster itself (ui/sonner) and the
 * wrapper are the only files allowed to import vue-sonner.
 */
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWED = new Set(["lib/toast.ts", "components/ui/sonner/Sonner.vue", "components/ui/sonner/index.ts"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".vue") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("no view imports vue-sonner directly; toasts go through lib/toast", () => {
  const offenders = sourceFiles(SRC)
    .map((file) => file.slice(SRC.length))
    .filter((rel) => !ALLOWED.has(rel))
    .filter((rel) => /from\s+["']vue-sonner["']/.test(readFileSync(join(SRC, rel), "utf8")));
  assert.deepEqual(offenders, []);
});
