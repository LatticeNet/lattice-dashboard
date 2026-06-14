export function parseNetPolicyPorts(value) {
  const seen = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const token = part.trim();
    if (!token) continue;
    if (!/^\d+$/.test(token)) {
      throw new Error(`invalid port: ${token}`);
    }
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`invalid port: ${token}`);
    }
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export function netPolicyPayload(existing, fields) {
  const target = String(fields.target_node_id || "").trim();
  const remoteKind = String(fields.remote_kind || "any").trim();
  const remote = { kind: remoteKind };
  if (remoteKind === "node") remote.node_id = String(fields.remote_node_id || "").trim();
  if (remoteKind === "cidr") remote.cidr = String(fields.remote_cidr || "").trim();
  if (remoteKind === "domain") remote.domain = String(fields.remote_domain || "").trim();
  const rule = {
    comment: String(fields.comment || "").trim(),
    action: String(fields.action || "deny").trim(),
    direction: String(fields.direction || "egress").trim(),
    protocol: String(fields.protocol || "tcp").trim(),
    ports: parseNetPolicyPorts(fields.ports),
    remote,
  };
  const baseRules = Array.isArray(existing?.rules) ? existing.rules : [];
  return {
    target_node_id: target,
    enabled: fields.enabled !== false,
    rules: [...baseRules, rule],
  };
}

export function describeNetRule(rule) {
  const remote = rule?.remote || {};
  const remoteText = remote.kind === "node"
    ? `node:${remote.node_id || ""}`
    : remote.kind === "cidr"
      ? remote.cidr || "cidr"
      : remote.kind === "domain"
        ? `domain:${remote.domain || ""}`
        : "any";
  const ports = Array.isArray(rule?.ports) && rule.ports.length ? `:${rule.ports.join(",")}` : "";
  return `${rule?.action || ""} ${rule?.direction || ""} ${remoteText} ${rule?.protocol || ""}${ports}`.trim();
}
