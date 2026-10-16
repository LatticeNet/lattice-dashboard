/**
 * The check editor's words for the M2a rules (design 29 D9, D11): what a
 * node target resolves to, why an address breaks the destination rule, and
 * why a status set or a header is refused. One place, so the editor, the
 * node picker and the header rows say the same thing for the same fact.
 */
import { useI18n } from "vue-i18n";

import type { HeaderRowProblem, HeadersProblem } from "./checkHeadersModel";
import { EXPECT_STATUS_MAX_PARTS, HEADER_NAME_MAX, HEADER_VALUE_MAX, HEADERS_MAX, type DestinationProblem, type StatusSetProblem } from "./checkRulesModel";
import type { NodeTargetResolution } from "./checksModel";

export function useTargetCopy() {
  const { t } = useI18n();

  /** "203.0.113.12", "No public IPv4 address", "No public TCP line", "Resolved by the control plane when you save". */
  function resolutionText(kind: string, resolution: NodeTargetResolution): string {
    if (resolution.state === "resolved") return resolution.endpoint;
    if (resolution.state === "onSave") return t("fleet.monitoring.checks.editor.resolve.onSave");
    return refusedText(kind, resolution.reason);
  }

  /** Why a node cannot be resolved for a method. */
  function refusedText(kind: string, reason: string): string {
    const key = `fleet.monitoring.checks.editor.resolve.${reason}`;
    const known = ["no_public_ipv4", "no_tcp_line", "udp_only", "no_public_address", "no_inventory", "no_beacon"];
    return known.includes(reason) ? t(key) : t("fleet.monitoring.checks.editor.resolve.other", { method: kind.toUpperCase(), reason });
  }

  function destinationText(problem: DestinationProblem): string {
    return t(`fleet.monitoring.checks.editor.destination.${problem}`);
  }

  function statusSetText(problem: StatusSetProblem): string {
    if (problem.code === "tooMany") return t("fleet.monitoring.checks.editor.expectStatus.tooMany", { n: problem.count, max: EXPECT_STATUS_MAX_PARTS });
    return t(`fleet.monitoring.checks.editor.expectStatus.${problem.code}`, { entry: problem.entry });
  }

  function headerRowText(problem: HeaderRowProblem): string {
    return t(`fleet.monitoring.checks.editor.headers.problem.${problem}`, { max: HEADER_NAME_MAX, bytes: HEADER_VALUE_MAX });
  }

  function headersText(problem: HeadersProblem): string {
    return t(`fleet.monitoring.checks.editor.headers.problem.${problem}`, { max: HEADERS_MAX });
  }

  return { resolutionText, refusedText, destinationText, statusSetText, headerRowText, headersText };
}
