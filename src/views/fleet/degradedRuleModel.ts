/**
 * The degraded rule's thresholds and the alert policy that pages on it
 * (design 29 D13), shared by the check editor (checksModel) and the path set
 * (latencyModel). A leaf: it imports nothing but types, so both models can
 * read it without a cycle.
 *
 * The server stores the canonical form: each value rounded to one decimal
 * place (the margin to a whole millisecond), a field equal to its default
 * stored as zero, and the whole object as nil when every field is default.
 * The console sends that form too, and an edit sends `degraded` only when it
 * changed, `{}` for a reset, so an editor that echoes the defaults stores
 * nothing.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { MonitorAlertPolicy, MonitorDegradedRule } from "@/lib/api/types";

export const DEGRADED_FIELDS = ["lossPercent", "lossFactor", "latencyFactor", "latencyMarginMs"] as const;
export type DegradedField = (typeof DEGRADED_FIELDS)[number];

export interface DegradedBound {
  /** The field's JSON name on model.MonitorDegradedRule. */
  json: keyof MonitorDegradedRule;
  default: number;
  min: number;
  max: number;
  /** Decimal places the server keeps. */
  places: number;
}

/** model.ValidateDegradedRule's bounds and defaults. */
export const DEGRADED_BOUNDS: Record<DegradedField, DegradedBound> = {
  lossPercent: { json: "loss_percent", default: 2, min: 0.5, max: 50, places: 1 },
  lossFactor: { json: "loss_factor", default: 2, min: 1.2, max: 10, places: 1 },
  latencyFactor: { json: "latency_factor", default: 2, min: 1.2, max: 10, places: 1 },
  latencyMarginMs: { json: "latency_margin_ms", default: 30, min: 5, max: 1000, places: 0 },
};

/** The thresholds as the form holds them: a number, or an empty field, which reads as the default. */
export type DegradedDraft = Record<DegradedField, number | string>;

export function defaultDegradedDraft(): DegradedDraft {
  return { lossPercent: 2, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 30 };
}

/** A stored rule as the form shows it: every field filled, absent and zero as the default. */
export function degradedDraftFrom(rule: MonitorDegradedRule | null | undefined): DegradedDraft {
  const out = defaultDegradedDraft();
  for (const field of DEGRADED_FIELDS) {
    const raw = rule?.[DEGRADED_BOUNDS[field].json];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) out[field] = raw;
  }
  return out;
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** A field's value as a number: an empty field is the default; anything unreadable is NaN. */
export function fieldValue(draft: DegradedDraft, field: DegradedField): number {
  const raw = draft[field];
  if (raw === "" || raw === undefined || raw === null) return DEGRADED_BOUNDS[field].default;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * The fields the server would refuse: NaN, infinities, negatives and anything
 * outside the bounds. Zero is refused here too, where the server would read
 * it as the default: a typed 0 means "none", which no threshold allows.
 */
export function degradedProblems(draft: DegradedDraft): DegradedField[] {
  return DEGRADED_FIELDS.filter((field) => {
    const v = fieldValue(draft, field);
    const b = DEGRADED_BOUNDS[field];
    return !Number.isFinite(v) || round(v, b.places) < b.min || round(v, b.places) > b.max;
  });
}

/** The canonical rule: rounded, defaults left out; `{}` when every field is default. */
export function canonicalRule(draft: DegradedDraft): MonitorDegradedRule {
  const out: MonitorDegradedRule = {};
  for (const field of DEGRADED_FIELDS) {
    const b = DEGRADED_BOUNDS[field];
    const v = round(fieldValue(draft, field), b.places);
    if (Number.isFinite(v) && v !== b.default) out[b.json] = v;
  }
  return out;
}

export function isDefaultRule(draft: DegradedDraft): boolean {
  return Object.keys(canonicalRule(draft)).length === 0;
}

function sameRule(a: MonitorDegradedRule, b: MonitorDegradedRule): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof MonitorDegradedRule>;
  return [...keys].every((k) => a[k] === b[k]);
}

/**
 * What an edit sends for the thresholds (D13): undefined when they mean what
 * is stored, `{}` for a reset to the defaults, otherwise the canonical rule,
 * which replaces the stored one whole.
 */
export function degradedEdit(stored: MonitorDegradedRule | null | undefined, draft: DegradedDraft): MonitorDegradedRule | undefined {
  const next = canonicalRule(draft);
  return sameRule(next, canonicalRule(degradedDraftFrom(stored))) ? undefined : next;
}

/** The rule a whole save stores (a create, the path set): the canonical rule, or nothing when every field is default. */
export function degradedForSave(draft: DegradedDraft): MonitorDegradedRule | undefined {
  const rule = canonicalRule(draft);
  return Object.keys(rule).length ? rule : undefined;
}

/** The rule's numbers for its summary sentence, defaults filled in. */
export function degradedSummary(draft: DegradedDraft): Record<DegradedField, number> {
  const out = {} as Record<DegradedField, number>;
  for (const field of DEGRADED_FIELDS) {
    const v = fieldValue(draft, field);
    out[field] = Number.isFinite(v) ? round(v, DEGRADED_BOUNDS[field].places) : DEGRADED_BOUNDS[field].default;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Alert policy                                                         */
/* ------------------------------------------------------------------ */

export const ALERT_POLICIES: readonly MonitorAlertPolicy[] = ["off", "down", "down_and_degraded"];

/** lattice-sdk MonitorAlertAfterDefault and MonitorAlertAfterMax, which checks and the path set share. */
export const ALERT_DEFAULT_AFTER = 2;
export const ALERT_MAX_AFTER = 20;

/**
 * What a check does when it fails (model.EffectiveMonitorAlert): empty reads
 * as `down` on an operator check, as it always has, and as `off` on the path
 * set and its generated checks, so a path set nobody touched never pages.
 */
export function effectiveAlert(alert: string | undefined, generated: boolean): MonitorAlertPolicy {
  if (alert === "off" || alert === "down" || alert === "down_and_degraded") return alert;
  return generated ? "off" : "down";
}

/** Whether a policy pages on down at all (`down` and `down_and_degraded`); the run count applies to both. */
export function pagesDown(alert: MonitorAlertPolicy): boolean {
  return alert === "down" || alert === "down_and_degraded";
}
