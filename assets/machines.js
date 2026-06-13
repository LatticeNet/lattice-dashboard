export function splitIntList(value) {
  const seen = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0) seen.add(n);
  }
  return [...seen].sort((a, b) => b - a);
}

export function machinePayload(fields) {
  const body = {
    node_id: String(fields.node_id || "").trim(),
    label: String(fields.label || "").trim(),
    vendor: String(fields.vendor || "").trim(),
    region: String(fields.region || "").trim(),
    notes: String(fields.notes || "").trim(),
    price_cents: Number(fields.price_cents || 0),
    currency: String(fields.currency || "").trim().toUpperCase(),
    renewal_cycle: String(fields.renewal_cycle || "").trim(),
    cycle_days: Number(fields.cycle_days || 0),
    auto_roll: Boolean(fields.auto_roll),
    remind_days_before: splitIntList(fields.remind_days_before),
    reminders_enabled: Boolean(fields.reminders_enabled),
  };
  const id = String(fields.id || "").trim();
  if (id) body.id = id;
  const nextRenewal = String(fields.next_renewal || "").trim();
  if (nextRenewal) body.next_renewal = `${nextRenewal}T00:00:00Z`;
  const consoleURL = String(fields.console_url || "").trim();
  if (consoleURL) body.console_url = consoleURL;
  const detailURL = String(fields.detail_url || "").trim();
  if (detailURL) body.detail_url = detailURL;
  if (fields.clear_console_url) body.clear_console_url = true;
  if (fields.clear_detail_url) body.clear_detail_url = true;
  return body;
}

export function formatMoney(cents, currency) {
  const value = Number(cents || 0);
  const cur = String(currency || "").trim().toUpperCase();
  if (!value || !cur) return "";
  return `${cur} ${(value / 100).toFixed(2)}`;
}

export function renewalState(daysUntil, hasRenewal) {
  if (!hasRenewal) return "";
  const days = Number(daysUntil || 0);
  if (days < 0) return "overdue";
  if (days <= 7) return "soon";
  return "ok";
}

export function dateInputValue(value) {
  if (!value || String(value).startsWith("0001-")) return "";
  return String(value).slice(0, 10);
}
