// Approval helpers stay DOM-free so the security-sensitive plan-hash binding can
// be unit-tested outside the browser.

export async function sha256Hex(value, subtle = globalThis.crypto?.subtle) {
  if (!subtle) {
    throw new Error("Plan hashing is unavailable in this browser.");
  }
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function approvalById(approvals, approvalId) {
  return (approvals || []).find((approval) => approval && approval.id === approvalId) || null;
}

export function approvalQueueApply(approval) {
  return approval?.plugin !== "selfdns";
}

export function approvalActionLabel(approval) {
  return approvalQueueApply(approval) ? "Approve Apply" : "Approve Review";
}

export async function approvalPayload(approval, subtle) {
  if (!approval || !approval.id) {
    throw new Error("Approval not found.");
  }
  return {
    approval_id: approval.id,
    queue_apply: approvalQueueApply(approval),
    plan_sha256: await sha256Hex(approval.plan || "", subtle),
  };
}
