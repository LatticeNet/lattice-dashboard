import assert from "node:assert/strict";
import test from "node:test";

// Imported file by file rather than through the barrel: the barrel uses
// extensionless specifiers that only Vite resolves, and this suite runs on bare
// node so the copy can be checked without a bundler.
import enFrame from "../locales/en/frame.ts";
import enFleet from "../locales/en/fleet.ts";
import enNetworking from "../locales/en/networking.ts";
import enOperations from "../locales/en/operations.ts";
import enPlatform from "../locales/en/platform.ts";
import enSettings from "../locales/en/settings.ts";
import zhFrame from "../locales/zh-CN/frame.ts";
import zhFleet from "../locales/zh-CN/fleet.ts";
import zhNetworking from "../locales/zh-CN/networking.ts";
import zhOperations from "../locales/zh-CN/operations.ts";
import zhPlatform from "../locales/zh-CN/platform.ts";
import zhSettings from "../locales/zh-CN/settings.ts";

const en = [enFrame, enFleet, enNetworking, enOperations, enPlatform, enSettings];
const zhCN = [zhFrame, zhFleet, zhNetworking, zhOperations, zhPlatform, zhSettings];

/**
 * House style, enforced where it is cheapest to enforce: on the copy itself.
 *
 * These rules were agreed and then re-broken four times, because nothing in the
 * build had an opinion about them. Every message the console can render passes
 * through this file, so this is the one place a violation cannot hide.
 */
const BANNED = [
  { name: "em dash", re: /—/ },
  { name: "en dash", re: /–/ },
  // Pictographic and symbol emoji, plus the variation selector that turns a
  // plain glyph into one. Punctuation, arrows and the CJK block are untouched.
  { name: "emoji", re: /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u },
];

type Node = Record<string, unknown>;

function walk(node: unknown, path: string, out: { path: string; value: string }[]): void {
  if (typeof node === "string") {
    out.push({ path, value: node });
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, child] of Object.entries(node as Node)) {
    walk(child, path ? `${path}.${key}` : key, out);
  }
}

for (const [locale, messages] of [
  ["en", en],
  ["zh-CN", zhCN],
] as const) {
  const strings: { path: string; value: string }[] = [];
  walk(messages, "", strings);

  test(`${locale} carries messages at all`, () => {
    assert.ok(strings.length > 500, `only ${strings.length} strings found`);
  });

  for (const { name, re } of BANNED) {
    test(`${locale} copy contains no ${name}`, () => {
      const offenders = strings
        .filter((entry) => re.test(entry.value))
        .map((entry) => `${entry.path}: ${entry.value}`);

      assert.deepEqual(offenders, []);
    });
  }

  test(`${locale} has no message that is only whitespace`, () => {
    const blank = strings.filter((entry) => entry.value.length > 0 && entry.value.trim() === "");

    assert.deepEqual(blank.map((entry) => entry.path), []);
  });
}
