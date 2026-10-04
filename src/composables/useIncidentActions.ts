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
 * after the last action, and not while a mouse or pen is over `zone` (the
 * caller's whole surface: Monitoring's Incidents layer holds its banner and
 * its list as one), a touch has not scrolled since, a row's menu is open, or
 * an Undo has keyboard focus. `keep()` adds anything else an action leaves
 * on screen to the same group (End now's ended line). Call `release()` when
 * the caller's filters change, or when the operator asks for the rows the
 * hold keeps below their place (`heldRows` feeds incidentsModel.arrivals,
 * which finds them; the caller says they are there and offers Show).
 *
 * Focus follows the action instead of falling to the page: after an
 * acknowledgement to the row's Undo, after a failed one back to Acknowledge,
 * and after Undo to Acknowledge again. IncidentList fulfils `focusRequest`
 * once the row has re-rendered.
 */
import { onScopeDispose, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";

import { api, ApiError, type Incident } from "@/lib/api";
import { createActionHold, createPointerWatch } from "@/lib/actionHold";
import { toast } from "@/lib/toast";

/** How long a row offers Undo after Acknowledge, and holds its place after an action, at least. */
export const ACK_UNDO_MS = 10_000;

export interface IncidentFocusRequest {
  id: string;
  target: "ack" | "snooze" | "undo";
}

/**
 * Only keyboard focus keeps an Undo (a row's, or an ended window's): a
 * pointer press also focuses it, and an Undo held by that would never go and
 * would freeze the list's order.
 */
function keyboardOnUndo(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches("[data-incident-undo], [data-window-undo]") && active.matches(":focus-visible");
}

export function useIncidentActions(
  refresh: () => unknown,
  options: {
    holdMs?: number;
    zone?: () => HTMLElement | null | undefined;
    /** The caller's incidents, read when a hold begins (`heldRows`). */
    rows?: () => readonly Incident[];
  } = {},
) {
  const { t } = useI18n();
  const busy = ref<Set<string>>(new Set());
  const focusRequest = ref<IncidentFocusRequest | null>(null);
  /** Row ids in the order they had when an action was pressed, while that order is held. */
  const held = shallowRef<readonly string[] | null>(null);
  /** Acknowledged rows that offer Undo, and those whose Undo landed (undoSlot). */
  const undoable = shallowRef<ReadonlySet<string>>(new Set());
  const undone = shallowRef<ReadonlySet<string>>(new Set());
  const settling = shallowRef<ReadonlySet<string>>(new Set());
  /** Rows that stay listed whatever the filter says: the ones just acted on. */
  const pinned = shallowRef<ReadonlySet<string>>(new Set());
  /** Other things kept on screen with the rows (keep()). */
  const kept = shallowRef<ReadonlySet<string>>(new Set());
  /** Each incident as it was when the hold began: one that sorts higher now, or is new, has arrived. */
  const heldRows = shallowRef<ReadonlyMap<string, Incident> | null>(null);

  const pointer = createPointerWatch();

  /** A row's menu (Snooze) is open: the pointer is on it, over or beside the rows. */
  function menuOpen(): boolean {
    return Boolean(options.zone?.()?.querySelector('[aria-haspopup="menu"][aria-expanded="true"]'));
  }

  const hold = createActionHold({
    holdMs: options.holdMs ?? ACK_UNDO_MS,
    blocked: () => pointer.holds(options.zone?.()?.getBoundingClientRect() ?? null) || menuOpen() || keyboardOnUndo(),
    changed: () => {
      const state = hold.state();
      if (!state.order) heldRows.value = null;
      else if (!held.value && options.rows) heldRows.value = new Map(options.rows().map((incident) => [incident.id, incident]));
      held.value = state.order;
      undoable.value = state.undoable;
      undone.value = state.undone;
      settling.value = state.settling;
      pinned.value = state.pinned;
      kept.value = state.kept;
    },
  });

  // Listened to on the window, not the zone: the zone's own boundary events
  // lie while a modal menu takes pointer events off the page (PointerWatch).
  function onPointer(event: PointerEvent): void {
    pointer.pointer(event.pointerType, event.clientX, event.clientY, event.type === "pointerdown");
    // Once the group's time is up, the move that takes the pointer off the zone frees it.
    if (hold.due()) hold.check();
  }
  function onPointerOut(event: PointerEvent): void {
    if (event.pointerType === "touch" || event.relatedTarget) return;
    pointer.left();
    hold.check();
  }
  function onScroll(): void {
    if (pointer.scrolled()) hold.check();
  }
  function onFocusOut(): void {
    // activeElement settles after focusout; an Undo losing keyboard focus may free the group.
    setTimeout(() => hold.check(), 0);
  }
  const listeners: [string, (event: never) => void, AddEventListenerOptions][] = [
    ["pointermove", onPointer, { capture: true, passive: true }],
    ["pointerdown", onPointer, { capture: true, passive: true }],
    ["pointerout", onPointerOut, { capture: true, passive: true }],
    ["scroll", onScroll, { capture: true, passive: true }],
    ["focusout", onFocusOut, { capture: true }],
  ];
  if (typeof window !== "undefined") for (const [type, fn, opts] of listeners) window.addEventListener(type, fn as EventListener, opts);
  onScopeDispose(() => {
    if (typeof window !== "undefined") for (const [type, fn, opts] of listeners) window.removeEventListener(type, fn as EventListener, opts);
    hold.dispose();
  });

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
    const pressedAt = Date.now();
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
    hold.undone(incident.id, pressedAt);
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

  return {
    busy,
    held,
    pinned,
    undoable,
    undone,
    settling,
    kept,
    heldRows,
    focusRequest,
    focusDone,
    ack,
    undoAck,
    snooze,
    /** Keep `key` on screen with the rows until the group goes. */
    keep: (key: string) => hold.keep(key),
    release: () => hold.release(),
    /** Put the rows in their place, keeping kept lines (Show on the arrivals notice). */
    releaseRows: () => hold.releaseRows(),
  };
}
