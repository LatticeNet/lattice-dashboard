/**
 * Acknowledge and snooze, shared by Home's incidents and Monitoring's
 * Incidents layer: one call per row, its id marked busy while it runs, a
 * toast that names the incident and says what happened, then the caller's
 * list is read again.
 *
 * Acknowledging can be undone from the row itself: the row shows Undo in
 * Acknowledge's place, and focus moves to that Undo (the server's
 * /api/incidents/unack puts the reminder schedule back as it was). The toast
 * only announces.
 *
 * While that runs, the rows keep the order they had when the action was
 * pressed, and the acted-on row stays listed even under a filter it no
 * longer matches (Acknowledge or Snooze under Open), so the next row's
 * Acknowledge does not slide under a pointer that is still there. The rows
 * acted on are released together (lib/actionHold), at least ACK_UNDO_MS
 * after the last action, and not while the pointer is over the list, a
 * touch has not scrolled since, or an Undo has keyboard focus. Spread
 * `listEvents` on the element around the list so the hold can see the
 * pointer, and call `release()` when the caller's filters change.
 *
 * Focus follows the action instead of falling to the page: after an
 * acknowledgement to the row's Undo, after a failed one back to Acknowledge,
 * and after Undo to Acknowledge again. IncidentList fulfils `focusRequest`
 * once the row has re-rendered.
 */
import { onScopeDispose, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";

import { api, ApiError, type Incident } from "@/lib/api";
import { createActionHold } from "@/lib/actionHold";
import { toast } from "@/lib/toast";

/** How long a row offers Undo after Acknowledge, and holds its place after an action, at least. */
export const ACK_UNDO_MS = 10_000;

export interface IncidentFocusRequest {
  id: string;
  target: "ack" | "snooze" | "undo";
}

/**
 * Only keyboard focus keeps an Undo: a pointer press also focuses it, and an
 * Undo held by that would never go and would freeze the list's order.
 */
function keyboardOnUndo(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof HTMLElement && active.hasAttribute("data-incident-undo") && active.matches(":focus-visible");
}

export function useIncidentActions(refresh: () => unknown, options: { holdMs?: number } = {}) {
  const { t } = useI18n();
  const busy = ref<Set<string>>(new Set());
  const focusRequest = ref<IncidentFocusRequest | null>(null);
  /** Row ids in the order they had when an action was pressed, while that order is held. */
  const held = shallowRef<readonly string[] | null>(null);
  /** Acknowledged rows that offer Undo, and those whose Undo landed (undoSlot). */
  const undoable = shallowRef<ReadonlySet<string>>(new Set());
  const undone = shallowRef<ReadonlySet<string>>(new Set());
  /** Rows that stay listed whatever the filter says: the ones just acted on. */
  const pinned = shallowRef<ReadonlySet<string>>(new Set());

  // The pointer over the list. A mouse or pen says when it leaves; a finger
  // does not hover, so after a tap the rows stay until the next scroll.
  let pointerOver = false;
  let touched = false;

  const hold = createActionHold({
    holdMs: options.holdMs ?? ACK_UNDO_MS,
    blocked: () => pointerOver || touched || keyboardOnUndo(),
    changed: () => {
      const state = hold.state();
      held.value = state.order;
      undoable.value = state.undoable;
      undone.value = state.undone;
      pinned.value = state.pinned;
    },
  });

  function onScroll(): void {
    if (!touched) return;
    touched = false;
    hold.check();
  }
  if (typeof window !== "undefined") window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  onScopeDispose(() => {
    if (typeof window !== "undefined") window.removeEventListener("scroll", onScroll, { capture: true });
    hold.dispose();
  });

  const listEvents = {
    pointerenter(event: PointerEvent): void {
      if (event.pointerType === "touch") return;
      pointerOver = true;
      touched = false;
    },
    pointerleave(event: PointerEvent): void {
      if (event.pointerType === "touch") return;
      pointerOver = false;
      hold.check();
    },
    pointerdown(event: PointerEvent): void {
      if (event.pointerType === "touch") {
        touched = true;
      } else {
        pointerOver = true;
        touched = false;
      }
    },
    focusout(): void {
      // activeElement settles after focusout; an Undo losing keyboard focus may free the group.
      setTimeout(() => hold.check(), 0);
    },
  };

  function mark(id: string, on: boolean): void {
    const next = new Set(busy.value);
    if (on) next.add(id);
    else next.delete(id);
    busy.value = next;
  }

  async function reread(): Promise<void> {
    // The action landed; a list read that fails after it is the list's own
    // failure (its proof line says so), not the action's.
    try {
      await refresh();
    } catch {
      /* the caller's read reports it */
    }
  }

  /**
   * `name` is the row's claim as shown, so stacked toasts say which incident
   * each is about. The row keeps its pin and an inert Undo until the list
   * shows it open again (undoSlot): unpinned before that, it would drop out
   * of Open and put the next row's Acknowledge under the pointer.
   */
  async function undoAck(incident: Incident, name: string): Promise<void> {
    if (busy.value.has(incident.id) || undone.value.has(incident.id)) return;
    hold.begin();
    mark(incident.id, true);
    try {
      await api.incidents.unack(incident.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        hold.closeUndo(incident.id);
        toast.error(t("fleet.keepalive.toast.unackClosed", { name }));
      } else {
        toast.error(error instanceof Error && error.message ? `${t("fleet.keepalive.toast.unackFailed")}: ${error.message}` : t("fleet.keepalive.toast.unackFailed"));
      }
      return;
    } finally {
      mark(incident.id, false);
    }
    hold.undone(incident.id);
    toast.success(t("fleet.keepalive.toast.unacked", { name }));
    focusRequest.value = { id: incident.id, target: "ack" };
    await reread();
  }

  /** `order` is the list's row ids as shown, held while the acknowledgement settles. */
  async function ack(incident: Incident, order: readonly string[] | undefined, name: string): Promise<void> {
    if (busy.value.has(incident.id)) return;
    hold.begin(order);
    mark(incident.id, true);
    try {
      await api.incidents.ack(incident.id);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? `${t("fleet.keepalive.toast.ackFailed")}: ${error.message}` : t("fleet.keepalive.toast.ackFailed"));
      focusRequest.value = { id: incident.id, target: "ack" };
      return;
    } finally {
      mark(incident.id, false);
    }
    hold.acked(incident.id);
    toast.success(t("fleet.keepalive.toast.acked", { name }));
    focusRequest.value = { id: incident.id, target: "undo" };
    await reread();
  }

  async function snooze(incident: Incident, minutes: number, order: readonly string[] | undefined, name: string): Promise<boolean> {
    if (busy.value.has(incident.id)) return false;
    hold.begin(order);
    hold.snoozed(incident.id);
    mark(incident.id, true);
    try {
      await api.incidents.snooze(incident.id, minutes);
      toast.success(minutes === 0 ? t("fleet.keepalive.toast.unsnoozed", { name }) : t("fleet.keepalive.toast.snoozed", { name, label: t(`fleet.keepalive.snooze.m${minutes}`) }));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? `${t("fleet.keepalive.toast.snoozeFailed")}: ${error.message}` : t("fleet.keepalive.toast.snoozeFailed"));
      return false;
    } finally {
      mark(incident.id, false);
    }
    await reread();
    return true;
  }

  function focusDone(): void {
    focusRequest.value = null;
  }

  return { busy, held, pinned, undoable, undone, focusRequest, focusDone, ack, undoAck, snooze, listEvents, release: () => hold.release() };
}
