/**
 * Acknowledge and snooze, shared by Home's incidents and Monitoring's
 * Incidents layer: one call per row, its id marked busy while it runs, a
 * toast that names the incident and says what happened, then the caller's
 * list is read again.
 *
 * Acknowledging can be undone from the row itself: for ACK_UNDO_MS the row
 * shows "Acknowledged" and an Undo button in Acknowledge's place, and focus
 * moves to that Undo (the server's /api/incidents/unack puts the reminder
 * schedule back as it was). The Undo stays while it has keyboard focus, so
 * it never disappears under the operator; the toast only announces.
 *
 * While that runs, the rows keep the order they had when the action was
 * pressed, and the acted-on row stays listed even under a filter it no
 * longer matches (Acknowledge or Snooze under Open), so the next row's
 * Acknowledge does not slide under a pointer that is still there.
 *
 * Focus follows the action instead of falling to the page: after an
 * acknowledgement to the row's Undo, after a failed one back to Acknowledge,
 * and after Undo to Acknowledge again. IncidentList fulfils `focusRequest`
 * once the row has re-rendered.
 */
import { computed, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";

import { api, ApiError, type Incident } from "@/lib/api";
import { toast } from "@/lib/toast";

/** How long a row offers Undo after Acknowledge, and holds its place after an action. */
export const ACK_UNDO_MS = 10_000;
/** How often an Undo that has focus checks again whether it may go. */
const FOCUS_RECHECK_MS = 500;

export interface IncidentFocusRequest {
  id: string;
  target: "ack" | "snooze" | "undo";
}

/** The element that marks a row's inline Undo, so the Undo stays while it has focus. */
export function undoMarker(id: string): string {
  return `[data-incident-undo="${CSS.escape(id)}"]`;
}

function hasFocus(selector: string): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return !!active && !!active.closest(selector);
}

export function useIncidentActions(refresh: () => unknown, options: { holdMs?: number } = {}) {
  const { t } = useI18n();
  const holdMs = options.holdMs ?? ACK_UNDO_MS;
  const busy = ref<Set<string>>(new Set());
  /** Row ids in the order they had when an action was pressed, while that order is held. */
  const held = ref<string[] | null>(null);
  const focusRequest = ref<IncidentFocusRequest | null>(null);
  /** Acknowledged rows that still offer Undo. */
  const undoable = shallowRef<ReadonlySet<string>>(new Set());
  /** Snoozed rows kept listed for the hold. */
  const snoozePinned = shallowRef<ReadonlySet<string>>(new Set());
  /** Rows that stay listed whatever the filter says: the ones just acted on. */
  const pinned = computed<ReadonlySet<string>>(() => new Set([...undoable.value, ...snoozePinned.value]));
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const undoTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function mark(id: string, on: boolean): void {
    const next = new Set(busy.value);
    if (on) next.add(id);
    else next.delete(id);
    busy.value = next;
  }

  function withId(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
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

  /** Release the held order once its time is up and no row still offers Undo. */
  function releaseHold(): void {
    if (undoable.value.size > 0) {
      holdTimer = setTimeout(releaseHold, FOCUS_RECHECK_MS);
      return;
    }
    held.value = null;
  }

  function hold(order: readonly string[] | undefined): void {
    if (!order?.length) return;
    held.value = [...order];
    clearTimeout(holdTimer);
    holdTimer = setTimeout(releaseHold, holdMs);
  }

  function closeUndo(id: string): void {
    clearTimeout(undoTimers.get(id));
    undoTimers.delete(id);
    undoable.value = withId(undoable.value, id, false);
  }

  /** Undo goes when its time is up, unless it has keyboard focus: then when focus leaves it. */
  function expireUndo(id: string): void {
    if (hasFocus(undoMarker(id))) {
      undoTimers.set(id, setTimeout(() => expireUndo(id), FOCUS_RECHECK_MS));
      return;
    }
    closeUndo(id);
  }

  function openUndo(id: string): void {
    clearTimeout(undoTimers.get(id));
    undoable.value = withId(undoable.value, id, true);
    undoTimers.set(id, setTimeout(() => expireUndo(id), holdMs));
  }

  function pinSnoozed(id: string): void {
    snoozePinned.value = withId(snoozePinned.value, id, true);
    setTimeout(() => {
      snoozePinned.value = withId(snoozePinned.value, id, false);
    }, holdMs);
  }

  /** `name` is the row's claim as shown, so stacked toasts say which incident each is about. */
  async function undoAck(incident: Incident, name: string): Promise<void> {
    if (busy.value.has(incident.id)) return;
    mark(incident.id, true);
    try {
      await api.incidents.unack(incident.id);
      toast.success(t("fleet.keepalive.toast.unacked", { name }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        closeUndo(incident.id);
        toast.error(t("fleet.keepalive.toast.unackClosed", { name }));
      } else {
        toast.error(error instanceof Error && error.message ? `${t("fleet.keepalive.toast.unackFailed")}: ${error.message}` : t("fleet.keepalive.toast.unackFailed"));
      }
      return;
    } finally {
      mark(incident.id, false);
    }
    closeUndo(incident.id);
    await reread();
    focusRequest.value = { id: incident.id, target: "ack" };
  }

  /** `order` is the list's row ids as shown, held while the acknowledgement settles. */
  async function ack(incident: Incident, order: readonly string[] | undefined, name: string): Promise<void> {
    if (busy.value.has(incident.id)) return;
    hold(order);
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
    openUndo(incident.id);
    toast.success(t("fleet.keepalive.toast.acked", { name }));
    focusRequest.value = { id: incident.id, target: "undo" };
    await reread();
  }

  async function snooze(incident: Incident, minutes: number, order: readonly string[] | undefined, name: string): Promise<boolean> {
    if (busy.value.has(incident.id)) return false;
    hold(order);
    pinSnoozed(incident.id);
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

  return { busy, held, pinned, undoable, focusRequest, focusDone, ack, undoAck, snooze };
}
