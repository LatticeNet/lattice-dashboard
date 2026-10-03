/**
 * Acknowledge and snooze, shared by Home's incidents and Monitoring's
 * Keepalive layer: one call per row, its id marked busy while it runs, a
 * toast that says what happened, then the caller's list is read again.
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";

import { api, type Incident } from "@/lib/api";
import { toast } from "@/lib/toast";

export function useIncidentActions(refresh: () => unknown) {
  const { t } = useI18n();
  const busy = ref<Set<string>>(new Set());

  async function run(incident: Incident, call: () => Promise<unknown>, done: string, failed: string): Promise<void> {
    if (busy.value.has(incident.id)) return;
    busy.value = new Set([...busy.value, incident.id]);
    try {
      await call();
      toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? `${failed}: ${error.message}` : failed);
      return;
    } finally {
      const next = new Set(busy.value);
      next.delete(incident.id);
      busy.value = next;
    }
    // The action landed; a list read that fails after it is the list's own
    // failure (its proof line says so), not the action's.
    try {
      await refresh();
    } catch {
      /* the caller's read reports it */
    }
  }

  function ack(incident: Incident): Promise<void> {
    return run(incident, () => api.incidents.ack(incident.id), t("fleet.keepalive.toast.acked"), t("fleet.keepalive.toast.ackFailed"));
  }

  function snooze(incident: Incident, minutes: number): Promise<void> {
    const done = minutes === 0 ? t("fleet.keepalive.toast.unsnoozed") : t("fleet.keepalive.toast.snoozed", { label: t(`fleet.keepalive.snooze.m${minutes}`) });
    return run(incident, () => api.incidents.snooze(incident.id, minutes), done, t("fleet.keepalive.toast.snoozeFailed"));
  }

  return { busy, ack, snooze };
}
