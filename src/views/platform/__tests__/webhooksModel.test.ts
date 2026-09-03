import assert from "node:assert/strict";
import test from "node:test";

import {
  curlExample,
  eventTypeError,
  healthTone,
  outcomeTone,
  parseFieldLines,
  placeholderLabel,
  requiredDataFields,
  unknownTemplateVars,
  webhookHealth,
  webhookUrl,
  WEBHOOK_LIMITS,
} from "../webhooksModel.ts";
import type { NotifyWebhookDelivery } from "@/lib/api";

test("webhookUrl joins an origin and a server path without doubling the slash", () => {
  assert.equal(webhookUrl("https://lattice.example", "/api/hooks/nwh_1"), "https://lattice.example/api/hooks/nwh_1");
  assert.equal(webhookUrl("https://lattice.example/", "/api/hooks/nwh_1"), "https://lattice.example/api/hooks/nwh_1");
  assert.equal(webhookUrl("https://lattice.example///", "api/hooks/nwh_1"), "https://lattice.example/api/hooks/nwh_1");
});

test("requiredDataFields lists the caller's contract in first-seen order", () => {
  const fields = requiredDataFields({
    title_template: "Backup of {{data.host}} finished",
    body_template: "{{data.detail}} on {{data.host}} at {{received_at}}",
  });
  assert.deepEqual(fields, ["host", "detail"]);
});

test("requiredDataFields tolerates whitespace and a missing body template", () => {
  assert.deepEqual(requiredDataFields({ title_template: "{{ data.a }}", body_template: undefined }), ["a"]);
  assert.deepEqual(requiredDataFields({ title_template: "no placeholders", body_template: "" }), []);
});

/**
 * The typo case is the one that reaches a phone: an unknown placeholder renders
 * literally in the delivered message rather than failing loudly, so the form has
 * to catch it before the webhook is saved.
 */
test("unknownTemplateVars flags placeholders neither the platform nor data supplies", () => {
  assert.deepEqual(unknownTemplateVars("{{event_type}} {{data.x}}", "{{received_at}}"), []);
  assert.deepEqual(unknownTemplateVars("{{message}}", "{{ body }}"), ["message", "body"]);
  assert.deepEqual(unknownTemplateVars("{{dupe}} {{dupe}}", ""), ["dupe"]);
});

/**
 * A malformed data placeholder was invisible to both functions: requiredDataFields
 * dropped it for not matching the field charset, and unknownTemplateVars waved it
 * through on the "data." prefix alone. The server leaves it standing in the
 * delivered message, so it is exactly the typo the warning exists to catch.
 */
test("unknownTemplateVars flags a malformed data placeholder the caller cannot satisfy", () => {
  for (const bad of ["{{data.}}", "{{data. }}", "{{data.$foo}}", "{{data.foo bar}}", "{{data.a.b}}"]) {
    assert.deepEqual(requiredDataFields({ title_template: bad, body_template: "" }), [], `${bad} names no field`);
    assert.ok(unknownTemplateVars(bad, "").length > 0, `${bad} must be flagged`);
  }
  // A well-formed one is still known, with or without surrounding whitespace.
  assert.deepEqual(unknownTemplateVars("{{data.ok}} {{ data.also-ok }}", ""), []);
});

test("eventTypeError mirrors the server rules, including the wildcard refusal", () => {
  assert.equal(eventTypeError("backup.finished"), undefined);
  assert.equal(eventTypeError("  Backup.Finished  "), undefined);
  assert.equal(eventTypeError(""), "required");
  assert.equal(eventTypeError("*"), "wildcard");
  assert.equal(eventTypeError("has space"), "charset");
  assert.equal(eventTypeError("a/b"), "charset");
  assert.equal(eventTypeError("x".repeat(65)), "tooLong");
});

