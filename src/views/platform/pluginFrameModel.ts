// Lifecycle state machine for the sandboxed plugin frame.
//
// Every iframe `load` after the first is a new trust boundary: the document was
// replaced (reload or in-frame navigation) while the WindowProxy stayed the same,
// so the old bridge session must be revoked and a fresh nonce minted before the new
// document can talk to the host.
//
// This lives outside the component because the rule it encodes is a security
// invariant, not a rendering detail. Keeping it pure is what makes it directly
// testable without a DOM harness.

export type FrameLoadOutcome =
  /** First load of this element: arm the handshake timer. */
  | { action: "handshake" }
  /** A later load replaced the document: revoke the bridge and remount under a new nonce. */
  | { action: "rotate"; nonce: string }
  /** The frame is reloading in a loop; stop remounting it. */
  | { action: "exhausted" };

export interface PluginFrameLifecycleOptions {
  createNonce: () => string;
  now?: () => number;
  /** Rotations tolerated inside one window before the frame is left down. */
  maxRotations?: number;
  windowMs?: number;
}

export class PluginFrameLifecycle {
  private readonly createNonce: () => string;
  private readonly now: () => number;
  private readonly maxRotations: number;
  private readonly windowMs: number;

  private currentNonce: string;
  private completedLoad = false;
  private rotationCount = 0;
  private windowStart = 0;

  constructor(options: PluginFrameLifecycleOptions) {
    this.createNonce = options.createNonce;
    this.now = options.now ?? (() => Date.now());
    this.maxRotations = options.maxRotations ?? 5;
    this.windowMs = options.windowMs ?? 10_000;
    this.currentNonce = this.createNonce();
  }

  get nonce(): string {
    return this.currentNonce;
  }

  /**
   * Record an iframe `load`. The first load for a given element is the normal boot;
   * any later load means the document was swapped underneath us.
   */
  noteLoad(): FrameLoadOutcome {
    if (!this.completedLoad) {
      this.completedLoad = true;
      return { action: "handshake" };
    }
    if (!this.consumeRotationBudget()) {
      return { action: "exhausted" };
    }
    // The remounted element boots fresh, so the next load is that element's first.
    this.completedLoad = false;
    this.currentNonce = this.createNonce();
    return { action: "rotate", nonce: this.currentNonce };
  }

  /**
   * Operator-driven retry. Mints a fresh nonce and treats the next load as a
   * first load, without refunding the rotation budget: a deliberate retry is
   * not a reason to trust a frame that was reloading itself in a loop.
   */
  reset(): string {
    this.completedLoad = false;
    this.currentNonce = this.createNonce();
    return this.currentNonce;
  }

  private consumeRotationBudget(): boolean {
    const now = this.now();
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.rotationCount = 0;
    }
    this.rotationCount += 1;
    return this.rotationCount <= this.maxRotations;
  }
}


/**
 * What the host should be showing while a plugin frame boots.
 *
 * The frame is a black box that takes seconds to become useful: the browser has
 * to fetch the plugin's document, then the plugin has to complete the bridge
 * handshake before it renders anything of its own. Until this existed the host
 * drew a single small spinner over that whole area, which on a large display
 * reads as a finished, empty page rather than a loading one, and if the
 * handshake never landed it read as a finished, empty page forever.
 *
 * Deriving the phase here rather than from four booleans scattered through the
 * template keeps the impossible combinations out of the UI and makes each one
 * checkable without a browser.
 */
export type PluginFramePhase =
  /** The element exists; its document has not finished loading. */
  | "booting"
  /** The document loaded; the plugin has not answered the handshake yet. */
  | "handshaking"
  /** The plugin answered. Its own UI is on screen. */
  | "ready"
  /** The document loaded but never answered. Distinct from never loading. */
  | "unresponsive"
  /** The frame could not be loaded, or reloaded itself until the budget ran out. */
  | "unavailable";

export interface PluginFramePhaseInput {
  documentLoaded: boolean;
  handshakeComplete: boolean;
  /** The handshake timer elapsed with no answer. */
  handshakeExpired: boolean;
  /** The rotation budget is spent; the element is deliberately not remounted. */
  frameDown: boolean;
  /** The iframe raised `error`, or there was no resolvable source to load. */
  loadError: boolean;
}

export function pluginFramePhase(input: PluginFramePhaseInput): PluginFramePhase {
  // A frame that cannot load outranks everything: there is nothing to wait for.
  if (input.loadError || input.frameDown) return "unavailable";
  if (input.handshakeComplete) return "ready";
  if (input.handshakeExpired) return "unresponsive";
  return input.documentLoaded ? "handshaking" : "booting";
}

/** Whether the host should still be covering the frame with its own state. */
export function pluginFrameIsBusy(phase: PluginFramePhase): boolean {
  return phase === "booting" || phase === "handshaking";
}

/** Whether the operator should be offered a retry for this phase. */
export function pluginFrameIsRetryable(phase: PluginFramePhase): boolean {
  return phase === "unresponsive" || phase === "unavailable";
}
