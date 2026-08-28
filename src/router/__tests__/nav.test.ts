import assert from "node:assert/strict";
import test from "node:test";

import { NAV } from "../nav.ts";
import { concreteRoutes } from "../routeComponents.ts";
import { SCOPE_CATALOG } from "@/lib/scopes";

function navNames(): string[] {
  return NAV.flatMap((section) => section.items.map((item) => item.name));
}

/**
 * The route table is built by iterating NAV, so a view registered in
 * routeComponents with no NAV entry is a feature with no way in. Agent Updates
 * shipped that way: route, view, and both locales present, nothing reachable.
 */
test("every view registered for the console has a nav entry that reaches it", () => {
  const reachable = new Set(navNames());
  const orphaned = Object.keys(concreteRoutes).filter((name) => !reachable.has(name));

  assert.deepEqual(orphaned, []);
});

/** The other direction: a nav entry with no view silently renders a placeholder. */
test("every nav destination has a real view behind it", () => {
  const placeholders = navNames().filter((name) => !(name in concreteRoutes));

  assert.deepEqual(placeholders, []);
});

test("nav destination names and paths are unique", () => {
  const names = navNames();
  const paths = NAV.flatMap((section) => section.items.map((item) => item.path));

  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(paths).size, paths.length);
});

/**
 * The collapsed rail renders one control per section, so a section without an
 * icon is a blank 64px button.
 */
test("every nav section carries the icon the collapsed rail renders", () => {
  const missing = NAV.filter((section) => !section.icon).map((section) => section.id);

  assert.deepEqual(missing, []);
});

test("every nav destination carries an icon and a path rooted at /", () => {
  for (const section of NAV) {
    for (const item of section.items) {
      assert.ok(item.icon, `${item.name} has no icon`);
      assert.ok(item.path.startsWith("/"), `${item.name} path is not absolute`);
    }
  }
});

/**
 * A page gated on a scope that the token picker does not offer is a page nobody
 * can be granted access to. SSH Guard shipped that way: the server knew
 * sshguard:admin, the nav required it, and the scope catalog had never heard of
 * it, so the only way in was a token minted outside the console.
 *
 * The server is authoritative on which scopes exist; this pins the far cheaper
 * invariant, that anything the console gates on can also be handed out by it.
 */
test("every scope the nav gates on can be granted from the scope picker", () => {
  const grantable = new Set(SCOPE_CATALOG);
  const ungrantable = NAV.flatMap((section) =>
    section.items.flatMap((item) =>
      (item.scopes ?? []).filter((scope) => !grantable.has(scope)),
    ),
  );

  assert.deepEqual(
    Array.from(new Set(ungrantable)),
    [],
    "these scopes gate a page but cannot be selected when issuing a token",
  );
});
