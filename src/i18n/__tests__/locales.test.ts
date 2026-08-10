import assert from "node:assert/strict";
import test from "node:test";

import { NAV } from "../../router/nav.ts";
import en from "../locales/en/frame.ts";
import zhCN from "../locales/zh-CN/frame.ts";

/**
 * Every nav entry renders through `t("nav.items." + name)`. A name with no
 * message in a locale ships the raw dotted key to the sidebar — that is how
 * "nav.items.network-subscription-shares" reached production. Pin coverage so
 * the gap fails here instead of rendering.
 */
function navKeys(): string[] {
  const keys: string[] = [];
  for (const section of NAV) {
    for (const item of section.items) keys.push(`nav.items.${item.name}`);
  }
  return keys;
}

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, seg) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[seg];
    return undefined;
  }, messages);
}

for (const [label, messages] of [
  ["en", en],
  ["zh-CN", zhCN],
] as const) {
  test(`nav.items.* keys all exist in ${label}`, () => {
    const missing = navKeys().filter((key) => typeof lookup(messages, key) !== "string");
    assert.deepEqual(missing, []);
  });
}

test("both locales carry the same nav.items key set", () => {
  const keys = navKeys();
  const inEn = new Set(keys.filter((k) => typeof lookup(en, k) === "string"));
  const inZh = new Set(keys.filter((k) => typeof lookup(zhCN, k) === "string"));
  assert.deepEqual([...inEn].sort(), [...inZh].sort());
});
