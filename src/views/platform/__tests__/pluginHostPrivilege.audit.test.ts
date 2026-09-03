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
  assert.match(terminal, /queryFlag\(route\.query\.connect\)/, "TerminalView no longer reads connect= from the query");
  assert.match(terminal, /routeConnectAttempted = true;\s+[^]*?void connect\(\);/, "TerminalView no longer auto-connects");
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

// UISEC-2 (added with the clipboard privilege). The host now performs one more
// action on a frame's word: it writes the operator's clipboard. The privilege
// was granted in preference to `allow="clipboard-write"` on the iframe
// precisely because the host keeps the decision, so what has to stay true is
// that the decision is still the host's. These assertions are the shape of that
// claim, and they are here to go red if a later edit hands the frame the
// permission directly and quietly re-opens the ambient-authority path.
test("the plugin iframe is never granted the clipboard permission directly", () => {
  const host = source("../PluginFrameHost.vue");

  // Ground the claim: the frame really is the opaque-origin sandbox this rests on.
  assert.match(host, /sandbox="allow-scripts"/, "the plugin frame is no longer sandboxed as assumed");
  assert.doesNotMatch(
    host,
    /allow-same-origin/,
    "the plugin frame gained allow-same-origin, which would give it a real origin",
  );

  // The actual invariant: no Permissions Policy delegation on the frame.
  assert.doesNotMatch(
    host,
    /\ballow\s*=\s*"[^"]*clipboard/i,
    "the iframe delegates clipboard permission to the frame, so the host no longer sees or bounds the copies",
  );
});

// The privilege is only worth its cost if the host can actually refuse and the
// plugin can hear the refusal. A host that answered nothing would leave the
// plugin's manual-copy fallback unreachable, which is the failure the operator
// originally reported: a copy that neither works nor tells you what to do.
test("the host answers every clipboard request it can address", async () => {
  const { PluginBridgeSession } = await import("../pluginBridgeModel.ts");
  const posted: Array<Record<string, unknown>> = [];
  const sourceWindow = {};
  const session = new PluginBridgeSession({
    pluginId: "test.plugin",
    pluginVersion: "0.1.0",
    pluginRoute: "items",
    bridgeVersion: "1",
    nonce: "n".repeat(16),
    sourceWindow,
    interfaces: [],
    call: async () => null,
    post: (message) => posted.push(message as unknown as Record<string, unknown>),
    locale: "en",
    colorScheme: "light",
    designTokens: {},
    // No clipboard handler: the host grants nothing.
  });

  await session.handle({
    source: sourceWindow,
    data: { type: "lattice.plugin.clipboard", nonce: "n".repeat(16), id: "c1", text: "secret" },
  });

  const ack = posted.at(-1);
  assert.equal(ack?.type, "lattice.host.clipboard");
  assert.equal(ack?.ok, false, "a host granting no clipboard must say so rather than stay silent");
});
