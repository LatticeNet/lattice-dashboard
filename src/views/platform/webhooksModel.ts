import type { NotifyWebhookDelivery, NotifyWebhookView } from "@/lib/api";

/**
 * Logic behind the Webhooks page, kept out of the .vue file so it can be tested
 * on bare node. Nothing here imports Vue.
 *
 * The page's real job is not CRUD, it is making a two-sided contract legible.
 * The operator authors the event type and the templates; the caller supplies
 * data fields. Neither half is visible from the other's side, so the console has
 * to derive and show it: which fields this webhook's templates ask for, what the
 * caller's request must look like, and whether anything is actually listening.
 */

/** Tone for the badge on a delivery outcome. */
export type OutcomeTone = "success" | "warning" | "destructive" | "secondary";

export function outcomeTone(outcome: string): OutcomeTone {
  switch (outcome) {
    case "accepted":
      return "success";
    // A webhook that authenticated and rendered but reached nobody is not a
    // failure of the caller and not a success for the operator. It is the state
    // a fleet with no channels configured is permanently in, so it gets its own
    // tone rather than being coloured as either.
    case "no_route":
    case "partial":
      return "warning";
    case "rejected":
    case "failed":
      return "destructive";
    default:
      return "secondary";
  }
}

/** The absolute URL a caller posts to, from the origin the operator is browsing. */
export function webhookUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * The {{data.*}} placeholders an operator's templates reference, in first-seen
 * order and deduplicated.
 *
 * This is the contract the caller has to satisfy, and it exists nowhere else:
 * the server never sees the caller until it calls, and the caller never sees the
 * template. Deriving it from the templates means the field list cannot drift
 * away from what the message actually interpolates.
 */
export function requiredDataFields(hook: Pick<NotifyWebhookView, "title_template" | "body_template">): string[] {
  const seen: string[] = [];
  const source = `${hook.title_template ?? ""}\n${hook.body_template ?? ""}`;
  for (const match of source.matchAll(/\{\{\s*data\.([A-Za-z0-9_-]+)\s*\}\}/g)) {
    const field = match[1];
    if (field && !seen.includes(field)) seen.push(field);
  }
  return seen;
}

/**
 * Renders a variable name as the placeholder an operator types.
 *
 * It exists because a Vue template cannot hold a literal "{{" inside an
 * interpolation: the parser reads it as a nested mustache and the build fails.
 * Composing the braces in script is the only way this page can show an operator
 * the exact text they need to type.
 */
export function placeholderLabel(name: string): string {
  return `{{${name}}}`;
}

/** Placeholders the platform fills in, so the form can list them as available. */
export const PLATFORM_TEMPLATE_VARS = [
  "event_type",
  "webhook_name",
  "webhook_id",
  "received_at",
] as const;

/**
 * Placeholders a template references that neither the platform provides nor the
 * {{data.*}} namespace can supply. These render literally in the delivered
 * message, which is how a typo reaches a phone, so the form warns about them
 * before the webhook is saved.
 */
export function unknownTemplateVars(titleTemplate: string, bodyTemplate: string): string[] {
  const out: string[] = [];
  const source = `${titleTemplate}\n${bodyTemplate}`;
  for (const match of source.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const name = match[1];
    if (!name || name.startsWith("data.")) continue;
    if ((PLATFORM_TEMPLATE_VARS as readonly string[]).includes(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Mirrors the server's event-type rule so the form can refuse before the round
 * trip. "*" is valid for a rule to match on but not for a source to emit, and
 * the server rejects it for exactly that reason.
 */
export function eventTypeError(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "required";
  if (trimmed === "*") return "wildcard";
  if (trimmed.length > 64) return "tooLong";
  if (!/^[a-z0-9._:-]+$/.test(trimmed)) return "charset";
  return undefined;
}

/** Caps the server enforces, restated so the form can show them. */
export const WEBHOOK_LIMITS = {
  maxFields: 16,
  maxValueChars: 512,
  maxBodyBytes: 8192,
} as const;

/**
 * Parses the test dialog's "key=value per line" input. Deliberately not JSON:
 * the operator is filling in a handful of template fields, and hand-writing JSON
 * to do it is a worse experience with more ways to be wrong.
 */
export function parseFieldLines(input: string): { data: Record<string, string>; error?: string } {
  const data: Record<string, string> = {};
  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { data: {}, error: "syntax" };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return { data: {}, error: "key" };
    if (value.length > WEBHOOK_LIMITS.maxValueChars) return { data: {}, error: "value" };
    data[key] = value;
  }
  if (Object.keys(data).length > WEBHOOK_LIMITS.maxFields) return { data: {}, error: "count" };
  return { data };
}

/**
 * The command an operator hands to whoever is going to call this webhook.
 *
 * The secret goes in the Authorization header, never in the URL, and the example
 * has to teach that: an operator who copies a URL-with-token example will build
 * a system that leaks its credential into every access log between here and the
 * caller. `secret` is only present right after create or rotate; the rest of the
 * time the example shows the placeholder, because the server cannot recover it.
 */
export function curlExample(
  origin: string,
  hook: Pick<NotifyWebhookView, "path" | "title_template" | "body_template">,
  secret?: string,
): string {
  const url = webhookUrl(origin, hook.path);
  const fields = requiredDataFields(hook);
  const body = fields.length
    ? `{"data":{${fields.map((f) => `"${f}":"..."`).join(",")}}}`
    : "";
  const lines = [
    `curl -X POST '${url}' \\`,
    `  -H 'Authorization: Bearer ${secret ?? "<webhook-secret>"}' \\`,
  ];
  if (body) {
    lines.push(`  -H 'Content-Type: application/json' \\`, `  -d '${body}'`);
    return lines.join("\n");
  }
  // Trim the trailing continuation so the command runs as pasted.
  return lines.join("\n").replace(/ \\$/, "");
}

/**
 * A one-line health read for a webhook, from its retained attempts.
 *
 * "Never called" and "called and routed nowhere" are different problems with
 * different fixes (the caller is not wired up, versus no rule matches), and a
 * plain last-outcome badge collapses them into the same grey. This keeps them apart.
 */
export type WebhookHealth = "never" | "ok" | "no_route" | "failing" | "rejecting";

export function webhookHealth(deliveries: NotifyWebhookDelivery[]): WebhookHealth {
  if (!deliveries.length) return "never";
  // Deliveries arrive newest first from the server.
  const latest = deliveries[0];
  switch (latest?.outcome) {
    case "accepted":
      return "ok";
    case "no_route":
      return "no_route";
    case "rejected":
      return "rejecting";
    default:
      return "failing";
  }
}

export function healthTone(health: WebhookHealth): OutcomeTone {
  switch (health) {
    case "ok":
      return "success";
    case "no_route":
      return "warning";
    case "failing":
    case "rejecting":
      return "destructive";
    default:
      return "secondary";
  }
}
