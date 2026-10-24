<script setup lang="ts">
/**
 * The node sheet's network summary (design 32 D4): one line per section of
 * what applies to the node, a warning when a table's writer would compile
 * something else now than what it last applied, and the way to the node
 * page's Network section, where Show rules lives. Opened from Topology the
 * sheet leads with the node's paths (D2) and this sits below them.
 *
 *   Network
 *   Inbound    NetGuard enforces · security groups web, ssh · DNS 53 udp/tcp (self-host DNS)
 *   Outbound   2 policies apply · egress-web, ops · default drop
 *   Access     SSH Guard: knock required · confirmed
 *   Mesh       WireGuard 10.66.0.12 · 31 peers
 *   Groups     web, asia
 *   1 table needs a re-plan: inet lattice_guard     Open the node's network
 *
 * A section this session may not read says which scope it needs instead of
 * a value, and a server without the route shows nothing.
 */
import { computed } from "vue";
import { AlertTriangle } from "lucide-vue-next";
import { RouterLink } from "vue-router";

import { proofReason } from "@/components/common/proofModel";
import { attentionTables, tableAttention } from "@/views/fleet/nodeNetworkModel";
import { useNodeNetwork, useNodeNetworkText } from "@/views/fleet/useNodeNetwork";

const props = defineProps<{ nodeId: string }>();

const { query, view, missing } = useNodeNetwork(() => props.nodeId);
const text = useNodeNetworkText();

const rows = computed(() => {
  const v = view.value;
  if (!v) return [];
  return [
    { key: "inbound", value: text.inbound(v.inbound), refused: v.inbound.state === "refused" },
    { key: "outbound", value: text.outbound(v.outbound), refused: v.outbound.state === "refused" },
    { key: "access", value: text.access(v.access), refused: v.access.state === "refused" },
    { key: "mesh", value: text.mesh(v.mesh), refused: v.mesh.state === "refused" },
    { key: "groups", value: text.groups(v.groups), refused: v.groups.state === "refused" },
  ];
});
const guardNote = computed(() => (view.value ? text.guardNote(view.value) : ""));
/** Re-plans first, then tables nothing produces, then drift, naming the tables. */
const attention = computed(() => {
  if (!view.value) return "";
  const tables = attentionTables(view.value);
  for (const [kind, message] of [
    ["replan", "fleet.nodeNetwork.attention"],
    ["orphan", "fleet.nodeNetwork.orphanTables"],
    ["drift", "fleet.nodeNetwork.drift"],
  ] as const) {
    const matching = tables.filter((table) => tableAttention(table) === kind);
    if (matching.length) return text.tablesLine(message, matching);
  }
  return "";
});
</script>

<template>
  <section v-if="!missing" class="space-y-1.5 border-t border-border pt-3" aria-labelledby="node-sheet-network" data-testid="node-sheet-network">
    <h3 id="node-sheet-network" class="text-sm font-medium">{{ $t('fleet.nodeNetwork.title') }}</h3>
    <dl v-if="view" class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      <template v-for="row in rows" :key="row.key">
        <dt class="text-xs text-muted-foreground">{{ $t(`fleet.nodeNetwork.rows.${row.key}`) }}</dt>
        <dd class="min-w-0 break-words" :class="row.refused ? 'text-xs text-muted-foreground' : undefined">
          {{ row.value }}
          <span v-if="row.key === 'inbound' && guardNote" class="mt-0.5 flex items-start gap-1.5 text-xs text-warning-text" data-testid="node-sheet-guard-note">
            <AlertTriangle class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>{{ guardNote }}</span>
          </span>
        </dd>
      </template>
    </dl>
    <p v-else-if="query.error.value" class="text-muted-foreground">{{ $t('fleet.nodeNetwork.notRead', { reason: proofReason(query.error.value) }) }}</p>
    <p v-else class="text-muted-foreground">{{ $t('fleet.nodeNetwork.reading') }}</p>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p v-if="attention" class="text-xs text-warning-text">{{ attention }}</p>
      <RouterLink
        :to="{ name: 'node-detail', params: { id: nodeId }, hash: '#node-network' }"
        class="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
      >
        {{ $t('fleet.nodeNetwork.openSection') }}
      </RouterLink>
    </div>
  </section>
</template>
