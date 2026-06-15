// Pure helpers for the Geo-Routing panel (no DOM access; node:test-friendly).

export function splitIDList(value) {
  const seen = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const v = part.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

export function geoRoutingPayload(fields) {
  const body = {
    name: String(fields.name || "").trim(),
    hostname: String(fields.hostname || "").trim().toLowerCase(),
    strategy: String(fields.strategy || "").trim() || "geoip",
    node_ids: splitIDList(fields.node_ids),
    dns_node_ids: splitIDList(fields.dns_node_ids),
  };
  const id = String(fields.id || "").trim();
  if (id) body.id = id;
  const ttl = Number(fields.ttl || 0);
  if (Number.isInteger(ttl) && ttl > 0) body.ttl = ttl;
  const dbPath = String(fields.geoip_db_path || "").trim();
  if (dbPath) body.geoip_db_path = dbPath;
  return body;
}
