import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Imported file by file rather than through the barrel, for the reason
// copy.test.ts gives: the barrel uses extensionless specifiers that only Vite
// resolves, and this suite runs on bare node.
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

const en = Object.assign({}, enFrame, enFleet, enNetworking, enOperations, enPlatform, enSettings);
const zhCN = Object.assign({}, zhFrame, zhFleet, zhNetworking, zhOperations, zhPlatform, zhSettings);

function flatten(node: unknown, prefix: string, out: Set<string>): Set<string> {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (prefix) {
    out.add(prefix);
  }
  return out;
}

/**
 * Two locales drift in opposite directions and each direction breaks a
 * different user. A key added to en only renders English at a Chinese reader;
 * a key added to zh-CN only is dead weight nobody sees. Parity catches both,
 * and it is the check that the per-namespace file split makes necessary: the
 * files exist so the two locales can be edited without merge contention, which
 * is exactly the arrangement that lets one side land alone.
 */
test("en and zh-CN define the same key set", () => {
  const inEn = flatten(en, "", new Set<string>());
  const inZh = flatten(zhCN, "", new Set<string>());
  const missingFromZh = [...inEn].filter((k) => !inZh.has(k)).sort();
  const missingFromEn = [...inZh].filter((k) => !inEn.has(k)).sort();
  assert.deepEqual(
    { missingFromZh, missingFromEn },
    { missingFromZh: [], missingFromEn: [] },
  );
});

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "locales") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".vue") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Only literal keys are collected. A template key such as
 * t(`fleet.status.${row.state}`) cannot be resolved without knowing the value,
 * so it is out of scope here rather than guessed at; those live behind the
 * per-view model tests that enumerate their own states.
 */
function referencedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/\bt\(\s*["']([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)["']/g)) {
      const key = match[1];
      const where = found.get(key) ?? [];
      where.push(file.slice(SRC.length));
      found.set(key, where);
    }
  }
  return found;
}

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, seg) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[seg];
    return undefined;
  }, messages);
}

/**
 * Parity above cannot see a key that is missing from both locales at once: it
 * compares the two message trees to each other, not to the code that reads
 * them. common.status.revoked was referenced by the UI and defined in neither,
 * so a revoked credential rendered its own dotted key path at the user. This
 * reads the call sites instead, which is the only place that gap is visible.
 */
test("every literal t() key resolves to a string in both locales", () => {
  const unresolved: string[] = [];
  for (const [key, where] of referencedKeys()) {
    const missingEn = typeof lookup(en, key) !== "string";
    const missingZh = typeof lookup(zhCN, key) !== "string";
    if (missingEn || missingZh) {
      const locales = [missingEn ? "en" : null, missingZh ? "zh-CN" : null].filter(Boolean).join(" and ");
      unresolved.push(`${key} (missing from ${locales}, used in ${where.join(", ")})`);
    }
  }
  assert.deepEqual(unresolved.sort(), []);
});
