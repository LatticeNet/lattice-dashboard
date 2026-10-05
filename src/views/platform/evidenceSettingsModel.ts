/**
 * Pure model for the local evidence budgets (design 26, R1): the five values
 * the control plane keeps under /api/evidence/settings, the unit each one is
 * read and edited in, the bounds the server enforces (checked here first, so
 * the form refuses before the server does), and what lowering a value will
 * remove. Kept free of Vue so `node --test` covers it directly.
 */
import type {
  EvidenceSettings,
  EvidenceSettingsField,
  EvidenceSettingsResponse,
} from "@/lib/api/types";

export const MIB = 1024 ** 2;
export const GIB = 1024 ** 3;
export const HOUR = 3600;
export const DAY = 86_400;

/** The order the retention line and the form state them in. */
export const EVIDENCE_SETTINGS_FIELDS = [
  "trace_db_max_bytes",
  "record_ttl_seconds",
  "line_ttl_seconds",
  "rollup_5m_ttl_seconds",
  "raw_source_max_bytes",
] as const satisfies readonly EvidenceSettingsField[];

/**
 * The server's bounds (design 26 R1, V8), inclusive. The GET answer carries
 * its own `bounds`; these stand in for any field it leaves out.
 */
export const EVIDENCE_SETTINGS_BOUNDS: Record<EvidenceSettingsField, [number, number]> = {
  trace_db_max_bytes: [256 * MIB, 16 * GIB],
  record_ttl_seconds: [DAY, 90 * DAY],
  line_ttl_seconds: [HOUR, 30 * DAY],
  rollup_5m_ttl_seconds: [DAY, 400 * DAY],
  raw_source_max_bytes: [MIB, GIB],
};

export type SettingsUnit = "GiB" | "MiB" | "d" | "h";

const UNIT_SIZE: Record<SettingsUnit, number> = { GiB: GIB, MiB: MIB, d: DAY, h: HOUR };

/**
 * The unit each field is edited in, chosen so every bound is a plain number
 * in it: 0.25 to 16 GiB, 1 to 90 days, 1 to 720 hours, 1 to 400 days, 1 to
 * 1024 MiB.
 */
export const SETTINGS_FORM_UNIT: Record<EvidenceSettingsField, SettingsUnit> = {
  trace_db_max_bytes: "GiB",
  record_ttl_seconds: "d",
  line_ttl_seconds: "h",
  rollup_5m_ttl_seconds: "d",
  raw_source_max_bytes: "MiB",
};

export function isSizeField(field: EvidenceSettingsField): boolean {
  return field === "trace_db_max_bytes" || field === "raw_source_max_bytes";
}

/** Up to two decimals, trailing zeros dropped: 0.25, 1.5, 2. */
function trimmed(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** A stored value in the field's form unit, as the form shows it. */
export function toFormValue(field: EvidenceSettingsField, raw: number): string {
  return trimmed(raw / UNIT_SIZE[SETTINGS_FORM_UNIT[field]]);
}

/** A form entry back to bytes or seconds; undefined when it is not a positive number. */
export function fromFormValue(field: EvidenceSettingsField, text: string): number | undefined {
  const value = Number(String(text).trim());
  if (!String(text).trim() || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value * UNIT_SIZE[SETTINGS_FORM_UNIT[field]]);
}

/**
 * A value for reading: sizes in GiB from one GiB up and in MiB below; durations
 * in days when they are whole days and in hours otherwise.
 */
export function displayAmount(field: EvidenceSettingsField, raw: number): { value: string; unit: SettingsUnit } {
  if (isSizeField(field)) {
    return raw >= GIB ? { value: trimmed(raw / GIB), unit: "GiB" } : { value: trimmed(raw / MIB), unit: "MiB" };
  }
  if (raw >= DAY && raw % DAY === 0) return { value: String(raw / DAY), unit: "d" };
  return { value: trimmed(raw / HOUR), unit: "h" };
}

/** The server's bounds where it sent them, this console's copy for the rest. */
export function effectiveBounds(
  bounds: EvidenceSettingsResponse["bounds"],
): Record<EvidenceSettingsField, [number, number]> {
  const out = { ...EVIDENCE_SETTINGS_BOUNDS };
  for (const field of EVIDENCE_SETTINGS_FIELDS) {
    const pair = bounds?.[field];
    if (Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === "number" && Number.isFinite(n))) {
      out[field] = [pair[0], pair[1]];
    }
  }
  return out;
}

export type SettingsDraft = Record<EvidenceSettingsField, string>;

export function settingsDraft(settings: EvidenceSettings): SettingsDraft {
  const draft = {} as SettingsDraft;
  for (const field of EVIDENCE_SETTINGS_FIELDS) draft[field] = toFormValue(field, settings[field]);
  return draft;
}

export type SettingsProblem = "invalid" | "below" | "above";

export interface ParsedSettings {
  /** The request body, or undefined while any field has a problem. */
  settings?: EvidenceSettings;
  problems: Partial<Record<EvidenceSettingsField, SettingsProblem>>;
  /** Fields whose value differs from what was read. */
  changed: EvidenceSettingsField[];
}

/**
 * Read the form against the bounds. The body names the version the settings
 * were read at, so a save over someone else's is a 409 rather than a silent
 * overwrite.
 */
