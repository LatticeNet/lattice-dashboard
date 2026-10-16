/**
 * The sign-in page's decisions about the SSO round trip, kept out of
 * LoginView.vue so they run on bare node and the router can share them.
 */

/** The shape of the challenge id the SSO callback puts in `?totp_challenge=`. */
const CHALLENGE_ID = /^[A-Za-z0-9_-]{32,128}$/;

/** The second-factor challenge carried back from SSO, or undefined when the value is not one. */
export function ssoChallengeFromQuery(value: unknown): string | undefined {
  return typeof value === "string" && CHALLENGE_ID.test(value) ? value : undefined;
}

/**
 * Whether a navigation lands on sign-in straight back from SSO with a second
 * factor still owed. The SSO callback started no session on the way here, so
 * reading the session first would only log a 401; completing the second
 * factor reads it.
 */
export function landsOnSsoSecondFactor(to: { name?: unknown; query: Record<string, unknown> }): boolean {
  return to.name === "login" && ssoChallengeFromQuery(to.query.totp_challenge) !== undefined;
}

/** Which provider verified the operator, and as whom. */
export interface SsoVerifiedIdentity {
  provider: string;
  identity: string;
}

/**
 * Reads GET /api/login/totp: the provider's name and the verified email, or the
 * subject when the provider verified no email. Anything else yields undefined,
 * so a server without the read leaves the page with its plain copy.
 */
export function ssoVerifiedIdentity(raw: unknown): SsoVerifiedIdentity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const fields = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const provider = text(fields.provider);
  const identity = text(fields.email) || text(fields.subject);
  return provider && identity ? { provider, identity } : undefined;
}
