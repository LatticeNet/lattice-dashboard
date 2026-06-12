export const DEFAULT_AUDIT_LIMIT = 16;

const FILTER_KEYS = ["action", "decision", "node_id", "actor_id", "token_id", "scope", "correlation_id"];
const SENSITIVE_METADATA_PATTERN = /(password|passwd|secret|token|private[_-]?key|credential|authorization)/i;

export function auditPath(filters = {}) {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = String(filters[key] || "").trim();
    if (value) {
      params.set(key, value);
    }
  }
  params.set("limit", String(boundedNumber(filters.limit, DEFAULT_AUDIT_LIMIT)));
  params.set("offset", String(Math.max(0, Number(filters.offset || 0) || 0)));
  return `/api/audit?${params.toString()}`;
}

export function normalizeAuditResponse(payload, fallback = {}) {
  if (Array.isArray(payload)) {
    return {
      events: payload,
      total: payload.length,
      limit: boundedNumber(fallback.limit, DEFAULT_AUDIT_LIMIT),
      offset: Math.max(0, Number(fallback.offset || 0) || 0),
    };
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return {
    events,
    total: Number.isInteger(payload?.total) ? payload.total : events.length,
    limit: boundedNumber(payload?.limit, boundedNumber(fallback.limit, DEFAULT_AUDIT_LIMIT)),
    offset: Math.max(0, Number(payload?.offset ?? fallback.offset ?? 0) || 0),
  };
}

export function nextAuditOffset(page, direction) {
  const limit = boundedNumber(page?.limit, DEFAULT_AUDIT_LIMIT);
  const total = Math.max(0, Number(page?.total || 0) || 0);
  const current = Math.max(0, Number(page?.offset || 0) || 0);
  const lastPageOffset = total > 0 ? Math.floor((total - 1) / limit) * limit : 0;
  const next = current + Math.sign(direction) * limit;
  return Math.max(0, Math.min(next, lastPageOffset));
}

export function auditDetailRows(event = {}) {
  const rows = [
    ["audit id", event.id],
    ["actor", event.actor_id],
    ["token", event.token_id],
    ["node", event.node_id],
    ["scope", event.scope],
    ["reason", event.reason],
    ["request id", event.correlation_id],
  ].filter(([, value]) => hasValue(value));

  if (event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)) {
    for (const [key, value] of Object.entries(event.metadata).sort(([a], [b]) => a.localeCompare(b))) {
      if (hasValue(value)) {
        rows.push([`metadata.${key}`, displayMetadataValue(key, value)]);
      }
    }
  }
  return rows.map(([label, value]) => [label, String(value)]);
}

export function auditCorrelationFilters(event = {}) {
  const correlationID = String(event.correlation_id || "").trim();
  if (!correlationID) {
    return null;
  }
  return {
    action: "",
    decision: "",
    node_id: "",
    correlation_id: correlationID,
  };
}

function boundedNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return fallback;
  }
  return n;
}

function hasValue(value) {
  return String(value ?? "").trim() !== "";
}

function displayMetadataValue(key, value) {
  if (SENSITIVE_METADATA_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}
