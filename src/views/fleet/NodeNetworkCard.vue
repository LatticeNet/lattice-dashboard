<script setup lang="ts">
/**
 * The Network section of a node's page (design 32 D4): what applies to this
 * node, by direction, with every outbound policy that reaches it in the order
 * they merge.
 *
 *   Inbound    NetGuard enforces · zones public, wireguard
 *              Security groups  web (3 rules), ssh (1 rule)
 *              Extra ports      DNS 53 udp/tcp (self-host DNS), beacon 47000 udp (from 3 sources)
 *   Outbound   2 policies apply · default drop
 *              5   egress-ssh   names this node      applies   1 allow · 0 deny
 *              10  egress-web   through web          applies   1 allow · 0 deny
 *              20  fleet-dns    excludes this node   excluded
 *   Access     SSH Guard: knock required · confirmed
 *   Mesh       WireGuard 10.66.0.12 · 31 peers · config applied 2 days ago
 *   Groups     web, asia
 *   inet lattice_guard needs a re-plan       [Open in firewall] [Open policy] [Show rules]
 *
 * Security groups bound to a node group the node belongs to (S4) are listed
 * with their node group once the server sends them. A section this session
 * may not read names the scope it needs. The section reads when the page
 * opens, when the operator returns to it, and after their own change to an
 * outbound policy or a node group.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { Network } from "lucide-vue-next";

import type { Node, NodeNetworkPolicy } from "@/lib/api";
import { usePluginContributions } from "@/composables/usePluginContributions";
import { proofReason } from "@/components/common/proofModel";

import GroupChip from "@/components/networking/GroupChip.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import NodeNetworkRules from "./NodeNetworkRules.vue";
import { attentionTables, tableAttention } from "./nodeNetworkModel";
import { useNodeNetwork, useNodeNetworkText } from "./useNodeNetwork";

const props = defineProps<{ node: Node }>();

const { t } = useI18n();
const plugins = usePluginContributions();
const { query, view, missing } = useNodeNetwork(() => props.node.id);
const text = useNodeNetworkText();

const rulesOpen = ref(false);

const NETGUARD = "latticenet.netguard";
const firewallTo = computed(() => (plugins.findPlugin(NETGUARD) ? { path: `/plugins/${NETGUARD}/firewall`, query: { open: props.node.id } } : undefined));
/** One policy applying opens that policy; otherwise the node's document on the policy page. */
const policyTo = computed(() => {
  const applying = (view.value?.outbound.policies ?? []).filter((p) => p.state === "applies");
  if (applying.length === 1) return { name: "network-outbound-policy", query: { policy: applying[0]!.id } };
  return { name: "network-outbound-policy", query: { view: "nodes", open: props.node.id } };
});

const inbound = computed(() => view.value?.inbound);
const outbound = computed(() => view.value?.outbound);
const securityGroups = computed(() => [...(inbound.value?.security_groups ?? []), ...(inbound.value?.derived_security_groups ?? [])]);

function inboundHead(): string {
  const section = inbound.value;
  if (!section || section.state !== "ok") return section ? text.refused(section) : "";
  const head =
    section.firewall === "netguard"
      ? t("fleet.nodeNetwork.inbound.netguard")
      : section.firewall === "legacy"
        ? section.binding === "observe"
          ? t("fleet.nodeNetwork.inbound.observe")
          : t("fleet.nodeNetwork.inbound.legacy")
        : t("fleet.nodeNetwork.inbound.none");
  const zones = section.zones ?? [];
  return zones.length ? `${head} · ${t("fleet.nodeNetwork.inbound.zones", { zones: text.list(zones.map((z) => z.name || z.id)) })}` : head;
}

function outboundHead(): string {
  const section = outbound.value;
  if (!section) return "";
  if (section.state !== "ok" || section.source !== "policies") return text.outbound(section);
  const n = (section.policies ?? []).filter((p) => p.state === "applies").length;
  const head = t("fleet.nodeNetwork.outbound.applying", { n }, n);
  return section.default_drop ? `${head} · ${t("fleet.nodeNetwork.outbound.defaultDrop")}` : head;
}

function reachText(policy: NodeNetworkPolicy): string {
  if (policy.reach === "group") return t("fleet.nodeNetwork.outbound.reach.group", { groups: text.list((policy.via_groups ?? []).map((g) => g.name || g.id)) });
  return t(`fleet.nodeNetwork.outbound.reach.${policy.reach}`);
}

