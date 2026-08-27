/**
 * Teach `node --test` the `@/` alias that vite and vue-tsc already understand.
 *
 * Source files in this repo import through `@/`, so until now a module could
 * only be unit tested if it happened to have no runtime alias import. That is
 * why the house pattern pushes logic into dependency-free `*Model.ts` files.
 * The pattern is good, but it left a real gap: a composable that must call into
 * `@/lib` was simply untestable, and `usePlanDigest` (which computes the
 * security-critical plan binding) sat in that gap with no coverage at all.
 *
 * This hook resolves `@/x` to `src/x`, trying the extensions vite would try.
 * It is registered only by the test command and has no effect on the build.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = ["", ".ts", ".mts", ".js", "/index.ts", "/index.js"];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const base = path.join(SRC, specifier.slice(2));
    for (const ext of CANDIDATES) {
      const candidate = base + ext;
      if (existsSync(candidate) && !candidate.endsWith("/")) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    throw new Error(`test alias hook: cannot resolve ${specifier} under ${SRC}`);
  },
});
