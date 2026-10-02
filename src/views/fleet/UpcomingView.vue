<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useNow } from "@vueuse/core";
import { RotateCw } from "lucide-vue-next";
import { api, unwrap, type ExpiringItem, type MachineView } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMachineLinkReveal } from "@/composables/useMachineLinkReveal";
import { cn } from "@/lib/utils";
import {
  EXPIRING_KINDS,
  LIST_WITHIN_DAYS,
  filterByKinds,
  hiddenKindsOf,
  isUnsupported,
  kindCounts,
  kindFilterQuery,
  parseKindFilter,
  toggleKind,
  type KnownKind,
} from "./upcomingModel";

import PageHeader from "@/components/common/PageHeader.vue";
import UpcomingBody from "@/components/fleet/UpcomingBody.vue";
import UpcomingProof from "@/components/fleet/UpcomingProof.vue";
import RecordRenewalDialog from "@/components/fleet/RecordRenewalDialog.vue";
import MachineLinkStepUpDialog from "@/components/fleet/MachineLinkStepUpDialog.vue";
import { Button } from "@/components/ui/button";

/**
 * Everything that runs out in the next 90 days, overdue first, grouped by
 * week: the same rows as home's Upcoming panel with a longer reach and a kind
 * filter. The filter lives in the address bar (`?kind=share,vpn_user`), so a
 * filtered view survives a reload and opens the same way from a shared link.
 */
const route = useRoute();
const router = useRouter();
const now = useNow({ interval: 1000 });

const query = useAsyncData((signal) => api.expiring.list(LIST_WITHIN_DAYS, { signal }), { pollInterval: 60_000 });

const kinds = computed(() => parseKindFilter(route.query.kind));
const allItems = computed(() => query.data.value?.items ?? []);
const visible = computed(() => filterByKinds(allItems.value, kinds.value));
const counts = computed(() => kindCounts(allItems.value));
// Counts only for a list that loaded: a failed read is not zero of anything,
// and a server without the list has nothing for the chips to filter.
const loaded = computed(() => query.data.value !== undefined);
const unsupported = computed(() => isUnsupported(query.error.value));
// A kind the session cannot read gets no chip: it would only ever count zero.
const chipKinds = computed(() => {
  const hidden = hiddenKindsOf(query.data.value);
  return EXPIRING_KINDS.filter((kind) => !hidden.includes(kind));
});

function setKinds(next: KnownKind[]): void {
  const wanted = kindFilterQuery(next);
  if (route.query.kind === wanted) return;
  router.replace({ query: { ...route.query, kind: wanted } }).catch(() => {});
}

/*
 * Record renewal from a machine's row, in one step (RecordRenewalDialog).
 * Offered on machines that do not renew by themselves: those are the rows
 * that need a hand, and an auto-roll machine's date moves without anyone
 * (its sheet in Inventory still offers it, to set a different date). The row
 * knows the due date but not the billing cycle, so the dialog reads the
 * machine list when it opens; recording refreshes the list, and the row
 * moves to its new week.
 */
const { t } = useI18n();
const auth = useAuthStore();
const renewable = (item: ExpiringItem) =>
  item.kind === "machine_renewal" && item.state !== "auto" && !!item.id && auth.can("inventory:admin");
const renewOpen = ref(false);
const renewMachine = ref<MachineView | null>(null);
const renewLoading = ref(false);
const renewError = ref<string | null>(null);
let renewRead = 0;

async function openRenewal(item: ExpiringItem): Promise<void> {
  const read = ++renewRead;
  renewOpen.value = true;
  renewMachine.value = null;
  renewError.value = null;
  renewLoading.value = true;
  try {
    const found = unwrap(await api.machines.list(), "machines").find((m) => m.id === item.id) ?? null;
    if (read !== renewRead) return;
    renewMachine.value = found;
    if (!found) renewError.value = t("fleet.renewal.gone");
  } catch (error) {
    if (read !== renewRead) return;
    renewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (read === renewRead) renewLoading.value = false;
  }
}

// Paying the provider comes first, so the dialog offers the machine's stored
// console link; it opens behind the same step-up as on Inventory.
const { stepUp: linkStepUp, pending: linkPending, reveal: revealLink } = useMachineLinkReveal();
const canOpenConsole = computed(() => !!renewMachine.value?.has_console_url && auth.can("inventory:admin"));

const chipClass = (active: boolean) =>
  cn(
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background pointer-coarse:h-11",
    active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-muted/40",
  );
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.upcoming.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.upcoming.description') }}</p>
        <UpcomingProof :query="query" :items="visible" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="query.refreshing.value" @click="query.refresh">
          <RotateCw :class="cn('size-4', query.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Kind chips: a multi-select filter, drawn as bordered chips like SSH
         Guard's so it never reads as a layer row. At 375 the row scrolls
         sideways rather than wrapping into a wall, and the scroll padding
         brings a chip reached by keyboard fully into view. -->
    <div v-if="!unsupported" class="-mx-4 relative scroll-px-4 overflow-x-auto px-4 py-1 sm:mx-0 sm:scroll-px-0 sm:px-0">
      <div
        class="inline-flex gap-1.5"
        role="group"
        :aria-label="$t('fleet.upcoming.filter.label')"
      >
        <button type="button" :aria-pressed="kinds.length === 0" :class="chipClass(kinds.length === 0)" @click="setKinds([])">
          {{ $t('fleet.upcoming.filter.all') }}
          <span v-if="loaded" class="font-mono tabular text-muted-foreground">{{ allItems.length }}</span>
        </button>
        <button
          v-for="kind in chipKinds"
          :key="kind"
          type="button"
          :aria-pressed="kinds.includes(kind)"
          :class="chipClass(kinds.includes(kind))"
          @click="setKinds(toggleKind(kinds, kind))"
        >
          {{ $t(`fleet.upcoming.filter.${kind}`) }}
          <span v-if="loaded" class="font-mono tabular text-muted-foreground">{{ counts[kind] }}</span>
        </button>
      </div>
    </div>

    <UpcomingBody
      :framed="false"
      :data="query.data.value"
      :error="query.error.value"
      :loading="query.loading.value"
      :last-updated="query.lastUpdated.value"
      :items="visible"
      :filtered="kinds.length > 0"
      :now="now.getTime()"
      :renewable="renewable"
      @retry="query.refresh"
      @clear-filter="setKinds([])"
      @renew="openRenewal"
    />

    <RecordRenewalDialog
      v-model:open="renewOpen"
      :machine="renewMachine"
      :loading="renewLoading"
      :error="renewError"
      machine-link
      :console-link="canOpenConsole"
      :console-pending="!!linkPending"
      @open-console="renewMachine && revealLink(renewMachine, 'console')"
      @recorded="query.refresh"
    />
    <MachineLinkStepUpDialog :step-up="linkStepUp" />
  </div>
</template>
