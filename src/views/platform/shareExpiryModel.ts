/**
 * Turning what an operator picked into the instant a share stops working.
 *
 * This is only the composing half. Reading an expiry back is already covered:
 * `publishedModel.publishedState()` says whether a share is live, expiring or
 * expired, and `formatRelativeTime` renders how long is left. Adding a second
 * way to answer those questions is how a codebase ends up with two modules that
 * disagree, so this one deliberately stops at the form boundary.
 *
 * The arithmetic lives here rather than in the view because it holds two real
 * decisions, and a decision buried in a template is a decision nobody reviews.
 */
import type {
  SubscriptionShareUpdateRequest,
  SubscriptionShareView,
} from "@/lib/api";

export type ExpiryMode = "never" | "duration" | "date";
export type DurationUnit = "day" | "month" | "quarter" | "year";

/**
 * Days per unit.
 *
 * Decision one: a month is 30 days and a quarter is 91, not calendar
 * arithmetic. An operator picking "3 months" wants a share that lasts about
 * three months, not one whose exact instant depends on which months it happened
 * to span. Calendar months would also make "1 month" mean 28 days in February,
 * which is a worse answer than a slightly rounded one.
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
  /** `YYYY-MM-DD`, straight from a date input. */
  on: string;
}

export function emptyExpiryForm(): ExpiryForm {
  return { mode: "never", amount: 30, unit: "day", on: "" };
}

/**
 * The form that describes a share as it stands, for opening the edit dialog on
 * the current answer rather than on a blank one.
 *
 * An existing expiry always comes back as a date rather than a duration: the
 * server stores an instant, and "90 days" is not recoverable from it. Showing
 * the date is honest; guessing the duration that produced it would not be.
 */
export function expiryFormFor(
  share: Pick<SubscriptionShareView, "expires_at">,
): ExpiryForm {
  const base = emptyExpiryForm();
  if (!share.expires_at) return base;
  const at = new Date(share.expires_at);
  if (Number.isNaN(at.getTime())) return base;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    ...base,
    mode: "date",
    on: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
  };
}

/**
 * The instant a form describes, or null when it describes no expiry at all.
 *
 * Decision two: a date input names a day, and the operator means "through that
 * day". Taking it at midnight as the day begins would cut the last day off, so
 * a share set to expire on the 30th stops working at the end of the 30th.
 */
export function expiryInstant(form: ExpiryForm, now: number): Date | null {
  if (form.mode === "never") return null;
  if (form.mode === "duration") {
    if (!Number.isFinite(form.amount) || form.amount < 1) return null;
    return new Date(now + DURATION_DAYS[form.unit] * form.amount * DAY_MS);
  }
  if (!form.on) return null;
  const end = new Date(`${form.on}T23:59:59`);
  return Number.isNaN(end.getTime()) ? null : end;
}

/** Empty when the form is submittable. The key of the message, not the text. */
export function expiryFormError(form: ExpiryForm, now: number): string {
  if (form.mode === "duration") {
    if (!Number.isFinite(form.amount) || form.amount < 1)
      return "durationTooSmall";
    if (!Number.isInteger(form.amount)) return "durationTooSmall";
  }
  if (form.mode === "date") {
    if (!form.on) return "datePickOne";
    const at = expiryInstant(form, now);
    if (!at) return "dateUnreadable";
    if (at.getTime() <= now) return "datePast";
  }
  return "";
}

/**
 * The create-request field. Undefined means "no expiry", which is what an
 * omitted `expires_at` means on create.
 */
export function expiryCreateValue(
  form: ExpiryForm,
  now: number,
): string | undefined {
  return expiryInstant(form, now)?.toISOString();
}

/**
 * The update body.
 *
 * "Never" has to travel as `clear_expiry` rather than an absent field, because
 * the server distinguishes not-supplied from cleared on purpose: omitting
 * `expires_at` leaves the current expiry alone. Sending nothing here would make
 * "set it to never" quietly do nothing, which is the worst kind of bug —
 * the dialog closes, the toast says saved, and the share still expires.
 */
export function expiryUpdateBody(
  form: ExpiryForm,
  now: number,
): SubscriptionShareUpdateRequest {
  const at = expiryInstant(form, now);
  return at ? { expires_at: at.toISOString() } : { clear_expiry: true };
}
