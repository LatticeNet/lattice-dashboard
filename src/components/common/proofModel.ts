/**
 * Pure model for the proof line (design 23, section 3.1): which of six states
 * a read is in, and when a polled read turns stale.
 *
 * A 10 s poll is not "live". What a page can honestly say is when it last
 * read, what that read held, and whether the refresh since has failed. The
 * states below are that sentence's grammar; ProofLine renders them and
 * useProof derives them from a useAsyncData result, so no page computes
 * freshness on its own again.
 *
 * Kept free of Vue so `node --test` covers it directly (house *Model.ts
 * pattern).
 */

export type ProofState = "loading" | "observed" | "refreshing" | "stale" | "failed" | "idle";

/** A page turns stale once its last good read is this many poll intervals old. */
export const PROOF_STALE_FACTOR = 1.5;

/**
 * Age past which a polled read counts as stale, or undefined when the page
 * does not poll: a read nobody promised to repeat cannot fall behind.
 */
export function staleAfterMs(pollMs: number | undefined): number | undefined {
  if (!pollMs || !Number.isFinite(pollMs) || pollMs <= 0) return undefined;
  return pollMs * PROOF_STALE_FACTOR;
}

export interface ProofInput {
  /** A read has succeeded at least once, so there is something to show. */
  hasData: boolean;
  /** A request is in flight. */
  pending: boolean;
  /** The most recent request failed. */
  error: unknown;
  /** When the last good read landed (ms epoch). */
  observedAt?: number | null;
  /** The page's poll interval; 0 or undefined when it does not poll. */
  pollMs?: number;
  now: number;
}

/**
 * The state a read is in.
 *
 * Without data, a failure is `failed` (nothing to show, so no counts) and
 * anything else is `loading`. With data, a failed refresh or a poll that has
 * gone quiet for 1.5 intervals is `stale`; the last good segments stay, muted.
 * A refresh in flight is `refreshing`, never a blank. Otherwise a polled page
 * is `observed` and a page that reads once is `idle`, which prints no age.
 */
export function proofState(input: ProofInput): ProofState {
  if (!input.hasData) return input.error ? "failed" : "loading";
  if (input.error) return "stale";
  const limit = staleAfterMs(input.pollMs);
  if (limit !== undefined && input.observedAt != null && input.now - input.observedAt >= limit) {
    // A refresh already on its way still counts: the page has not heard back
    // for longer than it promised, and saying so is the point.
    return "stale";
  }
  if (input.pending) return "refreshing";
  return limit === undefined ? "idle" : "observed";
}

/**
 * The reason a read failed, in the server's words when it sent any. Kept to
 * one line: a proof line is a sentence, not a stack trace.
 */
export function proofReason(error: unknown): string {
  if (!error) return "";
  const record = error as { serverMessage?: unknown; message?: unknown; status?: unknown };
  const server = typeof record.serverMessage === "string" ? record.serverMessage.trim() : "";
  const message = typeof record.message === "string" ? record.message.trim() : "";
  const text = server || message || String(error);
  const line = text.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

/**
 * Whether the old freshness pill has anything true to say. It hides on a
 * page that does not poll: "No refresh in 27s" on a page that never refreshes
 * was a red alarm about nothing (Groups).
 */
export function freshnessVisible(pollMs: number | undefined): boolean {
  return staleAfterMs(pollMs) !== undefined;
}
