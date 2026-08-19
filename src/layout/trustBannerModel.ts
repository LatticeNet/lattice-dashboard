// trustBannerModel. Decides whether the console must announce that this server
// trusts a publisher other than `latticenet` (TASK-0012, operator-ratified
// TASK-0011 Decision 3).
//
// There is no "dev mode" to detect: production refusal is structural, not a
// switch. The honest condition is what the trust policy actually holds. A
// non-official publisher, or `allow_unsigned_host_risk`, which should never be
// true anywhere and must not be silent if it is.
//
// Self-contained and pure, like the other models under test here: both
// directions are checkable without a server. The banner appearing when it must,
// and staying absent when only `latticenet` is trusted.

/** The official publisher. Anything else trusted is what the banner is for. */
export const OFFICIAL_PUBLISHER = "latticenet";

/** Wire shape of GET /api/plugin-trust (see PluginTrustView in lib/api). */
export interface TrustSnapshot {
  non_official?: boolean;
  publishers?: string[];
  allow_unsigned_host_risk?: boolean;
}

export interface TrustBannerState {
  /** True when the console must display the marker. */
  visible: boolean;
  /** Non-official publisher names, deduped and sorted. Never key material. */
  publishers: string[];
  /** Signature enforcement for host-risk plugins is switched off. */
  unsignedHostRisk: boolean;
}

const HIDDEN: TrustBannerState = { visible: false, publishers: [], unsignedHostRisk: false };

/**
 * Absent input renders nothing: a server predating the endpoint cannot be
 * described, and inventing a warning for it would train operators to ignore the
 * banner. Fail-closed belongs on the server, which emits the object always,
 * `non_official: false` in the normal case rather than omitting it.
 */
export function trustBannerState(view: TrustSnapshot | null | undefined): TrustBannerState {
  if (!view || typeof view !== "object") return HIDDEN;

  const raw: unknown[] = Array.isArray(view.publishers) ? view.publishers : [];
  const publishers = Array.from(
    new Set(
      raw
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && name !== OFFICIAL_PUBLISHER),
    ),
  ).sort();

  const unsignedHostRisk = view.allow_unsigned_host_risk === true;

  // The list outranks the flag. If the server reports a non-official publisher
  // while `non_official` is false, that disagreement is itself a reason to warn:
  // silence would depend on the less specific of two fields being right.
  const visible = view.non_official === true || publishers.length > 0 || unsignedHostRisk;

  return visible ? { visible, publishers, unsignedHostRisk } : HIDDEN;
}