const replanTables = computed(() => (view.value ? attentionTables(view.value).filter((table) => tableAttention(table) === "replan") : []));
const driftTables = computed(() => (view.value ? attentionTables(view.value).filter((table) => tableAttention(table) === "drift") : []));
</script>

<template>
  <Card v-if="!missing" id="node-network" class="scroll-mt-20" data-testid="node-network">
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        <Network class="size-4 text-muted-foreground" aria-hidden="true" />
        {{ $t('fleet.nodeNetwork.title') }}
      </CardTitle>
      <CardDescription>{{ $t('fleet.nodeNetwork.description') }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <p v-if="query.error.value && !view" class="text-sm text-muted-foreground">{{ $t('fleet.nodeNetwork.notRead', { reason: proofReason(query.error.value) }) }}</p>
      <p v-else-if="!view" class="text-sm text-muted-foreground">{{ $t('fleet.nodeNetwork.reading') }}</p>
      <dl v-else class="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt class="text-xs font-medium text-muted-foreground sm:pt-0.5">{{ $t('fleet.nodeNetwork.rows.inbound') }}</dt>
        <dd class="min-w-0 space-y-1" data-testid="node-network-inbound">
          <p :class="inbound?.state !== 'ok' ? 'text-xs text-muted-foreground' : undefined">{{ inboundHead() }}</p>
          <template v-if="inbound?.state === 'ok'">
            <p class="break-words">
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodeNetwork.inbound.securityGroups') }} </span>
              <template v-if="securityGroups.length">
                <span v-for="(group, i) in securityGroups" :key="`${group.id}-${group.via?.id ?? ''}`">
                  {{ group.name || group.id }}
                  <span class="text-xs text-muted-foreground">({{ $t('fleet.nodeNetwork.inbound.groupRules', { n: group.rules }, group.rules) }}<template v-if="group.via">, {{ $t('fleet.nodeNetwork.inbound.viaGroup', { group: group.via.name || group.via.id }) }}</template>)</span><template v-if="i < securityGroups.length - 1">{{ $t('fleet.nodeNetwork.join') }}</template>
                </span>
              </template>
              <span v-else class="text-muted-foreground">{{ $t('fleet.nodeNetwork.inbound.noSecurityGroups') }}</span>
            </p>
            <p v-if="inbound.extra_ports?.length" class="break-words">
              <span class="text-xs text-muted-foreground">{{ $t('fleet.nodeNetwork.inbound.extraPorts') }} </span>
              <span class="font-mono text-xs">{{ text.list(inbound.extra_ports.map(text.extraPort)) }}</span>
            </p>
            <p v-if="inbound.legacy_ingress" class="text-xs text-muted-foreground">
              {{ $t(`fleet.nodeNetwork.inbound.legacyIngress.${inbound.legacy_ingress.state}`, { n: inbound.legacy_ingress.rules }, inbound.legacy_ingress.rules) }}
            </p>
          </template>
        </dd>

        <dt class="text-xs font-medium text-muted-foreground sm:pt-0.5">{{ $t('fleet.nodeNetwork.rows.outbound') }}</dt>
        <dd class="min-w-0 space-y-1.5" data-testid="node-network-outbound">
          <p :class="outbound?.state !== 'ok' ? 'text-xs text-muted-foreground' : undefined">{{ outboundHead() }}</p>
          <ol v-if="outbound?.state === 'ok' && outbound.policies?.length" class="divide-y divide-border rounded-md border border-border">
            <li
              v-for="policy in outbound.policies"
              :key="policy.id"
              class="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,11rem)_11rem]"
              :class="policy.state === 'applies' ? undefined : 'text-muted-foreground'"
            >
              <span class="font-mono text-xs tabular-nums text-muted-foreground" :title="$t('fleet.nodeNetwork.outbound.priority', { n: policy.priority })">{{ policy.priority }}</span>
              <RouterLink
                :to="{ name: 'network-outbound-policy', query: { policy: policy.id } }"
                class="min-w-0 truncate underline decoration-dotted underline-offset-2 hover:text-foreground"
                :class="policy.state === 'applies' ? 'text-foreground' : undefined"
              >
                {{ policy.label }}<span v-if="policy.hidden_target_nodes" class="text-xs text-muted-foreground"> {{ $t('fleet.nodeNetwork.outbound.hidden', { n: policy.hidden_target_nodes }) }}</span>
              </RouterLink>
              <span class="col-start-2 min-w-0 truncate text-xs sm:col-start-auto">{{ reachText(policy) }}</span>
              <span class="col-start-2 text-xs sm:col-start-auto sm:text-end">
                <span :class="policy.state === 'blocked' ? 'text-warning-text' : undefined">{{ $t(`fleet.nodeNetwork.outbound.state.${policy.state}`) }}</span>
                <template v-if="policy.state === 'applies'"> · <span class="tabular-nums">{{ $t('fleet.nodeNetwork.outbound.rules', { allow: policy.allow, deny: policy.deny }) }}</span></template>
              </span>
            </li>
          </ol>
          <p v-if="outbound?.state === 'ok' && outbound.source !== 'policies' && outbound.source !== 'none'" class="text-xs text-muted-foreground">{{ text.outbound(outbound) }}</p>
        </dd>

        <dt class="text-xs font-medium text-muted-foreground sm:pt-0.5">{{ $t('fleet.nodeNetwork.rows.access') }}</dt>
        <dd class="min-w-0" :class="view.access.state !== 'ok' ? 'text-xs text-muted-foreground' : undefined" data-testid="node-network-access">{{ text.access(view.access) }}</dd>

        <dt class="text-xs font-medium text-muted-foreground sm:pt-0.5">{{ $t('fleet.nodeNetwork.rows.mesh') }}</dt>
        <dd class="min-w-0 space-y-0.5" data-testid="node-network-mesh">
          <p :class="view.mesh.state !== 'ok' || !view.mesh.ready ? 'text-xs text-muted-foreground' : undefined">{{ text.mesh(view.mesh) }}</p>
          <p v-if="view.mesh.state === 'ok' && view.mesh.not_reported?.length" class="text-xs text-muted-foreground">{{ $t('fleet.nodeNetwork.mesh.notReported') }}</p>
        </dd>

        <dt class="text-xs font-medium text-muted-foreground sm:pt-0.5">{{ $t('fleet.nodeNetwork.rows.groups') }}</dt>
        <dd class="min-w-0">
          <ul v-if="view.groups.state === 'ok' && view.groups.items?.length" class="flex flex-wrap gap-x-3 gap-y-1">
            <li v-for="group in view.groups.items" :key="group.id">
              <RouterLink :to="{ name: 'groups', query: { open: group.id } }" class="rounded-sm hover:underline focus-visible:outline-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
                <GroupChip :name="group.name" :color="group.color" />
              </RouterLink>
            </li>
          </ul>
          <span v-else class="text-xs text-muted-foreground">{{ text.groups(view.groups) }}</span>
        </dd>
      </dl>

      <div class="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <p v-if="replanTables.length" class="me-auto text-xs text-warning-text" data-testid="node-network-attention">
          {{ $t('fleet.nodeNetwork.attention', { n: replanTables.length }, replanTables.length) }}: <span class="font-mono">{{ replanTables.map((t) => t.table).join(', ') }}</span>
        </p>
        <p v-else-if="driftTables.length" class="me-auto text-xs text-warning-text">
          {{ $t('fleet.nodeNetwork.drift', { n: driftTables.length }, driftTables.length) }}: <span class="font-mono">{{ driftTables.map((t) => t.table).join(', ') }}</span>
        </p>
        <span v-else class="me-auto" />
        <Button v-if="firewallTo" as-child variant="outline" size="sm" class="pointer-coarse:min-h-11">
          <RouterLink :to="firewallTo">{{ $t('fleet.nodeNetwork.actions.openFirewall') }}</RouterLink>
        </Button>
        <Button v-if="view && view.outbound.state === 'ok'" as-child variant="outline" size="sm" class="pointer-coarse:min-h-11">
          <RouterLink :to="policyTo">{{ $t('fleet.nodeNetwork.actions.openPolicy') }}</RouterLink>
        </Button>
        <Button type="button" variant="outline" size="sm" class="pointer-coarse:min-h-11" :disabled="!view" @click="rulesOpen = true">
          {{ $t('fleet.nodeNetwork.actions.showRules') }}
        </Button>
      </div>
    </CardContent>
  </Card>
  <NodeNetworkRules v-if="view" v-model:open="rulesOpen" :node-id="node.id" :node-name="node.name || node.id" />
</template>
