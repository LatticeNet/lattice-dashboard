<script setup lang="ts">
/**
 * Show rules (design 32 D4): for each nftables table Lattice writes on the
 * node, who owns it, who wrote it last, and two labelled columns: what its
 * writer's composer would compile now, and what the last applied approval
 * put there. "Re-plan pending" when they differ, with the lines a re-plan
 * would add and remove marked in order, "In force, nothing produces it" for
 * a table whose rules outlived their source. Tables that need something come
 * first; one that matches what was applied folds its rules away. The SSH
 * Guard table never shows rules, because its rules are the knock sequence.
 *
 *   inet lattice_guard                                   Re-plan pending
 *   Owners: NetGuard writes · beacon feeds it · legacy firewall route refused here
 *   Last written by legacy firewall route, 2 hours ago   Open the approval
 *   Would compile now (by NetGuard)  | Last applied (legacy firewall route)
 *   table inet lattice_guard {       | table inet lattice_guard {
 *   + tcp dport { 443 } accept       | - tcp dport { 8080 } accept
 *
 * The text is read only when the dialog opens, with rules=1, and again when
 * the operator returns to the page.
 */
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";

import { api, type NodeNetworkRuleset, type NodeNetworkTable, type NodeNetworkView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useRefreshOnReturn } from "@/composables/useRefreshOnReturn";
import { formatRelativeTime } from "@/lib/format";
import { proofReason } from "@/components/common/proofModel";

