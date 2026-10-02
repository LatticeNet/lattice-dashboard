import assert from "node:assert/strict";
import { test } from "node:test";

import { providerDeleteImpact } from "../ssoModel.ts";

const google = { id: "oidc_google", enabled: true };
const okta = { id: "oidc_okta", enabled: true };
const users = [
  { username: "cdcd", has_password: true },
  { username: "vpn-support@openjobs.ai", has_password: false },
  { username: "lidonggui@openjobs.ai", has_password: false },
];

test("the last enabled provider locks out every account with no password, named, and asks for the typed name", () => {
  const impact = providerDeleteImpact({ targetId: google.id, providers: [google], users, canReadUsers: true, usersReading: false });
  assert.deepEqual(impact.lines, [
    { kind: "keep" },
    { kind: "locked", user: "lidonggui@openjobs.ai" },
    { kind: "locked", user: "vpn-support@openjobs.ai" },
  ]);
  assert.equal(impact.typed, true);
  assert.equal(impact.waiting, false);
});

test("with another enabled provider left, an account with no password is named as locked out only if it came through this one", () => {
  const impact = providerDeleteImpact({ targetId: google.id, providers: [google, okta], users, canReadUsers: true, usersReading: false });
  assert.deepEqual(impact.lines.slice(1), [
    { kind: "maybeLocked", user: "lidonggui@openjobs.ai" },
    { kind: "maybeLocked", user: "vpn-support@openjobs.ai" },
  ]);
  assert.equal(impact.typed, true);
});

test("a disabled second provider is no way in", () => {
  const impact = providerDeleteImpact({ targetId: google.id, providers: [google, { ...okta, enabled: false }], users, canReadUsers: true, usersReading: false });
  assert.ok(impact.lines.slice(1).every((line) => line.kind === "locked"));
});

test("only when the accounts were read and every one has a password does the confirm skip the typed name", () => {
  const impact = providerDeleteImpact({ targetId: google.id, providers: [google], users: [users[0]], canReadUsers: true, usersReading: false });
  assert.deepEqual(impact.lines, [{ kind: "keep" }]);
  assert.equal(impact.typed, false);
});

test("an unread account list never says nobody is affected, and asks for the typed name", () => {
  const impact = providerDeleteImpact({ targetId: google.id, providers: [google], users: undefined, canReadUsers: true, usersReading: false });
  assert.deepEqual(impact.lines, [{ kind: "keep" }, { kind: "usersUnread" }]);
  assert.equal(impact.typed, true);
});

test("a caller who may not read the accounts is told so, and types the name", () => {
  const impact = providerDeleteImpact({ targetId: google.id, providers: [google], users, canReadUsers: false, usersReading: false });
  assert.deepEqual(impact.lines, [{ kind: "keep" }, { kind: "usersNoAccess" }]);
  assert.equal(impact.typed, true);
});

test("while the accounts are being read the confirm waits, whatever an earlier read held", () => {
  const impact = providerDeleteImpact({ targetId: google.id, providers: [google], users: [users[0]], canReadUsers: true, usersReading: true });
  assert.deepEqual(impact.lines, [{ kind: "keep" }, { kind: "usersReading" }]);
  assert.equal(impact.waiting, true);
  assert.equal(impact.typed, true);
});
