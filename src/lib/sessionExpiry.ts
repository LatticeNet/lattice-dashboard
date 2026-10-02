/**
 * Noticing that the session is gone (sessions last 12 hours on the server).
 *
 * Before this, a tab left open past its session kept polling: every page's
 * reads answered 401, each page showed its own "refresh failed" line, and
 * nothing ever sent the operator back to sign in. Now the API client reports
 * every 401 with the path that answered it, and this decides whether the
 * session is really gone before anyone is moved.
 *
 * A 401 does not always mean that. The server also answers 401 for a wrong
 * current password, a wrong second factor at step-up or 2FA setup, and a
 * failed passkey ceremony, all with the same "unauthorized" code. So a 401
 * from a path that is not a session check is confirmed with one read of
 * /api/me: only when that read is refused too is the session over. Several
 * pages failing at once share one confirmation, and a 401 that arrives while
 * signed out (or signing out) asks nothing.
 *
 * Kept free of Vue and the router so `node --test` covers it directly.
 */

/**
 * Paths whose 401 says something other than "the session is gone": the
 * session check itself (it would confirm itself forever), signing in and
 * out, and the second-factor and password endpoints that refuse a wrong
 * code with 401.
 */
const NOT_A_SESSION_CHECK: readonly RegExp[] = [
  /^\/api\/me(?:[?#]|$)/,
  /^\/api\/login(?:[/?#]|$)/,
  /^\/api\/logout(?:[?#]|$)/,
  /^\/api\/auth\//,
  /^\/api\/2fa\//,
  /^\/api\/security\/step-up(?:[?#]|$)/,
];

/** Whether a 401 from this path should make the console check the session. */
export function isSessionSignal(path: string): boolean {
  return path.startsWith("/api/") && !NOT_A_SESSION_CHECK.some((re) => re.test(path));
}

export interface SessionWatchDeps {
  /** True when the session is gone (the check itself was refused), false when it is fine. Throwing decides nothing. */
  sessionGone: () => Promise<boolean>;
  /** Whether there is a session to lose: signed in and not signing out. */
  signedIn: () => boolean;
  /** Called once per lost session, after the check said so. */
  onExpired: () => void;
}

export interface SessionWatch {
  /** A call to `path` answered 401. Resolves once any check it started is done. */
  report: (path: string) => Promise<void>;
}

export function createSessionWatch(deps: SessionWatchDeps): SessionWatch {
  let checking: Promise<void> | null = null;

  async function check(): Promise<void> {
    try {
      // Signed out while the check ran (a sign-out, or a second check) means
      // there is nothing left to expire.
      if ((await deps.sessionGone()) && deps.signedIn()) deps.onExpired();
    } catch {
      // A check that could not answer (offline, a 5xx) decides nothing; the
      // next 401 asks again.
    } finally {
      checking = null;
    }
  }

  return {
    report(path: string): Promise<void> {
      if (checking) return checking;
      if (!isSessionSignal(path) || !deps.signedIn()) return Promise.resolve();
      checking = check();
      return checking;
    },
  };
}

/** The reason the sign-in page names, carried in its query. */
export const EXPIRED_REASON = "expired";

/** Where a lost session goes: sign-in, with the way back and the reason. */
export function expiredSignInLocation(fullPath: string): { name: "login"; query: { redirect: string; reason: string } } {
  const back = fullPath.startsWith("/") && !fullPath.startsWith("//") ? fullPath : "/";
  return { name: "login", query: { redirect: back, reason: EXPIRED_REASON } };
}
