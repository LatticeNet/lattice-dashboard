// Pure helpers for the Logs panel. No DOM access here so they stay unit-testable
// under node:test.

export function logSourcePayload(fields) {
  const body = {
    name: String(fields.name || "").trim(),
    node_id: String(fields.node_id || "").trim(),
    path: String(fields.path || "").trim(),
  };
  const id = String(fields.id || "").trim();
  if (id) body.id = id;
  const maxLine = Number(fields.max_line_bytes || 0);
  if (Number.isInteger(maxLine) && maxLine > 0) body.max_line_bytes = maxLine;
  const maxBatch = Number(fields.max_batch_lines || 0);
  if (Number.isInteger(maxBatch) && maxBatch > 0) body.max_batch_lines = maxBatch;
  if (typeof fields.enabled === "boolean") body.enabled = fields.enabled;
  return body;
}

// toRFC3339 converts a datetime-local value ("YYYY-MM-DDTHH:MM") or any
// Date-parseable string to a fractionless RFC3339 UTC timestamp; empty/invalid
// input yields "".
export function toRFC3339(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function logQueryString(params) {
  const q = new URLSearchParams();
  if (params.source_id) q.set("source_id", String(params.source_id));
  const contains = String(params.q || "").trim();
  if (contains) q.set("q", contains);
  const since = toRFC3339(params.since);
  if (since) q.set("since", since);
  const until = toRFC3339(params.until);
  if (until) q.set("until", until);
  const limit = Number(params.limit || 0);
  if (Number.isInteger(limit) && limit > 0) q.set("limit", String(Math.min(limit, 1000)));
  if (params.before_seq) q.set("before_seq", String(params.before_seq));
  return q.toString();
}
