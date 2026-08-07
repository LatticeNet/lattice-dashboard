/**
 * When a share stops working, and how that reads in the list.
 *
 * Extracted from the view so the arithmetic is testable. The rounding rule in
 * particular is a decision rather than a detail: a share with six hours left
 * must not read "0 days", because "0 days" and "expired" look identical at a
 * glance and mean very different things to the person holding the link.
 */

export type ExpiryMode = "never" | "duration" | "datetime";
export type DurationUnit = "day" | "month" | "quarter" | "year";

/**
 * Days per unit.
 *
 * A month is 30 days and a quarter is 91 rather than calendar arithmetic. An
 * operator picking "3 months" wants a share that lasts about three months, not
 * one whose exact instant depends on which months it happened to span — and a
 * calendar month would make "1 month" mean 28 days in February.
 */
export const DURATION_DAYS: Record<DurationUnit, number> = {
  day: 1,
  month: 30,
  quarter: 91,
  year: 365,
};

const DAY_MS = 86_400_000;

export interface ExpiryForm {
  mode: ExpiryMode;
  amount: number;
  unit: DurationUnit;
  /** `YYYY-MM-DD` from a date input. */
  on: string;
}

/** The instant a form describes, or null for a share that never expires. */
export function expiryInstant(form: ExpiryForm, now: number): Date | null {
  if (form.mode === "never") return null;
  if (form.mode === "duration") {
    if (!Number.isFinite(form.amount) || form.amount < 1) return null;
    return new Date(now + DURATION_DAYS[form.unit] * form.amount * DAY_MS);
  }
  if (!form.on) return null;
  // A date input gives a day, and the operator means "through that day" — not
  // "at midnight as it begins", which would cut the last day off.
  const end = new Date(`${form.on}T23:59:59`);
  return Number.isNaN(end.getTime()) ? null : end;
}

export function expiryFormError(form: ExpiryForm, now: number): string {
  if (form.mode === "duration" && (!Number.isFinite(form.amount) || form.amount < 1)) {
    return "The duration must be at least one.";
  }
  if (form.mode === "datetime") {
    if (!form.on) return "Pick the date it should stop working.";
    const at = expiryInstant(form, now);
    if (!at) return "That is not a date.";
    if (at.getTime() <= now) return "That date has already passed.";
  }
  return "";
}

/** Rounded up, so anything still live reads as at least one day. */
export function daysRemaining(expiresAt: string, now: number): number {
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return 0;
  return Math.ceil((at - now) / DAY_MS);
}

export function isExpired(expiresAt: string | undefined, now: number): boolean {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  return !Number.isNaN(at) && at <= now;
}

/** What the list says under a share. */
export function expiryLabel(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return "never expires";
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return "expiry unreadable";
  if (isExpired(expiresAt, now)) return `expired ${when.toLocaleString()}`;
  const left = daysRemaining(expiresAt, now);
  return `${when.toLocaleString()} · ${left} day${left === 1 ? "" : "s"} left`;
}
