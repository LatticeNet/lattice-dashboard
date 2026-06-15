export function agentUpdatePayload(fields) {
  const installPath = String(fields.install_path || "").trim();
  const serviceName = String(fields.service_name || "").trim();
  const body = {
    node_id: String(fields.node_id || "").trim(),
    enabled: Boolean(fields.enabled),
    auto_plan: Boolean(fields.auto_plan),
    target_version: String(fields.target_version || "").trim(),
    binary_url: String(fields.binary_url || "").trim(),
    sha256: String(fields.sha256 || "").trim().toLowerCase(),
  };
  if (installPath) body.install_path = installPath;
  if (serviceName) body.service_name = serviceName;
  return body;
}

export function agentUpdateStatus(policy, node) {
  if (!policy) return "not configured";
  if (!policy.enabled) return "disabled";
  if (!node || !policy.target_version) return "configured";
  return node.agent_version === policy.target_version ? "current" : "update available";
}
