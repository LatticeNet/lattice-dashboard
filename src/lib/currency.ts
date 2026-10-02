/**
 * One code per currency.
 *
 * Machine profiles were entered with "CHY" for the yuan, which is not an
 * ISO 4217 code, beside others entered as "CNY": the same money split into
 * two totals ("CHY 3,426.83/mo" next to a CNY line). Every place that reads,
 * sums or saves a currency goes through canonicalCurrency, so CHY reads and
 * totals as CNY and an edited profile is written back as CNY. Stored rows the
 * operator never edits keep CHY on the server until they are saved once; a
 * one-time rewrite would be server work.
 */

const ALIASES: Readonly<Record<string, string>> = { CHY: "CNY" };

/** Upper-case letters only, at most five ("USDT"), with aliases folded; "" when there is none. */
export function canonicalCurrency(value: unknown): string {
  const code = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 5);
  return ALIASES[code] ?? code;
}