import { Badge } from "@/components/ui/badge";
import { Dialog, DialogDescription, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";

import { compareRulesets, orderedOwners, tableAttention, tableInSync } from "./nodeNetworkModel";

const props = defineProps<{ nodeId: string; nodeName: string }>();
const open = defineModel<boolean>("open", { required: true });

const { t } = useI18n();

const query = useAsyncData<NodeNetworkView | undefined>((signal) => api.nodes.network(props.nodeId, true, { signal }), { immediate: false });
watch(
  [open, () => props.nodeId],
  ([isOpen]) => {
    if (!isOpen) return;
    query.data.value = undefined;
    void query.refresh();
  },
  { immediate: true },
);
useRefreshOnReturn(() => void query.refresh(), { kinds: ["outbound_policy", "group"], active: () => open.value });

const tables = computed(() => {
  const entries = (query.data.value?.tables ?? []).map((table) => ({
    table,
    attention: tableAttention(table),
    inSync: tableInSync(table),
    compare: compareRulesets(table.compile_now?.ruleset, table.last_applied?.ruleset),
  }));
  // What asks for something first; the server's order otherwise.
  return [...entries.filter((entry) => entry.attention), ...entries.filter((entry) => !entry.attention)];
});

/** "3 lines to add on re-plan · 1 line to remove", or the reorder sentence. */
function compareLine(compare: { added: number; removed: number; reordered: boolean }): string {
  if (compare.reordered) return t("fleet.nodeNetwork.rules.reordered");
  const parts: string[] = [];
  if (compare.added) parts.push(t("fleet.nodeNetwork.rules.added", { n: compare.added }, compare.added));
  if (compare.removed) parts.push(t("fleet.nodeNetwork.rules.removed", { n: compare.removed }, compare.removed));
  return parts.join(" · ");
}

function ownerName(kind: string): string {
  return t(`fleet.nodeNetwork.rules.owner.${kind}`, kind);
}

function ownersLine(table: NodeNetworkTable): string {
  return orderedOwners(table.owners)
    .map((owner) => t("fleet.nodeNetwork.rules.ownerWithState", { owner: ownerName(owner.kind), state: t(`fleet.nodeNetwork.rules.ownerState.${owner.state}`, owner.state) }))
    .join(" · ");
}

/** Why a column has no text: refused, nothing composes it, it does not compile, or nothing was applied. */
function columnNote(column: NodeNetworkRuleset | undefined, side: "now" | "applied"): string {
  if (!column) return "";
  switch (column.state) {
    case "refused":
      return column.scope ? t("fleet.nodeNetwork.rules.refused", { scope: column.scope }) : (column.reason ?? "");
    case "error":
      return t("fleet.nodeNetwork.rules.error", { reason: column.reason ?? "" });
    case "none":
      return side === "now" ? t("fleet.nodeNetwork.rules.none") : t("fleet.nodeNetwork.rules.neverApplied");
    default:
      return "";
  }
}

function shortSha(sha?: string): string {
  return sha ? sha.slice(0, 12) : "";
}
</script>

<template>
  <Dialog v-model:open="open">
    <!-- self-start at phone width, as SshGuardView's dialog: a dialog taller
         than the viewport centred in a scroll container overflows above the top. -->
    <DialogScrollContent class="sm:max-w-6xl max-sm:my-0 max-sm:min-h-dvh max-sm:max-w-none max-sm:self-start max-sm:rounded-none max-sm:border-0" data-testid="node-network-rules">
      <DialogHeader>
        <DialogTitle class="tracking-[-0.02em]">{{ $t('fleet.nodeNetwork.rules.title') }} · {{ nodeName }}</DialogTitle>
        <DialogDescription>{{ $t('fleet.nodeNetwork.rules.subtitle') }}</DialogDescription>
      </DialogHeader>

      <p v-if="query.error.value && !query.data.value" class="text-sm text-muted-foreground">{{ $t('fleet.nodeNetwork.notRead', { reason: proofReason(query.error.value) }) }}</p>
      <p v-else-if="!query.data.value" class="text-sm text-muted-foreground">{{ $t('fleet.nodeNetwork.reading') }}</p>

      <div v-else class="min-w-0 space-y-8">
        <section v-for="entry in tables" :key="entry.table.table" class="min-w-0 space-y-3" :aria-labelledby="`rules-${entry.table.table.replace(/\s/g, '-')}`">
          <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 :id="`rules-${entry.table.table.replace(/\s/g, '-')}`" class="font-mono text-sm font-medium">{{ entry.table.table }}</h3>
            <template v-if="entry.table.state === 'ok'">
              <Badge v-if="entry.attention === 'replan'" variant="outline" class="border-warning-text/40 text-warning-text">{{ $t('fleet.nodeNetwork.rules.replan') }}</Badge>
              <Badge v-else-if="entry.attention === 'orphan'" variant="outline" class="border-warning-text/40 text-warning-text">{{ $t('fleet.nodeNetwork.rules.orphan') }}</Badge>
              <Badge v-else-if="entry.attention === 'drift'" variant="outline" class="border-warning-text/40 text-warning-text">{{ $t('fleet.nodeNetwork.rules.drift') }}</Badge>
              <span v-else-if="entry.inSync" class="text-xs text-muted-foreground">{{ $t('fleet.nodeNetwork.rules.inSync') }}</span>
            </template>
          </div>

          <p v-if="entry.table.state !== 'ok'" class="text-sm text-muted-foreground">{{ $t('fleet.nodeNetwork.refused', { scope: entry.table.scope ?? '' }) }}</p>
          <template v-else>
            <dl class="grid grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
              <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodeNetwork.rules.writers') }}</dt>
              <dd class="min-w-0 break-words">{{ ownersLine(entry.table) }}</dd>
              <template v-if="entry.table.last_writer">
                <dt class="sr-only">{{ $t('fleet.nodeNetwork.rules.applied') }}</dt>
                <dd class="min-w-0 break-words text-muted-foreground sm:col-start-2">
                  {{ $t('fleet.nodeNetwork.rules.lastWriter', { writer: ownerName(entry.table.last_writer.kind), when: formatRelativeTime(entry.table.last_writer.applied_at) }) }}
                  <RouterLink
                    v-if="entry.table.last_writer.approval_id"
                    :to="{ name: 'approvals', query: { open: entry.table.last_writer.approval_id } }"
                    :aria-label="$t('fleet.nodeNetwork.rules.openApprovalFor', { table: entry.table.table })"
                    class="ms-2 text-xs underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                  >
                    {{ $t('fleet.nodeNetwork.rules.openApproval') }}
                  </RouterLink>
                </dd>
              </template>
            </dl>

            <p v-if="entry.table.rules_withheld === 'knock'" class="text-sm text-muted-foreground">{{ $t('fleet.nodeNetwork.rules.knockWithheld') }}</p>
            <template v-else>
              <p v-if="entry.compare.changed > 0" class="text-xs text-warning-text">{{ compareLine(entry.compare) }}</p>
              <component :is="entry.inSync ? 'details' : 'div'" class="group">
                <summary v-if="entry.inSync" class="cursor-pointer text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:min-h-11">
                  {{ $t('fleet.nodeNetwork.rules.showInSync') }}
                </summary>
                <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2" :class="entry.inSync ? 'mt-3' : undefined">
                  <div v-for="side in (['now', 'applied'] as const)" :key="side" class="min-w-0 space-y-1.5">
                    <h4 class="flex flex-wrap items-baseline gap-x-2 text-xs font-medium">
                      {{ side === 'now' ? $t('fleet.nodeNetwork.rules.now') : $t('fleet.nodeNetwork.rules.applied') }}
                      <span v-if="(side === 'now' ? entry.table.compile_now : entry.table.last_applied)?.composer" class="font-normal text-muted-foreground">
                        {{ $t('fleet.nodeNetwork.rules.composer', { composer: ownerName((side === 'now' ? entry.table.compile_now : entry.table.last_applied)?.composer ?? '') }) }}
                      </span>
                      <span v-if="(side === 'now' ? entry.table.compile_now : entry.table.last_applied)?.sha256" class="font-mono font-normal text-muted-foreground">
                        {{ $t('fleet.nodeNetwork.rules.digest', { sha: shortSha((side === 'now' ? entry.table.compile_now : entry.table.last_applied)?.sha256) }) }}
                      </span>
                    </h4>
                    <!-- Wrapped with a hanging indent so a long rule stays whole at 375; the gutter
                         says + (a re-plan adds it) or - (a re-plan removes it) without colour. -->
                    <pre
                      v-if="(side === 'now' ? entry.compare.now : entry.compare.applied).length"
                      class="max-h-[60vh] min-w-0 overflow-auto rounded-md border border-border bg-muted/30 py-2 font-mono text-xs leading-5"
                      tabindex="0"
                      :aria-label="side === 'now' ? $t('fleet.nodeNetwork.rules.nowFor', { table: entry.table.table }) : $t('fleet.nodeNetwork.rules.appliedFor', { table: entry.table.table })"
                    ><span
                      v-for="(line, i) in (side === 'now' ? entry.compare.now : entry.compare.applied)"
                      :key="i"
                      class="block whitespace-pre-wrap break-words ps-8 pe-3 -indent-5"
                      :class="line.changed ? 'border-s-2 border-warning-text bg-warning/15 ps-7.5' : undefined"
                    ><span class="inline-block w-5 indent-0 text-muted-foreground" aria-hidden="true">{{ line.changed ? (side === 'now' ? '+' : '-') : '' }}</span><span v-if="line.changed" class="sr-only">{{ side === 'now' ? $t('fleet.nodeNetwork.rules.lineAdded') : $t('fleet.nodeNetwork.rules.lineRemoved') }}</span>{{ line.text || ' ' }}</span></pre>
                    <p v-else class="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                      {{ columnNote(side === 'now' ? entry.table.compile_now : entry.table.last_applied, side) }}
                    </p>
                  </div>
                </div>
              </component>
            </template>
          </template>
        </section>
      </div>
    </DialogScrollContent>
  </Dialog>
</template>
