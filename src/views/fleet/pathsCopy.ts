/**
 * The words Monitoring's path layers share: a state, an unknown reason, a
 * region group, a window. One place, so Overview, Paths, the sheets and the
 * query field say the same thing for the same fact.
 */
import { useI18n } from "vue-i18n";

import type { MonitorWindow, PathState } from "@/lib/api";
import type { RegionKey } from "@/lib/regions";

import { reasonCode } from "./pathsModel";

export function usePathsCopy() {
  const { t } = useI18n();

  /** The reason in words: a known code's sentence, a failure as the agent wrote it, or the code as sent. */
  function reasonText(reason: string | undefined): string {
    if (!reason) return t("fleet.monitoring.paths.reason.unspecified");
    const code = reasonCode(reason);
    return code ? t(`fleet.monitoring.paths.reason.${code}`) : reason;
  }

  function stateLabel(state: PathState): string {
    return t(`fleet.monitoring.paths.state.${state}`);
  }

  function groupLabel(group: RegionKey | "checks"): string {
    return group === "checks" ? t("fleet.monitoring.paths.matrix.checksGroup") : t(`fleet.monitoring.topology.region.${group}`);
  }

  function windowLong(window: MonitorWindow | string): string {
    return t(`fleet.monitoring.window.long.${window}`);
  }

  return { reasonText, stateLabel, groupLabel, windowLong };
}
