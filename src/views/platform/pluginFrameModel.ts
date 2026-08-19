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
