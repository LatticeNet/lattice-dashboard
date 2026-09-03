/**
 * The host's side of the plugin clipboard privilege: the DOM work of actually
 * putting text on the operator's clipboard on a frame's behalf.
 *
 * Separate from PluginFrameHost.vue so the copy can be exercised directly (by
 * a test, or by the frame harness) rather than only through a mounted view,
 * and separate from pluginBridgeModel.ts so the protocol half stays pure. The
 * session decides whether a frame may copy; this decides how.
 *
 * Why the host does this at all rather than the frame: see the long note on
 * CLIPBOARD_ERROR_CODES in pluginBridgeModel.ts.
 */

/**
 * How long to wait for the browser before calling the copy failed.
 *
 * There is a real hang to guard here, not a theoretical one: an async clipboard
 * write attempted without transient activation, or against a document that does
 * not have focus, can leave its promise pending instead of rejecting. Without
 * this the plugin would sit forever on a copy that is never going to land, and
 * the operator would never be offered the manual fallback.
 */
export const CLIPBOARD_TIMEOUT_MS = 3_000;

/**
 * The fallback path. A readonly off-screen textarea is selected and copied,
 * then removed, and the operator's own selection is put back: copying for a
 * plugin must not silently destroy whatever the operator had highlighted.
 *
 * Kept out of the layout with `position: fixed` and a zero opacity rather than
 * `display: none`, which would make it unselectable and the copy a no-op.
 * `execCommand` is deprecated, not removed, and it is the only path that still
 * works once the async API's activation has gone stale.
 */
export function copyBySelection(text: string, doc: Document = document): boolean {
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  const selection = doc.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  doc.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    // Deprecated, and deliberately used: it is the only copy that still works
    // once the async API's transient activation has gone stale, which is the
    // exact case this fallback exists for.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

/**
 * Put text on the operator's clipboard, and say honestly whether it landed.
 * Never throws: false is a real outcome the plugin renders a selectable value
 * for, not an error for a caller to handle.
 */
export async function copyForFrame(text: string, timeoutMs = CLIPBOARD_TIMEOUT_MS): Promise<boolean> {
  const deadline = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  const attempt = (async () => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return copyBySelection(text);
    }
  })();
  return Promise.race([attempt, deadline]);
}
