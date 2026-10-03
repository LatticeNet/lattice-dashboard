import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { registerToastHost, toastHost } from "../toastHost.ts";

/**
 * An error toast raised over the modal object sheet (below 768 px) can only
 * be dismissed because the toaster moves into the sheet: outside it, the
 * modal layer turns pointer events off, traps focus and hides the rest of
 * the page from assistive technology, so nothing reaches the toast's close
 * button. Three pieces carry that, and losing any one brings the bug back
 * without a type error: the host registry, ObjectSheet offering its host
 * while it is modal and open, and the toaster teleporting into it.
 */

const host = (name: string) => ({ name }) as unknown as HTMLElement;

test("the toaster lives in the newest open host and returns to the shell when none is left", () => {
  assert.equal(toastHost.value, null);
  const sheet = host("sheet");
  const nested = host("nested");
  const withdrawSheet = registerToastHost(sheet);
  assert.equal(toastHost.value, sheet);
  const withdrawNested = registerToastHost(nested);
  assert.equal(toastHost.value, nested, "a sheet opened over another takes the toaster");
  withdrawNested();
  assert.equal(toastHost.value, sheet, "closing it hands the toaster back");
  withdrawSheet();
  assert.equal(toastHost.value, null);
  withdrawSheet();
  assert.equal(toastHost.value, null, "withdrawing twice is harmless");
});

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const source = (rel: string) => readFileSync(SRC + rel, "utf8");

test("the toaster teleports into the toast host and stays in place without one", () => {
  const sonner = source("components/ui/sonner/Sonner.vue");
  assert.match(sonner, /import \{ toastHost \} from "@\/lib\/toastHost";/);
  assert.match(sonner, /<Teleport :to="toastHost \?\? 'body'" :disabled="!toastHost">/);
});

test("the object sheet offers its host only while it is modal and open", () => {
  const sheet = source("components/common/ObjectSheet.vue");
  assert.match(sheet, /import \{ registerToastHost \} from "@\/lib\/toastHost";/);
  assert.match(sheet, /if \(!el \|\| !props\.open \|\| beside\.value\) return;\s*onCleanup\(registerToastHost\(el\)\);/);
  assert.match(sheet, /<div v-if="!beside" ref="toastHostEl" data-toast-host \/>/);
});
