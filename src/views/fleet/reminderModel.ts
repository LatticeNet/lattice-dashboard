/**
 * When a machine's renewal reminder fires next, and how many machines a
 * notification rule that routes `inventory.renewal` reaches, both read from
 * `/api/machines` alone.
 *
 * The schedule is the server's (server_inventory.go nextReminderFire): an
 * offset fires on the first evaluation at or inside it, so in steady state
 * the next one is the largest offset not yet reached, on the day
 * `next_renewal - offset`. Past the date a machine renewed by hand is
 * reminded once a day for seven days and then left alone; an auto-roll
 * machine's date moves to the next cycle, where the schedule starts over.
 * What the console cannot see is whether today's reminder already went out,
 * so "today" means "today's run".
 */
import type { MachineView, NotifyRuleView } from "@/lib/api/types";
import { advanceRenewal, daysBetween, formatDay, parseDay, rollForwardPast } from "@/views/fleet/inventoryEditorModel";

/** What a profile without offsets of its own is given (design 22, section 3). */
export const DEFAULT_REMIND_DAYS = [14, 7, 3, 1, 0] as const;
/** Days a manual machine past its date keeps being reminded. */
export const OVERDUE_REPEAT_DAYS = 7;

export const RENEWAL_EVENT = "inventory.renewal";

const DAY_MS = 86_400_000;

export type ReminderMachine = Pick<
  MachineView,
  | "id"
  | "node_id"
  | "node_name"
  | "label"
  | "next_renewal"
  | "days_until_renewal"
  | "reminders_enabled"
  | "remind_days_before"
  | "auto_roll"
  | "renewal_cycle"
  | "cycle_days"
>;

export interface NextReminder {
  /** Days before the renewal date; -1 for an overdue repeat. */
  offset: number;
  /** YYYY-MM-DD, UTC. */
  at: string;
  /** Days from today to `at`; 0 is today's run. */
  inDays: number;
  /** The renewal date this reminder is about (the next cycle's, for an auto-roll machine past its offsets). */
  renewal: string;
  /** Set while a manual machine is past its date: the last day it is reminded. */
  repeatsUntil?: string;
}

function shiftDay(day: string, days: number): string {
  const base = parseDay(day)!;
  return formatDay(new Date(base.getTime() + days * DAY_MS));
}

/** A usable renewal date as YYYY-MM-DD; a zero or unparsable time is no date. */
export function renewalDay(machine: Pick<MachineView, "next_renewal">): string | undefined {
  const raw = machine.next_renewal?.slice(0, 10);
  // Go's zero time is year 1; Date.UTC would read that as 1901, so the year
  // is checked on the string.
  if (!raw || Number(raw.slice(0, 4)) <= 1) return undefined;
  return parseDay(raw) ? raw : undefined;
}

export function hasRenewalDate(machine: Pick<MachineView, "next_renewal">): boolean {
  return renewalDay(machine) !== undefined;
}

/** The offsets the server will use, largest first; whole days 0..365 only. */
export function reminderOffsets(machine: Pick<MachineView, "remind_days_before">): number[] {
  const list = (machine.remind_days_before ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 365);
  return [...new Set(list)].sort((a, b) => b - a);
}

function firstInCycle(renewal: string, offsets: readonly number[], today: string): NextReminder | undefined {
  const days = daysBetween(today, renewal);
  if (days === undefined) return undefined;
  const offset = offsets.find((o) => o <= days);
  if (offset === undefined) return undefined;
  return { offset, at: shiftDay(renewal, -offset), inDays: days - offset, renewal };
}

/** The next reminder this machine will send, or undefined when none is scheduled. */
export function nextReminder(machine: ReminderMachine, today: string): NextReminder | undefined {
  const renewal = renewalDay(machine);
  if (!machine.reminders_enabled || !renewal || !parseDay(today)) return undefined;
  const offsets = reminderOffsets(machine);

  const inCycle = firstInCycle(renewal, offsets, today);
  if (inCycle) return inCycle;

  if (machine.auto_roll) {
    const cycle = String(machine.renewal_cycle ?? "");
    const cycleDays = machine.cycle_days ?? 0;
    const rolled = (daysBetween(today, renewal) ?? 0) < 0
      ? rollForwardPast(renewal, cycle, cycleDays, today)
      : advanceRenewal(renewal, cycle, cycleDays);
    return rolled ? firstInCycle(rolled, offsets, today) : undefined;
  }

  // Renewed by hand: every offset has passed, so what is left is the overdue
  // run, daily from the day after the date for OVERDUE_REPEAT_DAYS days.
  const days = daysBetween(today, renewal)!;
  const repeatsUntil = shiftDay(renewal, OVERDUE_REPEAT_DAYS);
  if (days >= 0) return { offset: -1, at: shiftDay(renewal, 1), inDays: days + 1, renewal, repeatsUntil };
  if (days >= -OVERDUE_REPEAT_DAYS) return { offset: -1, at: today, inDays: 0, renewal, repeatsUntil };
  return undefined;
}

// ── notification rules ──────────────────────────────────────────────────────

/** The server's notifyRuleMatches: no events and "*" both match everything. */
export function ruleRoutesRenewals(rule: Pick<NotifyRuleView, "event_types">): boolean {
  const events = rule.event_types ?? [];
  return events.length === 0 || events.includes("*") || events.includes(RENEWAL_EVENT);
}

export interface ReminderCoverage {
  /** Machines with a renewal date and reminders on: every one a matching rule delivers. */
  covered: number;
  /** Machines with a renewal date whose reminders were turned off. */
  off: number;
  /** The soonest reminder among the covered machines. */
  next?: { machine: ReminderMachine; reminder: NextReminder };
  /** Covered machines whose next reminder falls on the same day as `next`: one message on that run. */
  sameDay: number;
}

export function reminderMachineName(machine: ReminderMachine): string {
  return machine.label || machine.node_name || machine.node_id;
}

export function reminderCoverage(machines: readonly ReminderMachine[], today: string): ReminderCoverage {
  let covered = 0;
  let off = 0;
  const upcoming: { machine: ReminderMachine; reminder: NextReminder }[] = [];
  for (const machine of machines) {
    if (!machine.id || !hasRenewalDate(machine)) continue;
    if (!machine.reminders_enabled) {
      off += 1;
      continue;
    }
    covered += 1;
    const reminder = nextReminder(machine, today);
    if (reminder) upcoming.push({ machine, reminder });
  }
  upcoming.sort(
    (a, b) =>
      a.reminder.inDays - b.reminder.inDays ||
      a.reminder.renewal.localeCompare(b.reminder.renewal) ||
      reminderMachineName(a.machine).localeCompare(reminderMachineName(b.machine)),
  );
  const next = upcoming[0];
  const sameDay = next ? upcoming.filter((u) => u.reminder.at === next.reminder.at).length : 0;
  return { covered, off, next, sameDay };
}
