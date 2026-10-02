/**
 * One code per currency.
 *
 * Machine profiles were entered with "CHY" for the yuan, which is not an
 * ISO 4217 code, beside others entered as "CNY": the same money split into
 * two totals ("CHY 3,426.83/mo" next to a CNY line). Every place that reads,
 * sums or saves a currency folds the alias, so CHY reads and totals as CNY
 * and an edited profile is written back as CNY. Stored rows the operator
 * never edits keep CHY on the server until they are saved once; a one-time
 * rewrite would be server work.
 *
 * Reading and saving differ in how strict they are. A stored code is shown
 * and summed as stored, apart from case, spaces and the alias: a six-letter
 * token ticker stays six letters. Only the editor, which writes the field,
 * keeps letters and cuts to five.
 */

const ALIASES: Readonly<Record<string, string>> = { CHY: "CNY" };

/** A stored code for display and totals: trimmed, upper-cased, aliases folded; "" when there is none. */
export function canonicalCurrency(value: unknown): string {
  const code = String(value ?? "")
    .trim()
    .toUpperCase();
  return ALIASES[code] ?? code;
}

/** What the editor writes: upper-case letters only, at most five ("USDT"), aliases folded; "" when there is none. */
export function currencyInputCode(value: unknown): string {
  return canonicalCurrency(
    String(value ?? "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 5),
  );
}

/** Whether saving would write a different code than the one stored ("CHY" becomes "CNY"). */
export function currencyRewrittenOnSave(stored: unknown): boolean {
  const raw = String(stored ?? "").trim().toUpperCase();
  return raw !== "" && currencyInputCode(raw) !== raw;
}
