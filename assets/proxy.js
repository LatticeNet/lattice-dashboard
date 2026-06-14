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
  optionalString(body, "fingerprint", fields.fingerprint);
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

export function proxyCollectorStatusClass(profile) {
  switch (profile?.usage_collector_status) {
    case "ok":
      return "pill";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

export function proxyCollectorLabel(profile, formatDate = String) {
  const status = String(profile?.usage_collector_status || "").trim();
  if (!status) return "collector not reported";
  const source = String(profile?.usage_collector_source || "").trim();
  const checked = profile?.usage_collector_checked_at ? ` · checked ${formatDate(profile.usage_collector_checked_at)}` : "";
  const sourceText = source ? ` (${source})` : "";
  if (status === "ok") return `collector ok${sourceText}${checked}`;
  if (status === "error") {
    const err = String(profile?.usage_collector_last_error || "error").trim();
    return `collector error${sourceText}: ${err}${checked}`;
  }
  return `collector ${status}${sourceText}${checked}`;
}

export const proxySubscriptionFormats = Object.freeze([
  {
    format: "base64",
    label: "Base64",
    target: "Generic subscription clients",
    description: "Default /sub token output; compatible with simple VLESS subscription importers.",
  },
  {
    format: "plain",
    label: "Plain links",
    target: "Manual VLESS link import",
    description: "One vless:// link per eligible node/inbound.",
  },
  {
    format: "sing-box",
    label: "sing-box JSON",
    target: "sing-box clients",
    description: "A client-side sing-box config containing the eligible outbounds.",
  },
  {
    format: "clash-meta",
    label: "Clash/Mihomo YAML",
    target: "Clash.Meta and Mihomo",
    description: "YAML provider output for Clash.Meta-compatible clients.",
  },
]);

function urlWithSubscriptionFormat(rawURL, format) {
  const input = String(rawURL || "").trim();
  if (!input) return "";
  const relative = input.startsWith("/");
  const parsed = new URL(input, relative ? "https://lattice.invalid" : undefined);
  parsed.searchParams.delete("format");
  if (format && format !== "base64") parsed.searchParams.set("format", format);
  return relative ? parsed.pathname + parsed.search + parsed.hash : parsed.toString();
}

export function proxySubscriptionImportTargets(rawURL) {
  const input = String(rawURL || "").trim();
  if (!input) return [];
  try {
    return proxySubscriptionFormats.map((entry) => ({
      ...entry,
      url: urlWithSubscriptionFormat(input, entry.format),
    }));
  } catch {
    return [];
  }
}

export function proxyCoreApprovalQueue(approvals) {
  return (approvals || [])
    .filter((approval) =>
      approval &&
      approval.plugin === "proxycore" &&
      approval.action === "apply-config" &&
      approval.status === "pending" &&
      approval.id &&
      approval.node_id,
    )
    .slice()
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}
