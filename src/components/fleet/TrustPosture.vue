<script setup lang="ts">
/**
 * What the fleet's agents are allowed to do, and whether the console account
 * has a second factor (design 23, section 4.1: trust posture leaves home).
 *
 * It is configuration that changes when someone enrolls or reconfigures a
 * node, not something that moves, so it reads the node list once and does
 * not poll, and it carries no colour of its own: a standing amber "review"
 * on home was a banner the operator learned to skip. Each row is a count and
 * a link to the nodes it counts; the account row links to Security.
 *
 * Exec and terminal come from what each agent last reported; a node that has
 * not reported since the server restarted counts as having nothing enabled,
 * and the description says so.
 */
import { computed } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { useI18n } from "vue-i18n";

import { api, unwrap, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { nodeHasAgentCapability } from "@/lib/nodeFilterExpressions";
import { useAuthStore } from "@/stores/auth";

import ProofLine from "@/components/common/ProofLine.vue";

const auth = useAuthStore();
const canRead = auth.can("node:read");
const nodesQuery = useAsyncData<Node[]>((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  immediate: canRead,
});
const proof = useProof(nodesQuery);
const nodes = computed(() => nodesQuery.data.value ?? []);
const { t } = useI18n();
/** Read once: the line says so instead of an age nobody promised to refresh. */
const proofSegments = computed(() => [
  { key: "nodes", text: t("fleet.trustPosture.nodes", { n: nodes.value.length }, nodes.value.length) },
  { key: "once", text: t("fleet.trustPosture.readOnce"), tone: "muted" as const },
]);

interface Row {
  key: string;
  label: string;
  value: string;
  hint: string;
  to: RouteLocationRaw;
}

function count(token: string): number {
  return nodes.value.filter((node) => nodeHasAgentCapability(node, token)).length;
}

const read = computed(() => nodesQuery.data.value !== undefined);

const rows = computed<Row[]>(() => {
  const nodeRows: Row[] = canRead
    ? [
        { key: "root", token: "root", hint: "rootExecHint", label: "rootExec" },
        { key: "terminal", token: "terminal", hint: "terminalHint", label: "terminal" },
        { key: "source", token: "no-source", hint: "sourcePolicyHint", label: "sourcePolicy" },
      ].map((row) => ({
        key: row.key,
        label: `fleet.trustPosture.${row.label}`,
        value: read.value ? String(count(row.token)) : "",
        hint: `fleet.trustPosture.${row.hint}`,
        to: { name: "nodes", query: { agent: row.token } },
      }))
    : [];
  return [
    ...nodeRows,
    {
      key: "mfa",
      label: "fleet.trustPosture.accountMfa",
      value: auth.principal?.totp_enabled ? "on" : "off",
      hint: "fleet.trustPosture.accountMfaHint",
      to: { name: "settings-security" },
    },
  ];
});
</script>

<template>
  <section class="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="trust-posture" data-testid="trust-posture">
    <header class="space-y-1 border-b border-border px-4 py-3">
      <h2 id="trust-posture" class="text-sm font-medium">{{ $t('fleet.trustPosture.title') }}</h2>
      <p class="text-xs text-muted-foreground">{{ $t('fleet.trustPosture.description') }}</p>
      <ProofLine v-if="canRead" v-bind="proof" :segments="proofSegments" @retry="nodesQuery.refresh" />
    </header>
    <ul class="divide-y divide-border">
      <li v-for="row in rows" :key="row.key">
        <RouterLink
          :to="row.to"
          class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span class="min-w-0">
            <span class="block text-sm">{{ $t(row.label) }}</span>
            <span class="block text-xs text-muted-foreground">{{ $t(row.hint) }}</span>
          </span>
          <span
            v-if="row.key === 'mfa'"
            :class="row.value === 'on' ? 'text-sm text-foreground' : 'text-sm font-medium text-warning-text'"
          >
            {{ row.value === 'on' ? $t('fleet.trustPosture.mfaOn') : $t('fleet.trustPosture.mfaOff') }}
          </span>
          <span v-else-if="row.value" class="font-mono text-sm tabular">{{ $t('fleet.trustPosture.nodes', { n: Number(row.value) }, Number(row.value)) }}</span>
          <span v-else class="text-xs text-muted-foreground">{{ $t('fleet.trustPosture.notRead') }}</span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
