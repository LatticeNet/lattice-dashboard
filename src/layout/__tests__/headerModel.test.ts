import assert from "node:assert/strict";
import test from "node:test";

import { ObjectTitleStack, breadcrumbTrail, commandShortcutKey, documentTitle, isApplePlatform, opensCommandPalette, resolvePluginBreadcrumb } from "../headerModel.ts";

test("plugin breadcrumbs use the plugin display name as the section label", () => {
  assert.deepEqual(
    resolvePluginBreadcrumb({
      pluginId: "latticenet.netguard",
      pluginDisplayName: "NetGuard Firewall Controls",
      viewTitle: "Rules",
      viewRoute: "rules",
    }),
    {
      sectionLabel: "NetGuard Firewall Controls",
      title: "Rules",
    },
  );
});

test("plugin breadcrumb fallbacks stay plugin-owned when display name or tab title is missing", () => {
  assert.deepEqual(
    resolvePluginBreadcrumb({
      pluginId: "latticenet.netguard",
      pluginDisplayName: " ",
      viewTitle: "",
      viewRoute: "rules",
    }),
    {
      sectionLabel: "latticenet.netguard",
      title: "rules",
    },
  );
});


const SECTIONS = [
  { id: "overview", items: [{ name: "overview" }] },
  { id: "fleet", items: [{ name: "nodes", scopes: ["node:read"] }, { name: "groups", scopes: ["group:read"] }, { name: "monitoring", scopes: ["monitor:read"] }] },
  { id: "settings", items: [{ name: "settings-security" }, { name: "settings-users", scopes: ["user:admin"] }] },
];

test("a collection page reads Section / Page, and the section links to its first page the operator can open", () => {
  const all = () => true;
  assert.deepEqual(breadcrumbTrail("groups", SECTIONS, all), [
    { kind: "section", id: "fleet", to: { name: "nodes" } },
    { kind: "page", name: "groups" },
  ]);
  const noNodes = (item: { scopes?: readonly string[] }) => !item.scopes?.includes("node:read");
  assert.deepEqual(breadcrumbTrail("groups", SECTIONS, noNodes)[0], { kind: "section", id: "fleet", to: { name: "groups" } });
});

test("an object page adds its collection as a link", () => {
  assert.deepEqual(breadcrumbTrail("node-detail", SECTIONS, () => true), [
    { kind: "section", id: "fleet", to: { name: "nodes" } },
    { kind: "collection", name: "nodes", to: { name: "nodes" } },
    { kind: "page", name: "node-detail" },
  ]);
});

test("home has no section crumb, and a route no section owns is the page alone", () => {
  assert.deepEqual(breadcrumbTrail("overview", SECTIONS, () => true), [{ kind: "page", name: "overview" }]);
  assert.deepEqual(breadcrumbTrail("login", SECTIONS, () => true), [{ kind: "page", name: "login" }]);
  assert.deepEqual(breadcrumbTrail("groups", SECTIONS, () => false)[0], { kind: "section", id: "fleet", to: undefined });
});

test("the palette hint is Command K on Apple keyboards and Ctrl K everywhere else", () => {
  assert.equal(isApplePlatform("macOS"), true);
  assert.equal(isApplePlatform("MacIntel"), true);
  assert.equal(isApplePlatform("iPad"), true);
  assert.equal(isApplePlatform("Linux x86_64"), false);
  assert.equal(isApplePlatform("Win32"), false);
  assert.equal(isApplePlatform("Windows"), false);
  // No platform string at all: the user agent decides.
  assert.equal(isApplePlatform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), true);
  assert.equal(isApplePlatform(undefined, "Mozilla/5.0 (X11; Linux x86_64)"), false);
  assert.equal(commandShortcutKey(true), "shell.command.shortcutMac");
  assert.equal(commandShortcutKey(false), "shell.command.shortcutOther");
});

test("the palette chord opens outside fields, only the keyboard's own chord opens inside one, and never in Terminal", () => {
  const k = (mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }, key = "k") => ({
    key,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
  });
  // Outside a field either chord opens it, on any keyboard.
  for (const apple of [true, false]) {
    assert.equal(opensCommandPalette(k({ meta: true }), { apple, target: "other" }), true);
    assert.equal(opensCommandPalette(k({ ctrl: true }), { apple, target: "other" }), true);
    assert.equal(opensCommandPalette(k({ ctrl: true }, "K"), { apple, target: "other" }), true);
  }
  // In a field off macOS, Ctrl+K opens it (it used to be swallowed and do nothing).
  assert.equal(opensCommandPalette(k({ ctrl: true }), { apple: false, target: "editable" }), true);
  assert.equal(opensCommandPalette(k({ meta: true }), { apple: false, target: "editable" }), false);
  // In a field on macOS, Command+K opens it and Ctrl+K stays the line-kill key.
  assert.equal(opensCommandPalette(k({ meta: true }), { apple: true, target: "editable" }), true);
  assert.equal(opensCommandPalette(k({ ctrl: true }), { apple: true, target: "editable" }), false);
  // Terminal keeps Ctrl+K and Command+K for the shell.
  assert.equal(opensCommandPalette(k({ ctrl: true }), { apple: false, target: "terminal" }), false);
  assert.equal(opensCommandPalette(k({ meta: true }), { apple: true, target: "terminal" }), false);
  // Other chords and bare keys do nothing.
  assert.equal(opensCommandPalette(k({}), { apple: false, target: "other" }), false);
  assert.equal(opensCommandPalette(k({ ctrl: true, shift: true }), { apple: false, target: "other" }), false);
  assert.equal(opensCommandPalette(k({ ctrl: true, alt: true }), { apple: false, target: "other" }), false);
  assert.equal(opensCommandPalette(k({ ctrl: true }, "j"), { apple: false, target: "other" }), false);
});

test("each tab names its object and page before the product, and an object named like its page once", () => {
  assert.equal(documentTitle({ page: "Approvals" }), "Approvals · Lattice");
  assert.equal(documentTitle({ page: "Nodes", object: "dmit-la-1" }), "dmit-la-1 · Nodes · Lattice");
  assert.equal(documentTitle({ page: "Node", object: "  dmit-la-1 " }), "dmit-la-1 · Node · Lattice");
  assert.equal(documentTitle({ page: "Users", object: "Users" }), "Users · Lattice");
  assert.equal(documentTitle({ page: "", object: "" }), "Lattice");
  assert.equal(documentTitle({}), "Lattice");
  // The static title had an em dash; none of these may.
  assert.doesNotMatch(documentTitle({ page: "Terminal", object: "hkg" }), /[\u2013\u2014]/);
});

test("the tab follows the newest open object and falls back when it closes", () => {
  const stack = new ObjectTitleStack();
  const page = Symbol("page");
  const sheet = Symbol("sheet");
  assert.equal(stack.current, "");
  stack.set(page, "dmit-la-1");
  assert.equal(stack.current, "dmit-la-1");
  stack.set(sheet, "agent update to 0.4.1");
  assert.equal(stack.current, "agent update to 0.4.1");
  // A sheet that is closing or still loading names nothing.
  stack.set(sheet, undefined);
  assert.equal(stack.current, "dmit-la-1");
  stack.set(sheet, "approval_2");
  stack.clear(sheet);
  assert.equal(stack.current, "dmit-la-1");
  stack.clear(page);
  assert.equal(stack.current, "");
});
