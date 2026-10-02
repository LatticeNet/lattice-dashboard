import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_KINDS,
  approvalActionPrefix,
  approvalFallbackWords,
  approvalKind,
  approvalPlanSummary,
  approvalRawLabel,
  approvalTitleMessage,
} from "../approvalKind.ts";
import { groupApprovalsIntoEvents } from "../../views/operations/approvalsModel.ts";
import enOperations from "../../i18n/locales/en/operations.ts";
import zhOperations from "../../i18n/locales/zh-CN/operations.ts";

/**
 * Every kind lattice-server files (e596325), with the plugin, action and
 * method exactly as its construction site writes them, digest suffixes
 * included where the server appends one.
 */
const SERVER_KINDS: Array<[plugin: string, action: string, method: string | undefined, kind: string]> = [
  ["agentupdate", "update-agent", undefined, "agentUpdate"],
  ["singbox-linemeta", `apply-metadata:${"a".repeat(64)}`, undefined, "lineMetaSync"],
  ["singbox-lineuser", `apply-line-user:${"b".repeat(64)}`, "apply_add", "lineUserAdd"],
  ["singbox-lineuser", `apply-line-user:${"b".repeat(64)}`, "apply_update", "lineUserUpdate"],
  ["singbox-lineuser", `apply-line-user:${"b".repeat(64)}`, "apply_remove", "lineUserRemove"],
  ["singbox-lineuser", `apply-line-user:${"b".repeat(64)}`, undefined, "lineUserChange"],
  ["singbox-managedline", `apply-managed-line:${"c".repeat(64)}`, "managed_rollout_apply", "managedLineRollout"],
  ["singbox-linechain", `apply-line-chain:${"d".repeat(64)}`, "chain_set_apply", "lineChainSet"],
  ["singbox-linechain", `apply-line-chain:${"d".repeat(64)}`, "chain_remove_apply", "lineChainRemove"],
  ["singbox-linechain", `apply-line-chain:${"d".repeat(64)}`, undefined, "lineChainChange"],
  ["proxycore", "apply-config", undefined, "proxyCoreConfig"],
  ["proxycore", `apply-config:${"e".repeat(64)}`, undefined, "proxyCoreConfig"],
  ["selfdns", "apply-config", undefined, "selfDnsConfig"],
  ["selfdns", "apply-config:ZGVwXzE", undefined, "selfDnsConfig"],
  ["nftpolicy", "apply-ruleset", undefined, "networkPolicy"],
  ["nftpolicy", "apply-ruleset:aHR0cHM6Ly9sYXR0aWNl", undefined, "networkPolicy"],
  ["nft", "apply-ruleset:netguard-v1", undefined, "netguardRuleset"],
  ["nft", "apply-ruleset", undefined, "firewallRuleset"],
  ["cftunnel", "apply-config", undefined, "tunnelConfig"],
  ["wireguard", "apply-config", undefined, "wireguardConfig"],
  ["sshguard", "sshguard-arm:v1", undefined, "sshGuardArm"],
  ["sshguard", "sshguard-confirm:v1", undefined, "sshGuardConfirm"],
];

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, seg) => (node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined), messages);
}

test("every kind the server files gets its own title", () => {
  for (const [plugin, action, method, kind] of SERVER_KINDS) {
    assert.equal(approvalKind({ plugin, action, method }), kind, `${plugin} · ${action} (${method ?? "no method"})`);
  }
  const named = new Set(SERVER_KINDS.map(([, , , kind]) => kind));
  assert.deepEqual([...APPROVAL_KINDS].filter((kind) => !named.has(kind)), [], "a listed kind no server row reaches");
});

test("each title key, and the fallback, resolves to a string in en and zh-CN", () => {
  for (const kind of [...APPROVAL_KINDS, "generic"]) {
    const key = `operations.approvals.kinds.${kind}`;
    assert.equal(typeof lookup(enOperations, key), "string", `en ${key}`);
    assert.equal(typeof lookup(zhOperations, key), "string", `zh-CN ${key}`);
  }
});

test("a kind nobody listed reads in its own words and keeps the plugin", () => {
  // A runtime plugin's operation: "<plugin id>/<service>/<method>".
  const runtime = { plugin: "example.lattice-plugin", action: "example.lattice-plugin/reference/plan" };
  assert.equal(approvalKind(runtime), null);
  assert.deepEqual(approvalFallbackWords(runtime), { action: "Reference plan", plugin: "lattice-plugin" });
  assert.deepEqual(approvalTitleMessage(runtime), {
    key: "operations.approvals.kinds.generic",
    params: { action: "Reference plan", plugin: "lattice-plugin" },
  });
  // A known plugin with an action the table does not list falls back too, never borrowing a wrong title.
  assert.equal(approvalKind({ plugin: "sshguard", action: "arm" }), null);
  assert.deepEqual(approvalFallbackWords({ plugin: "selfdns", action: "apply-zone:abc" }), { action: "Apply zone", plugin: "selfdns" });
  assert.deepEqual(approvalFallbackWords({ plugin: "", action: "" }), { action: "?", plugin: "?" });
});

test("the raw label is the server's identifier without its digest", () => {
  assert.equal(approvalRawLabel({ plugin: "sshguard", action: "sshguard-arm:v1" }), "sshguard · sshguard-arm");
  assert.equal(approvalRawLabel({ plugin: "singbox-lineuser", action: `apply-line-user:${"b".repeat(64)}` }), "singbox-lineuser · apply-line-user");
  assert.equal(approvalActionPrefix("update-agent"), "update-agent");
});

test("a JSON plan's summary is its sentence; text plans have none", () => {
  assert.equal(approvalPlanSummary('{"op":"add","summary":"sb user add alice on node hkg"}'), "sb user add alice on node hkg");
  assert.equal(approvalPlanSummary('{"summary":"   "}'), undefined);
  assert.equal(approvalPlanSummary("# Lattice SSH Guard arm plan\nssh_port: 2202"), undefined);
  assert.equal(approvalPlanSummary("{not json"), undefined);
  assert.equal(approvalPlanSummary(undefined), undefined);
});

test("kinds that share a plugin and prefix get separate cards", () => {
  const base = { node_id: "node_a", status: "pending", actor_id: "cdcd", created_at: "2026-10-02T09:00:00Z" };
  const groups = groupApprovalsIntoEvents([
    { ...base, id: "a1", plugin: "nft", action: "apply-ruleset:netguard-v1" },
    { ...base, id: "a2", plugin: "nft", action: "apply-ruleset" },
    { ...base, id: "a3", plugin: "singbox-lineuser", action: "apply-line-user:aa", method: "apply_add" },
    { ...base, id: "a4", plugin: "singbox-lineuser", action: "apply-line-user:bb", method: "apply_remove" },
    { ...base, id: "a5", plugin: "singbox-lineuser", action: "apply-line-user:cc", method: "apply_add" },
  ]);
  const shape = groups.map((group) => `${approvalKind(group.items[0]!)}:${group.items.length}`).sort();
  assert.deepEqual(shape, ["firewallRuleset:1", "lineUserAdd:2", "lineUserRemove:1", "netguardRuleset:1"]);
});
