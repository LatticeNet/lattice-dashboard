import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { allowedClientsText, isOpenResolverDraft, parseAllowedClients } from "../dnsAllowedClientsModel.ts";

test("the field reads one network per line, and commas or spaces as well", () => {
  assert.deepEqual(parseAllowedClients("203.0.113.0/24\n 2001:db8::/32 \n\n198.51.100.0/24, 192.0.2.0/24"), [
    "203.0.113.0/24",
    "2001:db8::/32",
    "198.51.100.0/24",
    "192.0.2.0/24",
  ]);
  assert.deepEqual(parseAllowedClients("  \n "), []);
  // The server judges each entry and names the one it refuses, so the field
  // passes what was typed rather than dropping what it does not like.
  assert.deepEqual(parseAllowedClients("10.0.0.1/8"), ["10.0.0.1/8"]);
  assert.equal(allowedClientsText(["203.0.113.0/24", "2001:db8::/32"]), "203.0.113.0/24\n2001:db8::/32");
  assert.equal(allowedClientsText(undefined), "");
});

test("a public forward draft is an open resolver until it names its clients", () => {
  const draft = { exposure: "public", zoneModes: ["static", "forward"], allowedClients: [] as string[] };
  assert.equal(isOpenResolverDraft(draft), true);
  assert.equal(isOpenResolverDraft({ ...draft, allowedClients: ["203.0.113.0/24"] }), false);
  assert.equal(isOpenResolverDraft({ ...draft, exposure: "mesh" }), false);
  assert.equal(isOpenResolverDraft({ ...draft, zoneModes: ["static", "block"] }), false);
});

test("DnsView marks the field for a refusal and sends what it parsed", () => {
  const view = readFileSync(new URL("../DnsView.vue", import.meta.url), "utf8");
  const dialog = view.slice(view.indexOf("<!-- Create / edit dialog -->"), view.indexOf("<!-- Measure this certificate -->"));
  assert.match(dialog, /data-field="allowed_clients"/, "a refusal naming allowed_clients has no control to land on");
  assert.match(view, /useSaveRefusal/);
  assert.match(view, /allowed_clients: parseAllowedClients\(form\.allowed_clients\)/);
  assert.match(view, /isOpenResolverDraft\(/);
});
