/**
 * The pure parts of the outbound policy rule editor (design 32 D7), shared by
 * the node policy form and the group matrix cell editor.
 */

export type PortParse =
  | { ok: true; ports: number[] }
  | { ok: false; reason: "range" | "invalid"; token: string };

/**
 * Parse the ports field into the model's port list. NetRule.Ports holds single
 * ports and an empty list means every port, so a token that is not one port
 * from 1 to 65535 is an error, never dropped: the old parser dropped
 * "8000-8010" and saved an empty list, which opened every port. Ports are
 * separated by commas or whitespace. An empty field is every port on
 * purpose; a field holding only separators is an error, since it was not
 * left empty.
 */
export function parsePortList(input: string): PortParse {
  const ports = new Set<number>();
  if (input.trim() && !/[^\s,]/.test(input)) return { ok: false, reason: "invalid", token: input.trim() };
  for (const raw of input.replace(/\s*([-:])\s*/g, "$1").split(/[\s,]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^\d+[-:]\d+$/.test(token)) return { ok: false, reason: "range", token };
    const value = /^\d+$/.test(token) ? Number(token) : Number.NaN;
    if (!(value >= 1 && value <= 65535)) return { ok: false, reason: "invalid", token };
    ports.add(value);
  }
  return { ok: true, ports: [...ports].sort((a, b) => a - b) };
}

/**
 * Ids for the rules a form saves, in order. A draft keeps the id it was
 * loaded with; a new draft, or one whose id another kept rule already holds,
 * gets `<prefix>_<NNN>` with the lowest free number, because the server
 * refuses a policy with two rules of one id.
 */
export function assignRuleIds(drafts: ReadonlyArray<{ id?: string }>, reserved: ReadonlyArray<string>, prefix: string): string[] {
  const used = new Set(reserved);
  const out: string[] = new Array(drafts.length);
  drafts.forEach((draft, index) => {
    if (draft.id && !used.has(draft.id)) {
      used.add(draft.id);
      out[index] = draft.id;
    }
  });
  let next = 1;
  drafts.forEach((_, index) => {
    if (out[index]) return;
    let id = "";
    do {
      id = `${prefix}_${String(next).padStart(3, "0")}`;
      next += 1;
    } while (used.has(id));
    used.add(id);
    out[index] = id;
  });
  return out;
}

/** The fields every outbound rule draft has, in the node form and the matrix. */
export interface PolicyRuleDraft {
  id?: string;
  action: "allow" | "deny";
  protocol: "tcp" | "udp" | "any";
  ports: string;
  comment: string;
  disabled: boolean;
}

export type RuleFieldError =
  | { key: "errAnyNoPorts" }
  | { key: "errPortRange"; token: string }
  | { key: "errPortInvalid"; token: string };

/** The ports problem in a draft, if any; the form turns it into a sentence. */
export function ruleFieldError(draft: Pick<PolicyRuleDraft, "protocol" | "ports">): RuleFieldError | undefined {
  if (draft.protocol === "any") return draft.ports.trim() ? { key: "errAnyNoPorts" } : undefined;
  const parsed = parsePortList(draft.ports);
  if (parsed.ok) return undefined;
  return parsed.reason === "range" ? { key: "errPortRange", token: parsed.token } : { key: "errPortInvalid", token: parsed.token };
}

/** The port list a draft saves; only call it on a draft without a field error. */
export function draftPorts(draft: Pick<PolicyRuleDraft, "protocol" | "ports">): number[] {
  if (draft.protocol === "any") return [];
  const parsed = parsePortList(draft.ports);
  if (!parsed.ok) throw new Error(`ports field has an error at "${parsed.token}"`);
  return parsed.ports;
}
