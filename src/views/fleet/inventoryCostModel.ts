/**
 * What Inventory counts as spend: which billing category a machine is in, what
 * a recurring machine costs per month, and the per-currency totals the page
 * head and each group line print.
 *
 * Totals key on the canonical currency (lib/currency.ts), so a profile stored
 * as "CHY" and one stored as "CNY" add up to one CNY line instead of two
 * totals for the same money. Prices are summed as stored; nothing here
 * converts between currencies.
 *
 * Framework-free so the totals are unit-tested rather than only checked in
 * the harness.
 */
import type { MachineView } from "@/lib/api/types";
import { canonicalCurrency } from "@/lib/currency";
import { DAYS_PER_MONTH } from "@/views/fleet/inventoryEditorModel";

export type BillingCategory = "renewalIncomplete" | "recurring" | "onetime" | "free" | "unpriced" | "unprofiled";

export type CurrencySpend = { currency: string; monthly: number; annual: number; count: number };

/** Monthly divisor per named cycle; custom_days is handled separately. */
const CYCLE_DIVISOR: Readonly<Record<string, number>> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

/** The day part of a timestamp, YYYY-MM-DD in UTC; "" when there is none. */
export function isoDay(input?: string): string {
  if (!input) return "";
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function machinePrice(machine: MachineView): number {
  return machine.price_cents ?? 0;
}

/** The next renewal day, or "" when none is set (Go's zero time reads as unset). */
export function renewalDate(machine?: MachineView): string {
  const date = isoDay(machine?.next_renewal);
  if (!date || date.startsWith("0001-")) return "";
  return date;
}

export function hasRenewalIntent(machine: MachineView): boolean {
  return !!(
    machine.renewal_cycle ||
    renewalDate(machine) ||
    machine.auto_roll ||
    machine.reminders_enabled ||
    machine.remind_days_before?.length
  );
}

export function renewalSetupIncomplete(machine: MachineView): boolean {
  if (!hasRenewalIntent(machine)) return false;
  return !machine.renewal_cycle || !renewalDate(machine);
}

export function billingCategory(machine: MachineView): BillingCategory {
  if (!machine.id) return "unprofiled";
  if (renewalSetupIncomplete(machine)) return "renewalIncomplete";
  const price = machinePrice(machine);
  if (price > 0) return machine.renewal_cycle ? "recurring" : "onetime";
  // Price 0/unset: a machine that is being billed (has a renewal cycle or a
  // tracked renewal date) but has no price entered is "needs pricing"; a machine
  // with no billing signal at all is genuinely free.
  return hasRenewalIntent(machine) ? "unpriced" : "free";
}

/** Monthly-equivalent cost in cents for a recurring machine; 0 otherwise. */
export function monthlyEquivCents(machine: MachineView): number {
  if (billingCategory(machine) !== "recurring") return 0;
  const price = machinePrice(machine);
  const cycle = machine.renewal_cycle;
  if (cycle === "custom_days") {
    const days = machine.cycle_days ?? 0;
    if (days <= 0) return price; // treat unknown span as monthly
    return (price * DAYS_PER_MONTH) / days;
  }
  const divisor = CYCLE_DIVISOR[cycle as string] ?? 1;
  return price / divisor;
}

/** Recurring spend per canonical currency, largest monthly total first. */
export function aggregateSpend(list: readonly MachineView[]): CurrencySpend[] {
  const acc = new Map<string, CurrencySpend>();
  for (const machine of list) {
    if (billingCategory(machine) !== "recurring") continue;
    const cur = canonicalCurrency(machine.currency) || "USD";
    const monthly = monthlyEquivCents(machine);
    const entry = acc.get(cur) ?? { currency: cur, monthly: 0, annual: 0, count: 0 };
    entry.monthly += monthly;
    entry.annual += monthly * 12;
    entry.count += 1;
    acc.set(cur, entry);
  }
  return [...acc.values()].sort((a, b) => b.monthly - a.monthly);
}
