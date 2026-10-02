/**
 * What each kind of approval is called where a person reads it.
 *
 * The server files an approval as (plugin, action), and for the binding-typed
 * kinds a method as well: "sshguard · sshguard-arm:v1", "singbox-lineuser ·
 * apply-line-user:<sha>" with method "apply_remove". Those are identifiers.
 * The inbox, the sheet, the Tasks origin column and the trace print a title
 * from this table instead, and keep the identifier beside it in mono (and as
 * the title attribute) so the plan can still be found by what the server
 * calls it.
 *
 * The table covers every kind lattice-server files (e596325: each
 * `model.Approval{` construction site). The four official plugins' plan
 * methods are core-backed and land on these kinds; a third-party runtime
 * plugin files "<plugin id>/<service>/<method>", which no table can know, so
 * it gets a readable fallback built from its own words.
 *
 * Framework-free: a view resolves the returned key through i18n.
 */

/** The fields a title needs. Compatible with ApprovalView. */
export interface ApprovalKindSource {
  plugin: string;
  action: string;
  /** The binding's method ("apply_add", "chain_remove_apply"); sent on rows from servers that bind one. */
  method?: string;
}

export const APPROVAL_KINDS = [
  "agentUpdate",
  "lineMetaSync",
  "lineUserAdd",
  "lineUserUpdate",
  "lineUserRemove",
  "lineUserChange",
  "managedLineRollout",
  "lineChainSet",
  "lineChainRemove",
  "lineChainChange",
  "proxyCoreConfig",
  "selfDnsConfig",
  "networkPolicy",
  "netguardRuleset",
  "firewallRuleset",
  "tunnelConfig",
  "wireguardConfig",
  "sshGuardArm",
  "sshGuardConfirm",
] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** i18n namespace of the titles; `generic` is the fallback for a kind nobody listed. */
export const APPROVAL_KIND_KEY_PREFIX = "operations.approvals.kinds";

/** Action prefix: the part before the first ":" ("apply-metadata:abc…" is "apply-metadata"). */
export function approvalActionPrefix(action: string): string {
  const at = action.indexOf(":");
  return (at === -1 ? action : action.slice(0, at)).trim();
}

/** The NetGuard ruleset rides the firewall's plugin and prefix; only the suffix tells it apart. */
const NETGUARD_ACTION = /^apply-ruleset:netguard-/;

/** The known kind of an approval, or null when the server filed something this table does not list. */
export function approvalKind(source: ApprovalKindSource): ApprovalKind | null {
  const prefix = approvalActionPrefix(source.action);
  switch (source.plugin) {
    case "agentupdate":
      return prefix === "update-agent" ? "agentUpdate" : null;
    case "singbox-linemeta":
      return prefix === "apply-metadata" ? "lineMetaSync" : null;
    case "singbox-lineuser":
      if (prefix !== "apply-line-user") return null;
      if (source.method === "apply_add") return "lineUserAdd";
      if (source.method === "apply_update") return "lineUserUpdate";
      if (source.method === "apply_remove") return "lineUserRemove";
      return "lineUserChange";
    case "singbox-managedline":
      return prefix === "apply-managed-line" ? "managedLineRollout" : null;
    case "singbox-linechain":
      if (prefix !== "apply-line-chain") return null;
      if (source.method === "chain_set_apply") return "lineChainSet";
      if (source.method === "chain_remove_apply") return "lineChainRemove";
      return "lineChainChange";
    case "proxycore":
      return prefix === "apply-config" ? "proxyCoreConfig" : null;
    case "selfdns":
      return prefix === "apply-config" ? "selfDnsConfig" : null;
    case "nftpolicy":
      return prefix === "apply-ruleset" ? "networkPolicy" : null;
    case "nft":
      if (prefix !== "apply-ruleset") return null;
      return NETGUARD_ACTION.test(source.action.trim()) ? "netguardRuleset" : "firewallRuleset";
    case "cftunnel":
      return prefix === "apply-config" ? "tunnelConfig" : null;
    case "wireguard":
      return prefix === "apply-config" ? "wireguardConfig" : null;
    case "sshguard":
      if (prefix === "sshguard-arm") return "sshGuardArm";
      if (prefix === "sshguard-confirm") return "sshGuardConfirm";
      return null;
    default:
      return null;
  }
}

/**
 * The fallback's words for a kind nobody listed: the action without the
 * plugin id it repeats ("example.plugin/reference/plan" says "reference
 * plan"), in sentence case, and the plugin by the last part of its id.
 */
export function approvalFallbackWords(source: ApprovalKindSource): { action: string; plugin: string } {
  const plugin = source.plugin.trim();
  let action = approvalActionPrefix(source.action);
  if (plugin && action.startsWith(`${plugin}/`)) action = action.slice(plugin.length + 1);
  const words = action.split(/[/_\-.\s]+/).filter(Boolean).join(" ");
  const shortPlugin = plugin.includes(".") ? plugin.slice(plugin.lastIndexOf(".") + 1) : plugin;
  return {
    action: words ? words.charAt(0).toUpperCase() + words.slice(1) : shortPlugin || "?",
    plugin: shortPlugin || "?",
  };
}

/** The i18n key and parameters of an approval's title. */
export function approvalTitleMessage(source: ApprovalKindSource): { key: string; params: Record<string, string> } {
  const kind = approvalKind(source);
  if (kind) return { key: `${APPROVAL_KIND_KEY_PREFIX}.${kind}`, params: {} };
  return { key: `${APPROVAL_KIND_KEY_PREFIX}.generic`, params: approvalFallbackWords(source) };
}

/** The identifier as the server spells it, without the digest suffix: "sshguard · sshguard-arm". */
export function approvalRawLabel(source: ApprovalKindSource): string {
  return `${source.plugin} · ${approvalActionPrefix(source.action)}`;
}

/**
 * The plan's own one-line summary, when the plan is JSON that carries one
 * (line users, managed lines, line chains and runtime plugin operations do:
 * "Route hk-reality on [cd]-hkg through managed target jp-1"). Other plans are
 * text and have none.
 */
export function approvalPlanSummary(plan?: string): string | undefined {
  const text = plan?.trim();
  if (!text || !text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const summary = (parsed as Record<string, unknown>).summary;
      if (typeof summary === "string" && summary.trim()) return summary.trim();
    }
  } catch {
    // Not JSON after all; a text plan has no summary line.
  }
  return undefined;
}
