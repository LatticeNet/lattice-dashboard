import assert from "node:assert/strict";
import test from "node:test";

import {
  ssoErrorMessage,
  hasAuthRedirectParams,
  readAuthRedirect,
  strippedAuthSearch,
  oidcStartURL,
  oidcProviderPayload,
  oidcDeleteConfirmMessage,
  confirmOIDCDelete,
} from "./sso.js";

test("ssoErrorMessage maps known codes and falls back for unknown", () => {
  assert.match(ssoErrorMessage("denied"), /not provisioned/);
  assert.match(ssoErrorMessage("csrf"), /could not be verified/);
  assert.equal(ssoErrorMessage(""), "");
  assert.equal(ssoErrorMessage(null), "");
  assert.equal(ssoErrorMessage("totally_unknown"), "Single sign-on failed. Please try again.");
});

test("readAuthRedirect extracts sso params", () => {
  assert.deepEqual(readAuthRedirect("?sso_error=denied"), { ssoError: "denied", totpChallenge: null });
  assert.deepEqual(readAuthRedirect("?totp_challenge=AbCdEf1234567890_-AbCdEf1234567890_-AbCdE"), {
    ssoError: null,
    totpChallenge: "AbCdEf1234567890_-AbCdEf1234567890_-AbCdE",
  });
  assert.deepEqual(readAuthRedirect(""), { ssoError: null, totpChallenge: null });
  assert.deepEqual(readAuthRedirect("?foo=bar"), { ssoError: null, totpChallenge: null });
});

test("readAuthRedirect rejects forged or malformed totp challenges", () => {
  assert.deepEqual(readAuthRedirect("?totp_challenge=fake"), { ssoError: null, totpChallenge: null });
  assert.deepEqual(readAuthRedirect("?totp_challenge=%3Cscript%3E"), { ssoError: null, totpChallenge: null });
  assert.deepEqual(readAuthRedirect("?totp_challenge=abc%20def1234567890abc_def1234567890"), {
    ssoError: null,
    totpChallenge: null,
  });
});

test("hasAuthRedirectParams detects raw SSO landing params even when values are invalid", () => {
  assert.equal(hasAuthRedirectParams("?totp_challenge=fake"), true);
  assert.equal(hasAuthRedirectParams("?sso_error=denied"), true);
  assert.equal(hasAuthRedirectParams("?keep=1"), false);
});

test("strippedAuthSearch removes only the SSO params", () => {
  assert.equal(strippedAuthSearch("?sso_error=denied"), "");
  assert.equal(strippedAuthSearch("?totp_challenge=x&keep=1"), "?keep=1");
  assert.equal(strippedAuthSearch("?a=1&sso_error=e&b=2"), "?a=1&b=2");
  assert.equal(strippedAuthSearch(""), "");
});

test("oidcStartURL encodes provider and redirect", () => {
  assert.equal(oidcStartURL("g"), "/api/auth/oidc/start?provider=g&redirect=%2F");
  const url = oidcStartURL("prov id/weird", "/dash?x=1");
  assert.ok(url.startsWith("/api/auth/oidc/start?"));
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("provider"), "prov id/weird");
  assert.equal(q.get("redirect"), "/dash?x=1");
});

test("oidcProviderPayload normalizes fields", () => {
  const body = oidcProviderPayload({
    display_name: "  Google  ",
    issuer: "https://accounts.google.com/",
    client_id: " cid ",
    client_secret: "shh",
    allowed_domains: "example.com, corp.io  example.com",
    scopes: "openid email",
    enabled: true,
    id: " p1 ",
  });
  assert.deepEqual(body, {
    display_name: "Google",
    issuer: "https://accounts.google.com", // trailing slash trimmed
    client_id: "cid",
    allowed_domains: ["example.com", "corp.io"], // split + de-duped
    scopes: ["openid", "email"],
    enabled: true,
    id: "p1",
    client_secret: "shh",
  });
});

test("oidcProviderPayload omits empty secret and empty id", () => {
  const body = oidcProviderPayload({
    issuer: "https://idp",
    client_id: "c",
    client_secret: "   ",
    id: "",
    enabled: false,
  });
  assert.ok(!("client_secret" in body), "empty or whitespace-only secret must be omitted to preserve stored value");
  assert.ok(!("id" in body), "empty id must be omitted so the server creates a new provider");
  assert.equal(body.enabled, false);
  assert.deepEqual(body.allowed_domains, []);
});

test("oidcDeleteConfirmMessage identifies the provider without exposing secret material", () => {
  assert.equal(
    oidcDeleteConfirmMessage({ id: "oidc_123", display_name: "Google" }),
    'Delete SSO provider "Google"? This cannot be undone.',
  );
  assert.equal(
    oidcDeleteConfirmMessage({ id: "oidc_123", display_name: "" }),
    'Delete SSO provider "oidc_123"? This cannot be undone.',
  );
});

test("confirmOIDCDelete delegates the final decision to the provided confirm function", () => {
  const messages = [];
  assert.equal(confirmOIDCDelete({ id: "oidc_123" }, (message) => {
    messages.push(message);
    return false;
  }), false);
  assert.deepEqual(messages, ['Delete SSO provider "oidc_123"? This cannot be undone.']);
  assert.equal(confirmOIDCDelete({ id: "oidc_123" }, () => true), true);
  assert.equal(confirmOIDCDelete({ id: "oidc_123" }, null), false);
});
