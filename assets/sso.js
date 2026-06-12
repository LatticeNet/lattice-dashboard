// Pure (DOM-free, CSP-safe) helpers for the SSO/OIDC login UI. Kept separate
// from app.js so they can be unit-tested with `node --test`.

const ssoErrorMessages = {
  csrf: "Sign-in could not be verified (the request did not originate from this browser). Please try again.",
  expired: "The sign-in request expired. Please try again.",
  denied: "Access denied: your identity is not provisioned on this server. Ask an administrator to add your account.",
  verify_failed: "The identity provider could not be verified. Please try again.",
  provider_error: "The identity provider returned an error. Please try again.",
  ip_mismatch: "Your network address changed during sign-in. Please try again.",
  unavailable: "Single sign-on is temporarily unavailable. Please try again later.",
  bad_request: "The sign-in response was malformed. Please try again.",
  session_failed: "The session could not be started. Please try again.",
};

const totpChallengePattern = /^[A-Za-z0-9_-]{32,128}$/;

// ssoErrorMessage maps a backend sso_error code to friendly copy, with a safe
// fallback for unknown codes.
export function ssoErrorMessage(code) {
  if (!code) return "";
  return ssoErrorMessages[code] || "Single sign-on failed. Please try again.";
}

// hasAuthRedirectParams reports whether the landing URL contains one-time auth
// redirect parameters, even if a specific value is invalid and should be ignored.
export function hasAuthRedirectParams(search) {
  const params = new URLSearchParams(search || "");
  return params.has("sso_error") || params.has("totp_challenge");
}

// readAuthRedirect extracts the SSO landing parameters from a location search
// string. TOTP challenges must look like server-issued random tokens before the
// UI resumes the second-factor step, otherwise an arbitrary URL could make the
// real login page solicit a 2FA code.
export function readAuthRedirect(search) {
  const params = new URLSearchParams(search || "");
  const challenge = params.get("totp_challenge");
  return {
    ssoError: params.get("sso_error"),
    totpChallenge: totpChallengePattern.test(challenge || "") ? challenge : null,
  };
}

// strippedAuthSearch returns the query string with the SSO landing parameters
// removed (other params preserved), suitable for history.replaceState. Includes
// a leading "?" only when something remains.
export function strippedAuthSearch(search) {
  const params = new URLSearchParams(search || "");
  params.delete("sso_error");
  params.delete("totp_challenge");
  const rest = params.toString();
  return rest ? "?" + rest : "";
}

// oidcStartURL builds the provider sign-in URL. The provider id and redirect are
// URL-encoded; redirect defaults to the app root.
export function oidcStartURL(providerId, redirect = "/") {
  const q = new URLSearchParams({ provider: providerId, redirect });
  return "/api/auth/oidc/start?" + q.toString();
}

// splitList turns a comma/whitespace separated string into a trimmed,
// duplicate-free, non-empty list.
function splitList(value) {
  const seen = new Set();
  for (const part of String(value || "").split(/[,\s]+/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

// oidcProviderPayload normalizes the admin provider form into a POST body.
// An empty client_secret is omitted so the stored secret is preserved on edit;
// an empty id is omitted so the server creates a new provider.
export function oidcProviderPayload(fields) {
  const body = {
    display_name: String(fields.display_name || "").trim(),
    issuer: String(fields.issuer || "").trim().replace(/\/+$/, ""),
    client_id: String(fields.client_id || "").trim(),
    allowed_domains: splitList(fields.allowed_domains),
    scopes: splitList(fields.scopes),
    enabled: Boolean(fields.enabled),
  };
  const id = String(fields.id || "").trim();
  if (id) body.id = id;
  const secret = String(fields.client_secret || "");
  if (secret.trim()) body.client_secret = secret;
  return body;
}

export function oidcDeleteConfirmMessage(provider) {
  const name = String(provider?.display_name || provider?.id || "this provider").trim() || "this provider";
  return `Delete SSO provider "${name}"? This cannot be undone.`;
}

export function confirmOIDCDelete(provider, confirmFn) {
  if (typeof confirmFn !== "function") return false;
  return Boolean(confirmFn(oidcDeleteConfirmMessage(provider)));
}
