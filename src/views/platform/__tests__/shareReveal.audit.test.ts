import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * A share's token reaches a person only after step-up (operator rule,
 * 2026-10-02; lattice-server secret_reveal.go). The share views carry no
 * token, so the console has nothing to read; these checks keep it from
 * growing a way around the gate: building a URL from a view, keeping a
 * revealed URL anywhere that outlives the sheet, or revealing without the
 * step-up grant.
 */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const SHARE_SURFACES = [
  "../PublishingSharesPane.vue",
  "../PublishingView.vue",
  "../publishedModel.ts",
  "../../../components/common/CommandPalette.vue",
  "../../../components/common/commandPaletteModel.ts",
];

test("no share surface builds a link from a share view's token", () => {
  for (const file of SHARE_SURFACES) {
    const text = source(file);
    assert.doesNotMatch(text, /\b(share|row|selected|target|record)\.token\b/, `${file} reads a token off a view`);
    assert.doesNotMatch(text, /\/sub\/\$\{[^}]*\}\/\$\{/, `${file} builds /sub/<slug>/<token> itself`);
  }
});

test("a share is revealed only with the grant its own step-up returned", () => {
  const pane = source("../PublishingSharesPane.vue");
  assert.match(pane, /grant = await revealStepUp\.request\(\)/, "the reveal no longer waits for the step-up");
  assert.match(pane, /api\.subscriptionShares\.reveal\(share\.id, grant\)/, "the reveal no longer carries the step-up grant");
});

test("a revealed URL lives in the pane's memory only", () => {
  const pane = source("../PublishingSharesPane.vue");
  assert.doesNotMatch(pane, /localStorage|sessionStorage|indexedDB/, "the share pane writes to browser storage");
  // Nothing derived from the revealed URL goes into the address.
  assert.doesNotMatch(pane, /router\.(push|replace)\([^)]*(revealed|selectedUrl)/, "the share pane writes a revealed URL into the route");
  assert.match(pane, /revealTimer = setTimeout\(dropReveal, REVEAL_HOLD_MS\)/, "the revealed URL is no longer dropped after its hold");
  assert.match(pane, /onBeforeUnmount\(dropReveal\)/, "the revealed URL outlives the pane");
});
