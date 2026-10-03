/**
 * Acknowledge and snooze, shared by Home's incidents and Monitoring's
 * Keepalive layer: one call per row, its id marked busy while it runs, a
 * toast that says what happened, then the caller's list is read again.
 *
 * Acknowledging can be undone for ACK_UNDO_MS from its toast (the server's
 * /api/incidents/unack puts the reminder schedule back as it was). While
 * that runs, the rows keep the order they had when Acknowledge was pressed
 * until the list's next scheduled read, so the row below does not slide its
 * own Acknowledge under a pointer that is still there.
 *
 * Focus follows the action instead of falling to the page: after an
 * acknowledgement to that row's Snooze (its Acknowledge is gone), after a
 * failed one back to Acknowledge, and after Undo to the row's Acknowledge
 * again. IncidentList fulfils `focusRequest` once the row has re-rendered.
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";

import { api, ApiError, type Incident } from "@/lib/api";
import { toast } from "@/lib/toast";

/** How long an acknowledgement's toast offers Undo. */
export const ACK_UNDO_MS = 10_000;

export interface IncidentFocusRequest {
  id: string;
  target: "ack" | "snooze";
}

export function useIncidentActions(refresh: () => unknown, options: { holdMs?: number } = {}) {
  const { t } = useI18n();
  const busy = ref<Set<string>>(new Set());
  /** Row ids in the order they had when Acknowledge was pressed, while that order is held. */
  const held = ref<string[] | null>(null);
  const focusRequest = ref<IncidentFocusRequest | null>(null);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;

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

  function hold(order: readonly string[] | undefined): void {
    if (!order?.length) return;
    held.value = [...order];
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      held.value = null;
    }, options.holdMs ?? 10_000);
  }

  async function run(incident: Incident, call: () => Promise<unknown>, done: string, failed: string): Promise<boolean> {
    if (busy.value.has(incident.id)) return false;
    mark(incident.id, true);
    try {
      await call();
      toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? `${failed}: ${error.message}` : failed);
      return false;
    } finally {
      mark(incident.id, false);
    }
    await reread();
    return true;
  }

  async function undoAck(incident: Incident): Promise<void> {
    if (busy.value.has(incident.id)) return;
    mark(incident.id, true);
    try {
      await api.incidents.unack(incident.id);
      toast.success(t("fleet.keepalive.toast.unacked"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) toast.error(t("fleet.keepalive.toast.unackClosed"));
      else toast.error(error instanceof Error && error.message ? `${t("fleet.keepalive.toast.unackFailed")}: ${error.message}` : t("fleet.keepalive.toast.unackFailed"));
      return;
    } finally {
      mark(incident.id, false);
    }
    await reread();
    focusRequest.value = { id: incident.id, target: "ack" };
  }

  /** `order` is the list's row ids as shown, held while the acknowledgement settles. */
  async function ack(incident: Incident, order?: readonly string[]): Promise<void> {
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
    toast.success(t("fleet.keepalive.toast.acked"), {
      duration: ACK_UNDO_MS,
      action: { label: t("fleet.keepalive.toast.undo"), onClick: () => void undoAck(incident) },
    });
    await reread();
    focusRequest.value = { id: incident.id, target: "snooze" };
  }

  function snooze(incident: Incident, minutes: number): Promise<boolean> {
    const done = minutes === 0 ? t("fleet.keepalive.toast.unsnoozed") : t("fleet.keepalive.toast.snoozed", { label: t(`fleet.keepalive.snooze.m${minutes}`) });
    return run(incident, () => api.incidents.snooze(incident.id, minutes), done, t("fleet.keepalive.toast.snoozeFailed"));
  }

  function focusDone(): void {
    focusRequest.value = null;
  }

  return { busy, held, focusRequest, focusDone, ack, undoAck, snooze };
}
