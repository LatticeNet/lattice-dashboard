import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyPluginNavigateMessage } from "../pluginNavigationModel.ts";

/**
 * The plugin frame's one host-side privilege is asking the host to change
 * route. The model's own reasoning for granting it is that "the worst a
 * confused or malicious frame can do here is move the host to another
 * dashboard page".
 *
 * That holds only while no dashboard route performs a privileged action from
 * its query string alone. /terminal does: TerminalView reads node_id and
 * connect=1 out of the route and calls api.terminal.create() from a watcher,
 * with no operator gesture. So a frame can open an interactive shell on a node
 * of its choosing, recorded in the audit trail as the operator's own session.
 *
 * This test states the property the channel needs and does not have: routes
 * that act must not be reachable from plugin-controlled input. It fails today.
 * It is not a fix; the fix is a decision (an allowlist of plugin-reachable
 * routes, or a confirmation step, or making /terminal require a gesture) that
 * belongs to whoever owns the surface.
 */
test("a plugin frame cannot navigate the host into a route that acts on arrival", () => {
  const actionBearing = [
    "/terminal?node_id=node-001&connect=1",
    "/terminal?node_id=node-001&connect=true",
  ];
  for (const route of actionBearing) {
    const verdict = classifyPluginNavigateMessage({ type: "lattice:navigate", route });
    assert.notEqual(
      verdict.kind,
      "navigate",
      `plugin-controlled input reached ${route}, which starts a terminal session on arrival`,
    );
  }
});

/** The benign case the privilege exists for must keep working. */
test("an inert deep link is still accepted", () => {
  const verdict = classifyPluginNavigateMessage({
    type: "lattice:navigate",
    route: "/network/subscription-shares?create=1&for=my-record",
  });
  assert.equal(verdict.kind, "navigate");
});

/**
 * Added with the fix, not with the gate above: the two assertions in the first
 * test are the acceptance criterion and stayed exactly as written. These pin
 * the edges the fix has to hold to be worth anything.
 */
test("a frame may still be sent to any page, it just cannot arm one", () => {
  for (const route of ["/", "/nodes", "/terminal", "/operations/approvals"]) {
    assert.equal(classifyPluginNavigateMessage({ type: "lattice:navigate", route }).kind, "navigate", route);
  }
});

test("an undeclared parameter is refused even on a page that declares others", () => {
  for (const route of [
    "/network/subscription-shares?create=1&for=x&node_id=node-1",
    "/nodes?view=list",
    "/operations/approvals?bucket=pending",
  ]) {
    assert.equal(classifyPluginNavigateMessage({ type: "lattice:navigate", route }).kind, "invalid", route);
  }
});

test("an encoded dot segment cannot borrow an allowed path's permission", () => {
  for (const route of [
    "/network/subscription-shares/%2e%2e/terminal?create=1&for=x",
    "/network/subscription-shares/../terminal?create=1&for=x",
    "/network/subscription-shares/%2e%2e%2fterminal?create=1&for=x",
  ]) {
    assert.equal(classifyPluginNavigateMessage({ type: "lattice:navigate", route }).kind, "invalid", route);
  }
});
