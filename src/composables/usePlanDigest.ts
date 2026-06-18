import { ref, type Ref } from "vue";
import { sha256Hex } from "@/lib/crypto";

/**
 * usePlanDigest — DRY home for the SECURITY-CRITICAL client-side plan binding
 * used across the safety-critical mutation views (Approvals, Guard, DNS, Policy,
 * Tunnels, WireGuard, GeoRouting, Profiles, AgentUpdates).
 *
 * The mutation flow is `plan -> approve -> apply` with a client-computed SHA-256
 * digest binding the approval to the exact plan bytes the operator saw. This
 * composable centralizes that hashing WITHOUT changing which bytes are hashed.
 *
 * ── EXACT BYTES HASHED (preserved verbatim from prior per-view logic) ─────────
 * Every call site computed the digest as:
 *
 *     sha256Hex(approval.plan || "")
 *
 * i.e. the UTF-8 encoding (via `new TextEncoder().encode`, see `@/lib/crypto`)
 * of the approval's `plan` STRING field, with an empty-string fallback when that
 * field is falsy (undefined / null / ""). `sha256Hex` lowercases hex, 2-char
 * zero-padded per byte. NOTHING else is serialized — no JSON.stringify, no key
 * sorting, no trimming, no normalization. Do NOT add any.
 *
 * ── digestFor vs digestHex ───────────────────────────────────────────────────
 * - `digestFor(plan)` reproduces the dominant pattern (8/9 views): hash the
 *   object's `.plan` field with the `|| ""` fallback, memoized by `.id`.
 * - `digestHex(input)` is the lower-level path: it hashes a raw string with the
 *   identical `|| ""` fallback and is what `digestFor` delegates to. One view
 *   (GeoRouting) binds a differently-named field (`result.config`) rather than
 *   `.plan`; that site can call `digestHex(result.config)` to run the exact same
 *   pipeline (and therefore the exact same bytes) without being forced into the
 *   `.plan` shape. This changes NOTHING about what is hashed.
 *
 * ── Cache semantics (identical to ApprovalsView's `digestCache`) ──────────────
 * Per-key memo keyed by the approval's `id`. A present (truthy) cached value
 * short-circuits — a SHA-256 hex string is never empty, so the truthiness check
 * can never mistake a real digest for a miss. The cache ref is reassigned with a
 * fresh object on write (`{ ...cache.value, [id]: digest }`) so it stays
 * reactive for templates that read `cache[id]` directly, matching the original.
 */

/**
 * Minimal structural shape this composable binds against. Compatible with
 * `ApprovalView` (whose `plan` is a non-optional `string`) as well as the
 * various `result`-shaped plan responses used across views. `plan` is widened to
 * `string | null | undefined` only to preserve the historical `|| ""` fallback;
 * it does not change which bytes are hashed.
 */
export interface PlanLike {
  id: string;
  plan?: string | null;
}

export interface UsePlanDigest {
  /**
   * Compute (and memoize by `plan.id`) the SHA-256 hex digest of `plan.plan`,
   * with an empty-string fallback. Byte-for-byte identical to the prior
   * `sha256Hex(approval.plan || "")` call sites.
   */
  digestFor: (plan: PlanLike) => Promise<string>;
  /**
   * Compute the SHA-256 hex digest of a raw plan string, with the same
   * empty-string fallback as `digestFor`. Not memoized. Use for plan bindings
   * whose payload field is not named `plan` (e.g. GeoRouting's `config`).
   */
  digestHex: (input?: string | null) => Promise<string>;
  /** Per-key memo cache: `{ [id]: hexDigest }`. Reactive; safe to read in templates. */
  cache: Ref<Record<string, string>>;
}

export function usePlanDigest(): UsePlanDigest {
  const cache = ref<Record<string, string>>({});

  async function digestHex(input?: string | null): Promise<string> {
    return sha256Hex(input || "");
  }

  async function digestFor(plan: PlanLike): Promise<string> {
    const cached = cache.value[plan.id];
    if (cached) return cached;
    const digest = await digestHex(plan.plan);
    cache.value = { ...cache.value, [plan.id]: digest };
    return digest;
  }

  return { digestFor, digestHex, cache };
}
