/**
 * The arithmetic the Inventory editor shows before anything is saved: what a
 * price per cycle comes to per month, where the next renewal lands after one
 * cycle, and how many days away a date is.
 *
 * Days are YYYY-MM-DD strings read as UTC midnight, the form's own format, so
 * a renewal date does not move with the viewer's time zone. Month arithmetic
 * overflows the way Go's time.AddDate does (31 January plus one month is
 * 3 March), which is how the server rolls a renewal forward.
 */

/** 365.25 / 12, to turn a custom day count into a monthly figure. */
export const DAYS_PER_MONTH = 30.4375;

const DAY_MS = 86_400_000;

const MONTHS_PER_CYCLE: Readonly<Record<string, number>> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/** What a price per cycle costs per month, in cents; 0 when it cannot be said. */
export function monthlyEquivalentCents(priceCents: number, cycle: string, cycleDays: number): number {
  if (!(priceCents > 0)) return 0;
  if (cycle === "custom_days") return cycleDays > 0 ? (priceCents * DAYS_PER_MONTH) / cycleDays : 0;
  const months = MONTHS_PER_CYCLE[cycle];
  return months ? priceCents / months : 0;
}

export function parseDay(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The day one cycle after `day`, or undefined for no cycle or a bad custom count. */
export function advanceRenewal(day: string, cycle: string, cycleDays: number): string | undefined {
  const base = parseDay(day);
  if (!base) return undefined;
  const months = MONTHS_PER_CYCLE[cycle];
  if (months) {
    return formatDay(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, base.getUTCDate())));
  }
  if (cycle === "custom_days" && Number.isInteger(cycleDays) && cycleDays > 0) {
    return formatDay(new Date(base.getTime() + cycleDays * DAY_MS));
  }
  return undefined;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number | undefined {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return undefined;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * Reminder offsets as typed: whole days from 0 to 365, comma separated, most
 * days first. Blank entries are skipped; anything else that is not a whole
 * day in range comes back in `ignored`, so the form can name it instead of
 * dropping it without a word.
 */
export function parseReminderDaysInput(text: string): { days: number[]; ignored: string[] } {
  const days = new Set<number>();
  const ignored: string[] = [];
  for (const raw of text.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    if (/^\d+$/.test(item) && Number(item) <= 365) days.add(Number(item));
    else ignored.push(item);
  }
  return { days: [...days].sort((a, b) => b - a), ignored };
}

/**
 * The first renewal after `today`, rolling `day` forward one cycle at a time,
 * for a recorded next renewal that is today or already past. Undefined when
 * `day` is still ahead or there is no usable cycle.
 */
export function rollForwardPast(day: string, cycle: string, cycleDays: number, today: string): string | undefined {
  const start = parseDay(day);
  const now = parseDay(today);
  if (!start || !now || start.getTime() > now.getTime()) return undefined;
  let next = day;
  for (let guard = 0; guard < 1000; guard += 1) {
    const advanced = advanceRenewal(next, cycle, cycleDays);
    const date = advanced ? parseDay(advanced) : undefined;
    if (!advanced || !date) return undefined;
    next = advanced;
    if (date.getTime() > now.getTime()) return next;
  }
  return undefined;
}
