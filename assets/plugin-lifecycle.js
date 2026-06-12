const knownStatuses = new Set(["verified", "installed", "active", "disabled"]);

export function pluginLifecycleStatusLabel(status) {
  const value = String(status || "").trim();
  return knownStatuses.has(value) ? value : "unknown";
}

export function pluginLifecycleAvailability(plugin) {
  return plugin?.available === true ? "available" : "unavailable";
}

export function pluginLifecycleActions(plugin) {
  const status = pluginLifecycleStatusLabel(plugin?.status);
  const available = plugin?.available === true;
  switch (status) {
    case "verified":
      return available ? [{ status: "installed", label: "Install" }] : [];
    case "installed":
      return available
        ? [
            { status: "active", label: "Activate" },
            { status: "disabled", label: "Disable" },
          ]
        : [{ status: "disabled", label: "Disable" }];
    case "active":
      return [{ status: "disabled", label: "Disable" }];
    case "disabled":
      return available ? [{ status: "active", label: "Activate" }] : [];
    default:
      return [];
  }
}

export function pluginLifecycleCapabilities(plugin) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(plugin?.capabilities) ? plugin.capabilities : []) {
    if (typeof raw !== "string") continue;
    const cap = raw.trim();
    if (!cap || seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap);
  }
  return out;
}

export function pluginLifecycleDigestShort(hash) {
  const value = String(hash || "").trim();
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

export function pluginLifecycleTransitionPayload(id, status) {
  return {
    id: String(id || "").trim(),
    status: String(status || "").trim(),
  };
}

export function pluginLifecycleTransitionMessage(plugin, status) {
  const name = String(plugin?.name || plugin?.id || "this plugin").trim() || "this plugin";
  const target = pluginLifecycleStatusLabel(status);
  return `Change plugin "${name}" status to ${target}? This does not execute plugin code in the current build.`;
}

export function confirmPluginLifecycleTransition(plugin, status, confirmFn) {
  if (typeof confirmFn !== "function") return false;
  return Boolean(confirmFn(pluginLifecycleTransitionMessage(plugin, status)));
}
