// Security audit (audit/uisec). These tests are EXPECTED TO FAIL on this
// branch: each one encodes an invariant the host currently documents but does
// not enforce. They are deliberately kept out of `npm run test:navigation` so
// the shipped suite stays green; run them directly:
//
//   node --experimental-strip-types --test \
//     src/views/platform/__tests__/pluginHostPrivilege.audit.test.ts
//
// Each test grounds itself in the current tree first (asserting that the sink
// it worries about really is there) so it cannot rot into a claim about code
// that has moved.

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

// UISEC-2 (medium, defense in depth). The bridge's own docstring says hostOrigin
// "pins both inbound and outbound messages", and that is true of the plugin half
// (plugin-bridge/src/bridge.ts:207, :255). The host half pins neither: it posts
// to the frame with targetOrigin "*" (PluginFrameHost.vue:179) and drops
// event.origin before the bridge session ever sees it (PluginFrameHost.vue:236,
// pluginBridgeModel.ts:141-144), so frame identity rests on the WindowProxy plus
// the nonce alone. Both survive an in-frame navigation, and the rotation that is
// meant to catch one only runs on `load`, after the replacing document's inline
// scripts have already run. Today the console's own CSP (default-src 'self', so
// frame-src 'self') is the only thing keeping a non-plugin document out of that
// frame.
test("the host pins the frame origin on the bridge path, not just on navigate", () => {
  const host = source("../PluginFrameHost.vue");
  const model = source("../pluginBridgeModel.ts");
  const lineWith = (text: string, needle: string) =>
    text.split("\n").find((line) => line.includes(needle))?.trim() ?? "";

  // Ground the claim: the navigate path does check the origin, so the gap below
  // is specific to the bridge path rather than a missing import.
  assert.match(host, /isExpectedPluginFrameOrigin\(event\.origin, window\.location\.origin\)/);

  assert.doesNotMatch(
    lineWith(host, "sourceWindow?.postMessage"),
    /"\*"/,
    "the host broadcasts host.init / host.result to whatever document occupies the frame",
  );
  assert.match(
    lineWith(host, "session?.handle("),
    /origin/,
    "the host drops event.origin instead of handing it to the bridge session",
  );
  assert.match(
    lineWith(model, "event.source !== this.options.sourceWindow"),
    /origin/,
    "PluginBridgeSession.handle authenticates the frame by WindowProxy and nonce alone",
  );
});
