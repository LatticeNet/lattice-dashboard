export function parsePorts(value) {
  const seen = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export function nftInputsPayload(fields) {
  return {
    node_id: String(fields.node_id || "").trim(),
    interface_name: String(fields.interface_name || "").trim(),
    wireguard_cidr: String(fields.wireguard_cidr || "").trim(),
    public_tcp: parsePorts(fields.public_tcp),
    public_udp: parsePorts(fields.public_udp),
    wireguard_tcp: parsePorts(fields.wireguard_tcp),
    wireguard_udp: parsePorts(fields.wireguard_udp),
  };
}

export function formatPorts(values) {
  return Array.isArray(values) && values.length ? values.join(",") : "";
}
