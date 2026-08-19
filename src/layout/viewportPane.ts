/**
 * Who is asking the main region to behave as a viewport instead of a document.
 *
 * Most console routes are documents: the view is as tall as its content and
 * `<main>` scrolls it. A sandboxed plugin frame is the opposite. The frame holds
 * its own document, and if the host also grows with that document the operator
 * gets two nested scrollbars, the inner one unreachable without first scrolling
 * the outer one. So a plugin route asks `<main>` to stop scrolling and to become
 * the positioning context for a pane that fills it exactly; the plugin scrolls
 * inside that pane, and the shell chrome above it never moves.
 *
 * A counter, not a boolean. During a route change Vue mounts the incoming view
 * before unmounting the outgoing one, so plugin route to plugin route runs
 * claim, claim, release. A boolean would be cleared by the view that is leaving
 * and the pane would collapse back to a document on a route that still wants it.
 */
import { computed, ref, type ComputedRef } from "vue";

const claims = ref(0);

/** True while at least one mounted view needs the viewport pane. */
export const viewportPaneClaimed: ComputedRef<boolean> = computed(() => claims.value > 0);

/**
 * Claim the pane for the caller's lifetime. Call the returned function once, on
 * unmount. Releasing twice is a no-op rather than an underflow, so a component
 * that both releases explicitly and releases on teardown cannot free a claim
 * another view is still holding.
 */
export function claimViewportPane(): () => void {
  claims.value += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims.value = Math.max(0, claims.value - 1);
  };
}

/** Test seam: drop every claim. Not used by application code. */
export function resetViewportPaneClaims(): void {
  claims.value = 0;
}