export function parseSettingsDraft(
  draft: SettingsDraft,
  read: EvidenceSettings,
  bounds: Record<EvidenceSettingsField, [number, number]> = EVIDENCE_SETTINGS_BOUNDS,
): ParsedSettings {
  const problems: ParsedSettings["problems"] = {};
  const changed: EvidenceSettingsField[] = [];
  const next: EvidenceSettings = { ...read };
  for (const field of EVIDENCE_SETTINGS_FIELDS) {
    // A field the operator did not touch keeps the exact value read: the form
    // shows two decimals, and re-parsing 0.93 GiB would quietly lower a cap
    // of 1,000,000,000 bytes to 998,579,896.
    const untouched = String(draft[field]).trim() === toFormValue(field, read[field]);
    const value = untouched ? read[field] : fromFormValue(field, draft[field]);
    if (value === undefined) {
      problems[field] = "invalid";
      continue;
    }
    const [min, max] = bounds[field];
    if (value < min) problems[field] = "below";
    else if (value > max) problems[field] = "above";
    next[field] = value;
    if (value !== read[field]) changed.push(field);
  }
  const ok = Object.keys(problems).length === 0;
  return {
    settings: ok
      ? {
          trace_db_max_bytes: next.trace_db_max_bytes,
          record_ttl_seconds: next.record_ttl_seconds,
          line_ttl_seconds: next.line_ttl_seconds,
          rollup_5m_ttl_seconds: next.rollup_5m_ttl_seconds,
          raw_source_max_bytes: next.raw_source_max_bytes,
          version: read.version,
        }
      : undefined,
    problems,
    changed,
  };
}

/**
 * What a save would take away, one entry per lowered value. A size names
 * the bytes over the new cap when the current size is known (`bytes`
 * undefined when it is not); a duration names the age past which data goes.
 * A lowered value that removes nothing (the store is already under the new
 * cap, the oldest record is younger than the new TTL) is left out.
 */
export type SettingsRemoval =
  | { field: "trace_db_max_bytes" | "raw_source_max_bytes"; kind: "bytes"; bytes?: number }
  | { field: "record_ttl_seconds" | "line_ttl_seconds" | "rollup_5m_ttl_seconds"; kind: "age"; olderThanSeconds: number };

export interface SettingsUsage {
  /** trace.db size now; undefined when stats were not read. */
  traceDbBytes?: number;
  /** The oldest record held; undefined when unknown. */
  oldestRecordAt?: string;
  /** Bytes held per raw log source; undefined when unread. */
  rawSourceBytes?: readonly number[];
  nowMs: number;
}

export function settingsRemovals(read: EvidenceSettings, next: EvidenceSettings, usage: SettingsUsage): SettingsRemoval[] {
  const out: SettingsRemoval[] = [];
  if (next.trace_db_max_bytes < read.trace_db_max_bytes) {
    if (usage.traceDbBytes === undefined) out.push({ field: "trace_db_max_bytes", kind: "bytes" });
    else if (usage.traceDbBytes > next.trace_db_max_bytes) {
      out.push({ field: "trace_db_max_bytes", kind: "bytes", bytes: usage.traceDbBytes - next.trace_db_max_bytes });
    }
  }
  if (next.record_ttl_seconds < read.record_ttl_seconds) {
    const oldest = usage.oldestRecordAt ? Date.parse(usage.oldestRecordAt) : Number.NaN;
    const reaches = Number.isNaN(oldest) || oldest <= 0 || usage.nowMs - oldest > next.record_ttl_seconds * 1000;
    if (reaches) out.push({ field: "record_ttl_seconds", kind: "age", olderThanSeconds: next.record_ttl_seconds });
  }
  if (next.line_ttl_seconds < read.line_ttl_seconds) {
    out.push({ field: "line_ttl_seconds", kind: "age", olderThanSeconds: next.line_ttl_seconds });
  }
  if (next.rollup_5m_ttl_seconds < read.rollup_5m_ttl_seconds) {
    out.push({ field: "rollup_5m_ttl_seconds", kind: "age", olderThanSeconds: next.rollup_5m_ttl_seconds });
  }
  if (next.raw_source_max_bytes < read.raw_source_max_bytes) {
    if (!usage.rawSourceBytes) out.push({ field: "raw_source_max_bytes", kind: "bytes" });
    else {
      const over = usage.rawSourceBytes.reduce((sum, bytes) => sum + Math.max(0, bytes - next.raw_source_max_bytes), 0);
      if (over > 0) out.push({ field: "raw_source_max_bytes", kind: "bytes", bytes: over });
    }
  }
  return out;
}

/**
 * The server saves these settings for a full administrator only: scope `*`
 * held explicitly and no node restriction (lattice-server requireFullAdmin).
 */
export function isFullAdministrator(scopes: readonly string[], serverAllowlist: readonly string[]): boolean {
  return scopes.includes("*") && (serverAllowlist.length === 0 || serverAllowlist.includes("*"));
}

/**
 * After a 409: carry the operator's edits onto the settings someone else
 * just saved. A field the operator left alone takes the new value; a field
 * they edited keeps their entry. `theirs` names the fields the other save
 * changed, and `clashes` those that both changed, where the operator's entry
 * now stands over theirs and should be checked.
 */
export function rebaseSettingsDraft(
  draft: SettingsDraft,
  before: EvidenceSettings,
  after: EvidenceSettings,
): { draft: SettingsDraft; theirs: EvidenceSettingsField[]; clashes: EvidenceSettingsField[] } {
  const next = { ...draft };
  const theirs: EvidenceSettingsField[] = [];
  const clashes: EvidenceSettingsField[] = [];
  for (const field of EVIDENCE_SETTINGS_FIELDS) {
    const edited = String(draft[field]).trim() !== toFormValue(field, before[field]);
    const moved = after[field] !== before[field];
    if (moved) theirs.push(field);
    if (!edited) next[field] = toFormValue(field, after[field]);
    else if (moved) clashes.push(field);
  }
  return { draft: next, theirs, clashes };
}
