/**
 * The words Monitoring's path layers share: a state, an unknown reason, a
 * region group, a window. One place, so Overview, Paths, the sheets and the
 * query field say the same thing for the same fact.
 */
import { useI18n } from "vue-i18n";

import type { MonitorWindow, PathState } from "@/lib/api";
import type { RegionKey } from "@/lib/regions";

import { formatMs } from "./latencyModel";
import { DEGRADED_LEAVE_AFTER_MS, displayState, formatShare, reasonCode, type PathDegradationItem, type PathDisplay } from "./pathsModel";
import type { Verdict } from "./triangulationModel";

export function usePathsCopy() {
  const { t, locale } = useI18n();

  /** A time in the evidence: the clock alone today ("14:02"), the day and the clock before ("Oct 15 14:02"). */
  function clock(ms: number): string {
    const d = new Date(ms);
    const today = new Date().toDateString() === d.toDateString();
    const options: Intl.DateTimeFormatOptions = today ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
    return new Intl.DateTimeFormat(locale.value, options).format(d);
  }

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

  /**
   * A degraded path's evidence, one sentence per arm that held (design 29
   * D13): "Loss 4.2% over the last hour (12 of 290 probes), above its trigger
   * of 2% (7-day loss 0.4%)."
   */
  function evidenceSentences(d: PathDegradationItem | undefined): string[] {
    if (!d) return [];
    const out: string[] = [];
    if (d.loss) out.push(t("fleet.monitoring.paths.evidence.loss", { loss: formatShare(d.loss.value), lost: d.loss.lost, sent: d.loss.sent, trigger: formatShare(d.loss.trigger), baseline: formatShare(d.loss.baseline) }));
    if (d.latency) out.push(t("fleet.monitoring.paths.evidence.latency", { p50: formatMs(d.latency.p50Ms), runs: d.latency.runs, trigger: formatMs(d.latency.triggerMs), baseline: formatMs(d.latency.baselineMs) }));
    return out;
  }

  /** Since when, and while clearing when it leaves: "Degraded since Oct 16 14:02." */
  function degradedTimes(d: PathDegradationItem | undefined): string[] {
    if (!d) return [];
    const out: string[] = [];
    if (d.since !== undefined) out.push(t("fleet.monitoring.paths.evidence.since", { time: clock(d.since) }));
    if (d.clearingSince !== undefined) out.push(t("fleet.monitoring.paths.evidence.clearing", { time: clock(d.clearingSince), leaves: clock(d.clearingSince + DEGRADED_LEAVE_AFTER_MS) }));
    return out;
  }

  /** The evidence and the times, as one paragraph: the cell's hover text and the attention item's proof. */
  function evidenceText(d: PathDegradationItem | undefined, reason?: string): string {
    const parts = [...evidenceSentences(d), ...degradedTimes(d)];
    return parts.length ? parts.join(" ") : reasonText(reason);
  }

  /**
   * The verdict's label: "Likely cause: this source's network". A path only
   * one source reports on names no cause ("Cause not placed"), since the
   * evidence beside it says the cause cannot be placed.
   */
  function verdictLabel(v: Verdict): string {
    if (v.evidence.kind === "alone") return t("fleet.monitoring.paths.verdict.label.alone");
    if (v.kind === "source") return t("fleet.monitoring.paths.verdict.label.source", { source: v.evidence.kind === "source" ? v.evidence.source : "" });
    return t(`fleet.monitoring.paths.verdict.label.${v.kind}`);
  }

  /** What the verdict rests on, in a sentence, worded for its family (reach: down; quality: down or degraded). */
  function verdictEvidence(v: Verdict): string {
    const e = v.evidence;
    switch (e.kind) {
      case "target":
        // Rule 1 needs two sources at least: two read "both", more read "all N".
        if (e.sources.length === 2) return t(`fleet.monitoring.paths.verdict.targetBoth.${v.family}`, { sources: e.sources.join(", ") });
        return t(`fleet.monitoring.paths.verdict.target.${v.family}`, { n: e.sources.length, sources: e.sources.join(", ") });
      case "source":
        return t(`fleet.monitoring.paths.verdict.source.${v.family}`, { source: e.source, bad: e.bad, fresh: e.fresh, elsewhere: e.elsewhere });
      case "path":
        return t(`fleet.monitoring.paths.verdict.path.${v.family}`, { n: e.others, target: e.target }, e.others);
      case "alone":
        return t("fleet.monitoring.paths.verdict.alone", { source: e.source, target: e.target });
    }
  }

  return { reasonText, reasonShort, refusalText, methodName, whyText, stateLabel, displayLabel, groupLabel, windowLong, evidenceSentences, degradedTimes, evidenceText, verdictLabel, verdictEvidence };
}
