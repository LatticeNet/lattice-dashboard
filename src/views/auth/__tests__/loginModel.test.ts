import assert from "node:assert/strict";
import { test } from "node:test";

import { landsOnSsoSecondFactor, ssoChallengeFromQuery, ssoVerifiedIdentity } from "../loginModel.ts";

const challenge = "aB3_-".repeat(9); // 45 characters, the callback's base64url shape

test("a challenge id from the SSO redirect is taken only in its own shape", () => {
  assert.equal(ssoChallengeFromQuery(challenge), challenge);
  assert.equal(ssoChallengeFromQuery("short"), undefined);
  assert.equal(ssoChallengeFromQuery("x".repeat(129)), undefined);
  assert.equal(ssoChallengeFromQuery(`${challenge}<script>`), undefined);
  assert.equal(ssoChallengeFromQuery([challenge]), undefined);
  assert.equal(ssoChallengeFromQuery(null), undefined);
});

test("only sign-in carrying a challenge counts as landing on the SSO second factor", () => {
  assert.equal(landsOnSsoSecondFactor({ name: "login", query: { totp_challenge: challenge, redirect: "/nodes" } }), true);
  assert.equal(landsOnSsoSecondFactor({ name: "login", query: { redirect: "/nodes" } }), false);
  assert.equal(landsOnSsoSecondFactor({ name: "login", query: { totp_challenge: "nope" } }), false);
  assert.equal(landsOnSsoSecondFactor({ name: "login", query: { sso_error: "expired" } }), false);
  assert.equal(landsOnSsoSecondFactor({ name: "home", query: { totp_challenge: challenge } }), false);
});

test("the provider and the verified email name the operator", () => {
  assert.deepEqual(ssoVerifiedIdentity({ provider: "Google", email: "name@example.com" }), {
    provider: "Google",
    identity: "name@example.com",
  });
});

test("without a verified email the subject stands in", () => {
  assert.deepEqual(ssoVerifiedIdentity({ provider: "corp", subject: "109876543210" }), {
    provider: "corp",
    identity: "109876543210",
  });
  assert.deepEqual(ssoVerifiedIdentity({ provider: "corp", email: " ", subject: "109876543210" }), {
    provider: "corp",
    identity: "109876543210",
  });
});

test("anything short of a provider and an identity says nothing", () => {
  for (const raw of [
    undefined,
    null,
    "",
    "Google",
    {},
    { provider: "Google" },
    { email: "name@example.com" },
    { provider: "  ", email: "name@example.com" },
    { provider: 7, email: "name@example.com" },
    { provider: "Google", email: 7 },
    { error: "no pending sso sign-in" },
  ]) {
    assert.equal(ssoVerifiedIdentity(raw), undefined, JSON.stringify(raw));
  }
});
