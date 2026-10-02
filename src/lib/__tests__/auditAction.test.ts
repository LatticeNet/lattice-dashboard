import assert from "node:assert/strict";
import test from "node:test";

import { LABELLED_AUDIT_ACTIONS, auditActionKeyName, auditActionLabelKey } from "../auditAction.ts";
import enOperations from "../../i18n/locales/en/operations.ts";
import zhOperations from "../../i18n/locales/zh-CN/operations.ts";

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, seg) => (node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined), messages);
}

test("every labelled action resolves to a label in en and zh-CN", () => {
  const missing: string[] = [];
  for (const action of [...LABELLED_AUDIT_ACTIONS, "network.nftpolicy.approve", "network.sshguard.reject", "network.agentupdate.dismiss"]) {
    const key = auditActionLabelKey(action);
    assert.ok(key, action);
    for (const [locale, messages] of [["en", enOperations], ["zh-CN", zhOperations]] as const) {
      if (typeof lookup(messages, key) !== "string") missing.push(`${locale} ${action} (${key})`);
    }
  }
  assert.deepEqual(missing, []);
});

test("Home's production-shaped actions read as sentences", () => {
  assert.equal(lookup(enOperations, auditActionLabelKey("task.create")!), "Task queued");
  assert.equal(lookup(enOperations, auditActionLabelKey("inventory.auto_roll")!), "Renewal date rolled forward");
  assert.equal(lookup(zhOperations, auditActionLabelKey("inventory.auto_roll")!), "续费日期已自动顺延");
  // A decision on any plugin's plan, including a plugin id with dots in it.
  assert.equal(auditActionLabelKey("network.latticenet.vpn-core.approve"), "operations.audit.actions.networkPlanApprove");
});

test("an action without a label keeps its raw name", () => {
  assert.equal(auditActionLabelKey("approval.apply"), null);
  assert.equal(auditActionLabelKey("migration.test"), null);
  assert.equal(auditActionLabelKey("network.policy.applied"), "operations.audit.actions.networkPolicyApplied");
});

test("keys are the action in camelCase, never starting with a digit", () => {
  assert.equal(auditActionKeyName("inventory.auto_roll"), "inventoryAutoRoll");
  assert.equal(auditActionKeyName("vpn-core.profile.configure"), "vpnCoreProfileConfigure");
  assert.equal(auditActionKeyName("2fa.enroll"), "twoFactorEnroll");
});
