<script setup lang="ts">
/**
 * Why a node's beacon needs a change plan, in plain words, and the one action
 * that settles it (the server's replan): the firewall, or the beacon's key
 * set, changes only through an approved node.beacon plan, so the named
 * sources cannot measure the target until one is approved.
 *
 * The action is, in this order: review the plan that already waits (filing
 * another beside it would only be refused as stale once one applies); file
 * the change plan, which the page opens pre-filled as the server words it;
 * or, for a session without the scopes, open the target's Beacon card, which
 * names them. Used on the path sheet, the check sheet, the node's Beacon card
 * and, without the action, at the top of the plan sheet itself.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { FilePlus2, RefreshCw } from "lucide-vue-next";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

import { replanLines, type BeaconReplanItem } from "./beaconModel";

const props = withDefaults(
  defineProps<{
    item: BeaconReplanItem;
    /** The target's name, as the page names it. */
    target: string;
    /** The sources' names (beaconModel replanNames). */
    names: { added: string[]; removed: string[] };
    /** Offer the action: the plan, a waiting plan's review, or the Beacon card. */
    action?: boolean;
    /** This session may file the plan (beaconModel replanMissingScopes is empty). */
    canPlan?: boolean;
    /** The page is reading the node's beacon for the sheet. */
    opening?: boolean;
    /** Without the scopes, link to the target's Beacon card (off on the card itself, which names them). */
    beaconLink?: boolean;
    /** Warning on the Beacon card, where it asks for an action; muted on a path sheet, where the path reads unknown. */
    tone?: "warning" | "muted";
    /** Say who cannot measure what; off on a path sheet, whose reason line already says it for its source. */
    sentences?: boolean;
  }>(),
  { action: true, canPlan: false, opening: false, beaconLink: false, tone: "muted", sentences: true },
);
const emit = defineEmits<{ plan: [] }>();

const { t } = useI18n();
const lines = computed(() => (props.sentences ? replanLines(props.item, props.names, props.target) : []));
const waits = computed(() => !!props.item.pendingApprovalId);
const LINK = "font-medium text-foreground underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";
</script>

<template>
  <div
    :class="cn('space-y-1.5 rounded-md px-2.5 py-2 text-xs', tone === 'warning' ? 'bg-warning/10 text-warning-text' : 'border border-border bg-muted/30 text-foreground')"
    role="status"
    data-testid="beacon-replan"
    :data-reason="item.reason"
  >
    <p v-for="line in lines" :key="line.key" class="break-words">{{ t(line.key, line.params, line.n) }}</p>
    <p v-if="waits" :class="cn('break-words', tone === 'warning' ? 'text-foreground/80' : 'text-muted-foreground')" data-testid="beacon-replan-waits">{{ $t('fleet.monitoring.beacon.replan.waits') }}</p>
    <template v-if="action">
      <div v-if="waits || canPlan || beaconLink" class="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
        <RouterLink v-if="waits" :to="{ name: 'approvals', query: { open: item.pendingApprovalId } }" :class="LINK" data-testid="beacon-replan-review">
          {{ $t('fleet.monitoring.beacon.replan.review') }}
        </RouterLink>
        <Button v-else-if="canPlan" type="button" size="sm" variant="outline" :disabled="opening" :aria-busy="opening || undefined" data-testid="beacon-replan-plan" @click="emit('plan')">
          <RefreshCw v-if="opening" class="size-4 animate-spin" aria-hidden="true" />
          <FilePlus2 v-else class="size-4" aria-hidden="true" />
          {{ opening ? $t('fleet.monitoring.beacon.replan.opening', { target }) : $t('fleet.monitoring.beacon.replan.action') }}
        </Button>
        <RouterLink v-else :to="{ name: 'node-detail', params: { id: item.nodeId }, hash: '#node-beacon' }" :class="LINK" data-testid="beacon-replan-beacon">
          {{ $t('fleet.monitoring.beacon.replan.openBeacon', { target }) }}
        </RouterLink>
      </div>
      <p v-if="canPlan && !waits" :class="tone === 'warning' ? 'text-foreground/80' : 'text-muted-foreground'">{{ $t('fleet.monitoring.beacon.replan.keeps') }}</p>
    </template>
  </div>
</template>
