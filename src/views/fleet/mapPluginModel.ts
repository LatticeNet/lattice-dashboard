const VPN_LINES_CAPABILITY = "vpn-lines";
const VPN_EXPRESSION_TOKEN_RE = /\b(vpn|vpn[-_]?core|vpn[-_]?lines|line[-_]?recorded|lines)\b/i;

/** Every trust boundary must agree before a native page exposes plugin UI. */
export function vpnMapFeatureAvailable(
  pluginActive: boolean,
  linesContributionVisible: boolean,
  requiredScopeAllowed: boolean,
): boolean {
  return pluginActive && linesContributionVisible && requiredScopeAllowed;
}

/** Plugin-owned capabilities never appear in a base-only Map. */
export function filterMapCapabilities<T extends string>(capabilities: readonly T[], vpnPluginActive: boolean): T[] {
  return capabilities.filter((capability) => vpnPluginActive || capability !== VPN_LINES_CAPABILITY);
}

/** Dispose a selected plugin filter when its owner is deactivated. */
export function removeUnavailableVpnCapability<T extends string>(
  capabilities: readonly T[],
  vpnPluginActive: boolean,
): T[] {
  return filterMapCapabilities(capabilities, vpnPluginActive);
}

/** Optional plugin data must never be fetched for an inactive plugin. */
export function expressionNeedsVpnLines(expression: string, vpnPluginActive: boolean): boolean {
  return vpnPluginActive && VPN_EXPRESSION_TOKEN_RE.test(expression);
}

/** A plugin-specific expression cannot be allowed to constrain the base Map. */
export function clearUnavailableVpnExpression(expression: string, vpnPluginActive: boolean): string {
  return !vpnPluginActive && VPN_EXPRESSION_TOKEN_RE.test(expression) ? "" : expression;
}
