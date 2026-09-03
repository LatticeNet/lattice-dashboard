/** Presentation helpers: bytes, rates, durations, relative time, money. */

/**
 * What a formatter prints when there is no value to print.
 *
 * A hyphen rather than an em dash, and a constant rather than nine copies of a
 * literal, so the console has one answer to "nothing here" and changing it is
 * one edit instead of a grep. Deliberately locale-free: this module formats
 * numbers and has no access to the message catalogue.
 */
export const NO_VALUE = "-";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function formatBytes(bytes?: number, digits = 1): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return NO_VALUE;
  if (bytes < 1) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

export function formatBytesPerSec(bytes?: number): string {
  if (bytes === undefined) return NO_VALUE;
  return `${formatBytes(bytes)}/s`;
}

export function formatPercent(value?: number, digits = 0): string {
  if (value === undefined || value === null || Number.isNaN(value)) return NO_VALUE;
  return `${value.toFixed(digits)}%`;
}

export function ratio(used?: number, total?: number): number {
  if (!used || !total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds < 0) return NO_VALUE;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * The locale these formatters speak.
 *
 * `Intl.RelativeTimeFormat(undefined)` follows the browser, not the console's
 * language switcher, so a Chinese console on an English browser rendered
 * "自 6 days ago" and "已租出 41 min": half a sentence in each script. The i18n
 * module pushes the active locale in here whenever it changes, and these
 * formatters read it instead of asking the browser.
 *
 * `undefined` until something sets it, which keeps the module usable from
 * `node --test` with no app around it.
 */
let activeLocale: string | undefined;
let rtf = new Intl.RelativeTimeFormat(activeLocale, { numeric: "auto" });

export function setFormatLocale(locale: string | undefined): void {
  activeLocale = locale;
  rtf = new Intl.RelativeTimeFormat(activeLocale, { numeric: "auto" });
}

export function formatRelativeTime(input?: string | number | Date): string {
  // No timestamp is the same absence a missing byte count is, and gets the same
  // mark. It used to answer the English word "never" whatever the locale.
  if (!input) return NO_VALUE;
  const then = new Date(input).getTime();
  if (Number.isNaN(then)) return NO_VALUE;
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
  if (!input) return NO_VALUE;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return NO_VALUE;
  return d.toLocaleString(activeLocale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMoney(cents?: number, currency = "USD"): string {
  if (cents === undefined) return NO_VALUE;
  try {
    return new Intl.NumberFormat(activeLocale, { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Short, copy-friendly id (first 8 chars). */
export function shortId(id?: string, len = 8): string {
  if (!id) return NO_VALUE;
  return id.length > len ? id.slice(0, len) : id;
}
