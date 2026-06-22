/**
 * groupColors — CSP-safe, class-based color tokens for fleet groups.
 *
 * Groups store a *token name* (e.g. "sky", "violet") rather than a raw hex value
 * so the server never has to emit inline styles (CSP forbids them). The mapping
 * from token → Tailwind utility classes lives here as FULL LITERAL strings: that
 * matters because Tailwind only generates classes it can find verbatim in the
 * source, so `bg-${token}-500` would be purged. Every class below is spelled out
 * for exactly that reason.
 */

/** The orderable palette offered in the group editor. */
export const GROUP_COLOR_TOKENS = [
  "slate",
  "sky",
  "violet",
  "emerald",
  "amber",
  "rose",
  "teal",
  "cyan",
  "indigo",
  "fuchsia",
  "lime",
  "orange",
] as const;

export type GroupColorToken = (typeof GROUP_COLOR_TOKENS)[number];

export interface GroupColorClasses {
  /** Solid background for the small identifying dot / swatch. */
  dot: string;
  /** Soft tinted background for chips and matrix cells. */
  soft: string;
  /** Readable foreground tint (light + dark). */
  text: string;
  /** Border tint for outlined chips. */
  border: string;
}

const MAP: Record<GroupColorToken, GroupColorClasses> = {
  slate: { dot: "bg-slate-500", soft: "bg-slate-500/12", text: "text-slate-700 dark:text-slate-300", border: "border-slate-500/40" },
  sky: { dot: "bg-sky-500", soft: "bg-sky-500/12", text: "text-sky-700 dark:text-sky-300", border: "border-sky-500/40" },
  violet: { dot: "bg-violet-500", soft: "bg-violet-500/12", text: "text-violet-700 dark:text-violet-300", border: "border-violet-500/40" },
  emerald: { dot: "bg-emerald-500", soft: "bg-emerald-500/12", text: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-500/40" },
  amber: { dot: "bg-amber-500", soft: "bg-amber-500/12", text: "text-amber-700 dark:text-amber-300", border: "border-amber-500/40" },
  rose: { dot: "bg-rose-500", soft: "bg-rose-500/12", text: "text-rose-700 dark:text-rose-300", border: "border-rose-500/40" },
  teal: { dot: "bg-teal-500", soft: "bg-teal-500/12", text: "text-teal-700 dark:text-teal-300", border: "border-teal-500/40" },
  cyan: { dot: "bg-cyan-500", soft: "bg-cyan-500/12", text: "text-cyan-700 dark:text-cyan-300", border: "border-cyan-500/40" },
  indigo: { dot: "bg-indigo-500", soft: "bg-indigo-500/12", text: "text-indigo-700 dark:text-indigo-300", border: "border-indigo-500/40" },
  fuchsia: { dot: "bg-fuchsia-500", soft: "bg-fuchsia-500/12", text: "text-fuchsia-700 dark:text-fuchsia-300", border: "border-fuchsia-500/40" },
  lime: { dot: "bg-lime-500", soft: "bg-lime-500/12", text: "text-lime-700 dark:text-lime-300", border: "border-lime-500/40" },
  orange: { dot: "bg-orange-500", soft: "bg-orange-500/12", text: "text-orange-700 dark:text-orange-300", border: "border-orange-500/40" },
};

const FALLBACK: GroupColorClasses = MAP.slate;

/** Classes for a token, falling back to slate for unknown/empty values. */
export function groupColor(token?: string | null): GroupColorClasses {
  if (!token) return FALLBACK;
  return MAP[token as GroupColorToken] ?? FALLBACK;
}

/** True when the token is one of the known palette entries. */
export function isGroupColorToken(token?: string | null): token is GroupColorToken {
  return !!token && token in MAP;
}
