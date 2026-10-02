import { ref } from "vue";
import { useI18n } from "vue-i18n";

import { api, type MachineView } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useStepUp } from "@/composables/useStepUp";

export type MachineLinkKind = "console" | "detail";

/**
 * Open a machine's stored provider link. The server keeps console and detail
 * URLs sealed and reveals one per step-up grant, so the reveal and its
 * step-up prompt travel together; MachineLinkStepUpDialog renders the prompt.
 *
 * Inventory's sheet and row menu use it, and so does the record-renewal
 * dialog on Inventory and Upcoming, so paying the provider and recording the
 * renewal sit side by side. One instance per page keeps one grant, so a
 * second link inside the grant's lifetime asks for nothing.
 */
export function useMachineLinkReveal() {
  const { t } = useI18n();
  const stepUp = useStepUp({
    required: t("fleet.inventory.stepUp.required"),
    failed: t("fleet.inventory.stepUp.failed"),
    passkeyFailed: t("fleet.inventory.stepUp.passkeyFailed"),
  });
  /** The machine and link being revealed, as pendingKey() spells it, or "". */
  const pending = ref("");

  function pendingKey(machine: MachineView, kind: MachineLinkKind): string {
    return `${machine.id || machine.node_id}:${kind}`;
  }

  async function reveal(machine: MachineView, kind: MachineLinkKind): Promise<void> {
    if (!machine.id || pending.value) return;
    pending.value = pendingKey(machine, kind);
    try {
      const grant = await stepUp.request();
      const revealed = await api.machines.revealLink(machine.id, kind, grant);
      window.open(revealed.url, "_blank", "noopener,noreferrer");
      toast.success(t("fleet.inventory.toast.linkOpened"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("fleet.inventory.toast.linkRevealFailed"));
    } finally {
      pending.value = "";
    }
  }

  return { stepUp, pending, pendingKey, reveal };
}
