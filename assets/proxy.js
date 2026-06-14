// Pure helpers for the proxy-core dashboard panel. These intentionally avoid
// returning write-only secrets unless the operator explicitly typed one.

export function splitProxyList(value) {
  const seen = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const v = part.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

function optionalString(body, key, value) {
  const v = String(value || "").trim();
  if (v) body[key] = v;
}

function optionalInt(body, key, value) {
  const raw = String(value ?? "").trim();
  if (!raw) return;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
  body[key] = Number(raw);
}

function optionalDate(body, key, value) {
  const raw = String(value || "").trim();
  if (!raw) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${key} must be YYYY-MM-DD`);
  body[key] = raw + "T00:00:00Z";
}

export function proxyInboundPayload(fields) {
  const body = {
    core: "sing-box",
    protocol: "vless",
    transport: "tcp",
    security: "reality",
    enabled: Boolean(fields.enabled),
    reality_short_ids: splitProxyList(fields.reality_short_ids).map((v) => v.toLowerCase()),
  };
  optionalString(body, "id", fields.id);
  optionalString(body, "name", fields.name);
  optionalInt(body, "port", fields.port);
  optionalString(body, "listen", fields.listen);
  optionalString(body, "sni", fields.sni);
  const alpn = splitProxyList(fields.alpn);
  if (alpn.length) body.alpn = alpn;
  optionalString(body, "reality_private_key", fields.reality_private_key);
  optionalString(body, "reality_public_key", fields.reality_public_key);
  optionalString(body, "reality_dest", fields.reality_dest);
  return body;
}

export function proxyUserPayload(fields) {
  const body = {
    enabled: Boolean(fields.enabled),
    inbound_ids: splitProxyList(fields.inbound_ids),
  };
  optionalString(body, "id", fields.id);
  optionalString(body, "name", fields.name);
  optionalInt(body, "traffic_limit_bytes", fields.traffic_limit_bytes);
  optionalDate(body, "expires_at", fields.expires_at);
  return body;
}

export function proxyProfilePayload(fields) {
  const body = {
    core: "sing-box",
    inbound_ids: splitProxyList(fields.inbound_ids),
  };
  optionalString(body, "id", fields.id);
  optionalString(body, "node_id", fields.node_id);
  optionalString(body, "hostname", fields.hostname);
  optionalString(body, "listen_ip", fields.listen_ip);
  optionalString(body, "config_path", fields.config_path);
  optionalString(body, "stats_api", fields.stats_api);
  return body;
}

export function proxyRotateConfirmMessage(user) {
  const label = user?.name || user?.id || "this user";
  return `Rotate subscription URL for ${label}? The old URL will stop working immediately.`;
}

export function confirmProxyRotate(user, confirmFn) {
  if (typeof confirmFn !== "function") return false;
  return Boolean(confirmFn(proxyRotateConfirmMessage(user)));
}

export function proxyDeleteConfirmMessage(kind, item) {
  const label = item?.name || item?.id || item?.node_id || "this record";
  return `Delete proxy ${kind} ${label}? This cannot be undone from the dashboard.`;
}

export function confirmProxyDelete(kind, item, confirmFn) {
  if (typeof confirmFn !== "function") return false;
  return Boolean(confirmFn(proxyDeleteConfirmMessage(kind, item)));
}

export function proxyUsagePercent(user) {
  const used = Number(user?.used_bytes || 0);
  const limit = Number(user?.traffic_limit_bytes || 0);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.floor((Math.max(0, used) / limit) * 100);
}

export function proxyUsageLabel(user, formatBytes = String) {
  const rawUsed = Number(user?.used_bytes || 0);
  const used = Number.isFinite(rawUsed) ? Math.max(0, rawUsed) : 0;
  const limit = Number(user?.traffic_limit_bytes || 0);
  if (!Number.isFinite(limit) || limit <= 0) return `${formatBytes(used)} used`;
  const pct = proxyUsagePercent({ used_bytes: used, traffic_limit_bytes: limit });
  return `${formatBytes(used)} / ${formatBytes(limit)} (${pct}%)`;
}
