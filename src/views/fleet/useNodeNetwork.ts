import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";

import { api, ApiError, type NodeNetworkAccess, type NodeNetworkGroups, type NodeNetworkInbound, type NodeNetworkMesh, type NodeNetworkOutbound, type NodeNetworkView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useRefreshOnReturn } from "@/composables/useRefreshOnReturn";
import { formatRelativeTime } from "@/lib/format";

import { applyingPolicies, portLabel } from "./nodeNetworkModel";

/**
 * The node's effective network (design 32 D4) for one open node: read when
 * the node opens or changes, when the operator returns to the page, and after
 * this session's own change to an outbound policy or a node group. Never on a
 * timer. A server that predates the route answers 404 or 405, and `missing`
 * then hides the section rather than showing an error for a feature the
 * server does not have.
 */
export function useNodeNetwork(nodeId: () => string | null | undefined) {
  const query = useAsyncData<NodeNetworkView | undefined>(
    (signal) => {
      const id = nodeId();
      return id ? api.nodes.network(id, false, { signal }) : Promise.resolve(undefined);
    },
    { immediate: false },
  );
  watch(
    nodeId,
    (id) => {
      query.data.value = undefined;
      query.error.value = undefined;
      if (id) void query.refresh();
    },
    { immediate: true },
  );
  useRefreshOnReturn(() => void query.refresh(), { kinds: ["outbound_policy", "group"], active: () => !!nodeId() });

  const missing = computed(() => {
    const error = query.error.value;
    return error instanceof ApiError && (error.status === 404 || error.status === 405) && !query.data.value;
  });
  // The view belongs to the node that was asked for; one still in flight for
  // the previous node is not shown under the next one's name.
  const view = computed(() => (query.data.value && query.data.value.node_id === nodeId() ? query.data.value : undefined));
  return { query, view, missing };
}

/** The one-line wording of each section, shared by the sheet summary and the node page. */
export function useNodeNetworkText() {
  const { t } = useI18n();
  const list = (items: string[]) => items.join(t("fleet.nodeNetwork.join"));

  function refused(section: { scope?: string }): string {
    return t("fleet.nodeNetwork.refused", { scope: section.scope ?? "" });
  }

  function inbound(section: NodeNetworkInbound): string {
    if (section.state === "refused") return refused(section);
    const parts: string[] = [];
    switch (section.firewall) {
      case "netguard":
        parts.push(t("fleet.nodeNetwork.inbound.netguard"));
        break;
      case "legacy":
        parts.push(section.binding === "observe" ? t("fleet.nodeNetwork.inbound.observe") : t("fleet.nodeNetwork.inbound.legacy"));
        break;
      default:
        parts.push(t("fleet.nodeNetwork.inbound.none"));
    }
    const groups = [...(section.security_groups ?? []), ...(section.derived_security_groups ?? [])];
    if (groups.length) parts.push(list(groups.map((g) => g.name || g.id)));
    const ports = section.extra_ports ?? [];
    if (ports.length) parts.push(list(ports.map(extraPort)));
    return parts.join(" · ");
  }

  function extraPort(port: NonNullable<NodeNetworkInbound["extra_ports"]>[number]): string {
    const label = portLabel(port);
    if (port.source === "beacon") {
      return port.sources ? t("fleet.nodeNetwork.inbound.beaconSources", { port: label, n: port.sources }, port.sources) : t("fleet.nodeNetwork.inbound.beacon", { port: label });
    }
    return port.label ? t("fleet.nodeNetwork.inbound.dnsNamed", { port: label, name: port.label }) : t("fleet.nodeNetwork.inbound.dns", { port: label });
  }

  function outbound(section: NodeNetworkOutbound): string {
    if (section.state === "refused") return refused(section);
    switch (section.source) {
      case "manual":
        return section.manual?.enabled === false
          ? t("fleet.nodeNetwork.outbound.manualDisabled")
          : t("fleet.nodeNetwork.outbound.manual", { n: section.manual?.rules ?? 0 }, section.manual?.rules ?? 0);
      case "orphan":
        return section.orphan?.last_applied_at
          ? t("fleet.nodeNetwork.outbound.orphan", { when: formatRelativeTime(section.orphan.last_applied_at) })
          : t("fleet.nodeNetwork.outbound.orphanUnapplied", { n: section.orphan?.rules ?? 0 }, section.orphan?.rules ?? 0);
      case "policies": {
        const applying = applyingPolicies(section);
        const parts = [t("fleet.nodeNetwork.outbound.applying", { n: applying.length }, applying.length)];
        if (applying.length) parts.push(list(applying.map((p) => p.label)));
        if (section.default_drop) parts.push(t("fleet.nodeNetwork.outbound.defaultDrop"));
        return parts.join(" · ");
      }
      default:
        return t("fleet.nodeNetwork.outbound.none");
    }
  }

  function access(section: NodeNetworkAccess): string {
    if (section.state === "refused") return refused(section);
    if (!section.enrolled && !section.knock_required) return t("fleet.nodeNetwork.access.notEnrolled");
    const head = section.knock_required ? t("fleet.nodeNetwork.access.knockRequired") : t("fleet.nodeNetwork.access.noKnock");
    if (!section.stage || section.stage === "idle") return head;
    const stage = t(`fleet.nodeNetwork.access.stage.${section.stage}`, section.stage);
    return `${head} · ${section.stage_is_history ? t("fleet.nodeNetwork.access.history", { stage }) : stage}`;
  }

  function mesh(section: NodeNetworkMesh): string {
    if (section.state === "refused") return refused(section);
    if (!section.ready) return list((section.missing ?? []).map((m) => t(`fleet.nodeNetwork.mesh.missing.${m}`, m)));
    const parts = [t("fleet.nodeNetwork.mesh.address", { address: section.address ?? "" }), t("fleet.nodeNetwork.mesh.peers", { n: section.peers ?? 0 }, section.peers ?? 0)];
    if (section.last_applied) parts.push(t("fleet.nodeNetwork.mesh.lastApplied", { when: formatRelativeTime(section.last_applied.applied_at) }));
    return parts.join(" · ");
  }

  function groups(section: NodeNetworkGroups): string {
    if (section.state === "refused") return refused(section);
    const items = section.items ?? [];
    return items.length ? list(items.map((g) => g.name)) : t("fleet.nodeNetwork.groups.none");
  }

  return { inbound, extraPort, outbound, access, mesh, groups, refused, list };
}