test("parseFieldLines reads key=value lines and refuses what the server would", () => {
  assert.deepEqual(parseFieldLines("host=edge-1\ndetail=disk at 92%"), {
    data: { host: "edge-1", detail: "disk at 92%" },
  });
  assert.deepEqual(parseFieldLines("\n\n  \n"), { data: {} });
  // A value may contain the separator; only the first one splits.
  assert.deepEqual(parseFieldLines("url=https://x/y?a=b"), { data: { url: "https://x/y?a=b" } });
  assert.equal(parseFieldLines("novalue").error, "syntax");
  assert.equal(parseFieldLines("=novalue").error, "syntax");
  assert.equal(parseFieldLines("bad key=v").error, "key");
  // The server caps a field name at 64 characters; the console used to accept
  // longer ones and only find out from the 400.
  assert.equal(parseFieldLines(`${"k".repeat(WEBHOOK_LIMITS.maxKeyChars)}=v`).error, undefined);
  assert.equal(parseFieldLines(`${"k".repeat(WEBHOOK_LIMITS.maxKeyChars + 1)}=v`).error, "keyLength");
  assert.equal(parseFieldLines(`k=${"x".repeat(WEBHOOK_LIMITS.maxValueChars + 1)}`).error, "value");
  const tooMany = Array.from({ length: WEBHOOK_LIMITS.maxFields + 1 }, (_, i) => `k${i}=v`).join("\n");
  assert.equal(parseFieldLines(tooMany).error, "count");
});

/**
 * The credential must never appear in the URL. An operator copies this example
 * verbatim into whatever is going to call the webhook, so if it taught a
 * URL-borne token the leak would be built in from the first integration.
 */
test("curlExample puts the secret in a header and never in the URL", () => {
  const hook = { path: "/api/hooks/nwh_1", title_template: "{{data.host}}", body_template: "{{data.detail}}" };
  const withSecret = curlExample("https://lattice.example", hook, "nwh_1.s3cr3t");
  assert.match(withSecret, /-H 'Authorization: Bearer nwh_1\.s3cr3t'/);
  assert.ok(!withSecret.includes("https://lattice.example/api/hooks/nwh_1?"), "no query string");
  const urlLine = withSecret.split("\n")[0];
  assert.ok(!urlLine.includes("s3cr3t"), "the secret must not appear on the URL line");
  assert.match(withSecret, /"host":"\.\.\."/);
  assert.match(withSecret, /"detail":"\.\.\."/);
});

test("curlExample without data fields is a runnable command with no dangling continuation", () => {
  const out = curlExample("https://lattice.example", {
    path: "/api/hooks/nwh_2",
    title_template: "Ping",
    body_template: "",
  });
  assert.ok(!out.trimEnd().endsWith("\\"), `command must not end in a continuation: ${out}`);
  assert.match(out, /Bearer <webhook-secret>/);
});

/**
 * A Vue template cannot hold a literal "{{" inside an interpolation, so this
 * page composes placeholder text in script. Pinning it here keeps the build
 * failure from coming back the next time someone inlines it.
 */
test("placeholderLabel wraps a variable name in the braces an operator types", () => {
  assert.equal(placeholderLabel("event_type"), "{{event_type}}");
  assert.equal(placeholderLabel("data.host"), "{{data.host}}");
});

test("outcomeTone separates 'reached nobody' from success and from failure", () => {
  assert.equal(outcomeTone("accepted"), "success");
  assert.equal(outcomeTone("no_route"), "warning");
  assert.equal(outcomeTone("partial"), "warning");
  assert.equal(outcomeTone("failed"), "destructive");
  assert.equal(outcomeTone("rejected"), "destructive");
  assert.equal(outcomeTone("something-new"), "secondary");
});

function delivery(outcome: string): NotifyWebhookDelivery {
  return {
    id: "nwd_1",
    webhook_id: "nwh_1",
    outcome,
    fields: 0,
    bytes: 0,
    channels: 0,
    delivered: 0,
    created_at: "2026-09-03T00:00:00Z",
  };
}

test("webhookHealth keeps 'never called' apart from 'called and routed nowhere'", () => {
  assert.equal(webhookHealth([]), "never");
  assert.equal(webhookHealth([delivery("accepted")]), "ok");
  assert.equal(webhookHealth([delivery("no_route")]), "no_route");
  assert.equal(webhookHealth([delivery("rejected")]), "rejecting");
  assert.equal(webhookHealth([delivery("failed")]), "failing");
  // Newest first: the latest attempt decides, not the history behind it.
  assert.equal(webhookHealth([delivery("accepted"), delivery("failed")]), "ok");
  assert.equal(healthTone("never"), "secondary");
  assert.equal(healthTone("ok"), "success");
  assert.equal(healthTone("no_route"), "warning");
});
