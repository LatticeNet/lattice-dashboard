/** Presentation helpers — bytes, rates, durations, relative time, money. */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(bytes?: number, digits = 1): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return "—";
  if (bytes < 1) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

export function formatBytesPerSec(bytes?: number): string {
  if (bytes === undefined) return "—";
  return `${formatBytes(bytes)}/s`;
}

export function formatPercent(value?: number, digits = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function ratio(used?: number, total?: number): number {
  if (!used || !total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(input?: string | number | Date): string {
  if (!input) return "never";
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const min = 60_000,
    hour = 3_600_000,
    day = 86_400_000;
  if (abs < min) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < hour) return rtf.format(Math.round(diff / min), "minute");
  if (abs < day) return rtf.format(Math.round(diff / hour), "hour");
  return rtf.format(Math.round(diff / day), "day");
}

export function formatDateTime(input?: string | number | Date): string {
  if (!input) return "—";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMoney(cents?: number, currency = "USD"): string {
  if (cents === undefined) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Short, copy-friendly id (first 8 chars). */
export function shortId(id?: string, len = 8): string {
  if (!id) return "—";
  return id.length > len ? id.slice(0, len) : id;
}
