/**
 * The words Monitoring's path layers share: a state, an unknown reason, a
 * region group, a window. One place, so Overview, Paths, the sheets and the
 * query field say the same thing for the same fact.
 */
import { useI18n } from "vue-i18n";

import type { MonitorWindow, PathState } from "@/lib/api";
import type { RegionKey } from "@/lib/regions";

import { displayState, reasonCode, type PathDisplay } from "./pathsModel";

export function usePathsCopy() {
  const { t } = useI18n();

  /** The reason in words: a known code's sentence, a failure as the agent wrote it, or the code as sent. */
  function reasonText(reason: string | undefined): string {
    if (!reason) return t("fleet.monitoring.paths.reason.unspecified");
    const code = reasonCode(reason);
    return code ? t(`fleet.monitoring.paths.reason.${code}`) : reason;
  }

  /**
   * Why a path is not up, in words: its reason when it has one (unknown
   * paths), and for a down path, which the server sends without one, that
   * its latest runs failed. The failure itself is in the path's runs.
   */
  function whyText(path: { state: PathState; reason?: string }, failure?: string): string {
    if (path.reason) return reasonText(path.reason);
    if (path.state === "down") return failure || t("fleet.monitoring.paths.reason.failing");
    return reasonText(undefined);
  }

  /** The reason in a few words, for a matrix cell; the sentence stays in the tooltip and the sheet. */
  function reasonShort(reason: string | undefined): string {
    const code = reasonCode(reason);
    return code ? t(`fleet.monitoring.paths.reasonShort.${code}`) : reasonText(reason);
  }

  /** A method as the console names it in a sentence: TCP, ICMP, HTTP, TLS, and Beacon as a word rather than a code. */
  function methodName(method: string): string {
    return method === "beacon" ? t("fleet.monitoring.checks.editor.methodName.beacon") : method.toUpperCase();
  }

  /**
   * Why a node cannot run a method, short, for a source row (design 29 D9):
   * "agent too old for ICMP", "ICMP not permitted on this node", or the
   * path's reason for any other code.
   */
  function refusalText(reason: string, method: string): string {
    const code = reasonCode(reason);
    // Every agent runs http; one too old for an http check is too old for its headers or status set.
    if (code === "agent_too_old" && method === "http") return t("fleet.monitoring.paths.refusal.agent_too_old_http");
    if (code === "agent_too_old") return t("fleet.monitoring.paths.refusal.agent_too_old", { method: methodName(method) });
    if (code === "icmp_not_permitted") return t("fleet.monitoring.paths.refusal.icmp_not_permitted");
    return reasonText(reason);
  }

  function stateLabel(state: PathDisplay): string {
    return t(`fleet.monitoring.paths.state.${state}`);
  }

  /** The state as the console words it: a pause reads "paused", not "unknown". */
  function displayLabel(path: { state: PathState; reason?: string }): string {
    return stateLabel(displayState(path));
  }

  function groupLabel(group: RegionKey | "checks"): string {
    return group === "checks" ? t("fleet.monitoring.paths.matrix.checksGroup") : t(`fleet.monitoring.topology.region.${group}`);
  }

  function windowLong(window: MonitorWindow | string): string {
    return t(`fleet.monitoring.window.long.${window}`);
  }

  return { reasonText, reasonShort, refusalText, methodName, whyText, stateLabel, displayLabel, groupLabel, windowLong };
}
