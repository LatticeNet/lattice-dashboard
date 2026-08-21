// Security audit (audit/uisec), UISEC-1.
//
// This test was written to FAIL: it encoded an invariant the host documented but
// did not enforce. The hole has since been closed by PLUGIN_PARAMETERIZED_ROUTES,
// which default-denies query parameters to any route not listed there, so the
// test now passes and its job has changed. It is a regression guard: the day
// someone opens up parameters for a route that acts on arrival, this goes red.
//
// It runs in `npm run test:navigation` with the rest of the shipped suite. It was
// kept out while it was failing; keeping it out now would leave a guard nobody
// runs, which guards nothing.
//
// It grounds itself in the current tree first (asserting that the sink it
// worries about really is there) so it cannot rot into a claim about code that
// has moved. If TerminalView stops acting on its query string, the grounding
// assertions fail on purpose: that is the signal to re-read this file rather
// than to delete it.
//
// A second test in the first version of this file asserted that the host should
// pin event.origin on the bridge path as it does on the navigate path. It was
// rejected in review and removed: the frame is opaque-origin, so event.origin is
// "null" both before and after an in-frame navigation, and an origin check would
// not have bounded anything. The source pin plus rotate-on-load is the defence
// that actually holds. See the review notes for the one ordering detail that is
// still worth knowing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classifyPluginNavigateMessage } from "../pluginNavigationModel.ts";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

// UISEC-1 (medium). pluginNavigationModel.ts:10-13 and PluginFrameHost.vue:220-222
// both state the invariant "the worst a confused or malicious frame can do is
// move the host to another dashboard page". That is false: /terminal acts on its
// own query string at mount and opens a node terminal session with no operator
// interaction, so one postMessage from a sandboxed plugin frame turns into a
// POST /api/terminal/sessions against a node of the plugin's choosing, under the
// operator's identity and scopes.
test("a plugin navigate request cannot reach a route that acts on its query string", () => {
  // Ground the claim: the sink is in this tree, right now, with no confirm step.
  const terminal = source("../../operations/TerminalView.vue");
  assert.match(terminal, /route\.query\.connect === "1"/, "TerminalView no longer reads connect= from the query");
  assert.match(terminal, /await connectSelected\(\{ preferExisting: true \}\)/, "TerminalView no longer auto-connects");
  assert.match(terminal, /api\.terminal\.create\(/, "TerminalView no longer creates a session");

  const verdict = classifyPluginNavigateMessage({
    type: "lattice:navigate",
    route: "/terminal?node_id=n-0123456789ab&connect=1",
  });

  assert.notEqual(
    verdict.kind,
    "navigate",
    "the host accepts a plugin-supplied deep link that opens a terminal session on an arbitrary node",
  );
});
