<script setup lang="ts">
/**
 * Capability gates: which capabilities are allowed to act on this fleet's nodes
 * at all, and what turning one on would refuse right now.
 *
 * This is fleet policy, set rarely and with real consequences, which is why it
 * sits in Settings beside the other things you configure once and then live
 * with. Per-node decisions belong on the node, and this page links there rather
 * than duplicating them.
 *
 * The impact is rendered on the row, not behind a "preview" click. Enforcing a
 * capability that cannot derive an answer refuses every node that has no
 * explicit enrolment, and on a fresh table that is the entire fleet - a number
 * nobody should discover by flipping the switch and watching work fail.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { ShieldCheck, TriangleAlert } from "lucide-vue-next";

import { api, type CapabilityImpact } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import MetricStrip, { type Metric } from "@/components/common/MetricStrip.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const { t } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("node:admin"));

const query = useAsyncData<CapabilityImpact[] | undefined>(
  () => api.capabilities.list().then((r) => r.capabilities ?? []),
  { pollInterval: 30000 },
);

const capabilities = computed(() => query.data.value ?? []);

/**
 * Ordered by how much attention each one wants: live gates first, because those
 * are the ones currently refusing anything; then the ones that change nodes and
 * could be turned on; then the reads. Alphabetical inside each band so the list
 * does not reshuffle as counts move.
 */
const ordered = computed(() =>
  [...capabilities.value].sort((a, b) => {
    const rank = (c: CapabilityImpact) => (c.enforced ? 0 : c.mutates ? 1 : 2);
    return rank(a) - rank(b) || a.capability.localeCompare(b.capability);
  }),
);

const summary = computed<Metric[]>(() => {
  const live = capabilities.value.filter((c) => c.enforced);
  const mutating = capabilities.value.filter((c) => c.mutates);
  return [
    { key: "live", label: t("settings.capabilities.metrics.live"), value: live.length, icon: ShieldCheck },
    {
      key: "ungated",
      label: t("settings.capabilities.metrics.ungated"),
      value: mutating.filter((c) => !c.enforced).length,
      // Not a fault: an ungated capability behaves the way it always did. It is
      // worth counting because it is the work remaining, not because it is broken.
      tone: "muted",
    },
    { key: "total", label: t("settings.capabilities.metrics.total"), value: capabilities.value.length },
  ];
});

const pending = ref("");
const confirmOpen = ref(false);
const confirmTarget = ref<CapabilityImpact | undefined>();

/**
 * Both directions are confirmed, and both for a reason that survives scrutiny.
 *
 * Turning a gate on can refuse working operations immediately, and the number is
 * knowable in advance. Turning one off is a security downgrade. Neither is
 * reversible bookkeeping like enrolling a node, which is why those got no dialog
 * and these do: a confirmation is worth something only where the consequence is
 * real and the sentence can name it.
 */
function requestToggle(capability: CapabilityImpact) {
  confirmTarget.value = capability;
  confirmOpen.value = true;
}

const confirmBody = computed(() => {
  const target = confirmTarget.value;
  if (!target) return "";
  if (target.enforced) {
    return t("settings.capabilities.confirm.disableBody", { capability: target.capability });
  }
  return t("settings.capabilities.confirm.enableBody", {
    capability: target.capability,
    refuse: target.refuse_count,
    allow: target.allow_count,
  });
});

async function applyToggle() {
  const target = confirmTarget.value;
  if (!target) return;
  confirmOpen.value = false;
  pending.value = target.capability;
  try {
    await api.capabilities.setEnforced(target.capability, !target.enforced);
    toast.success(t("settings.capabilities.saved", { capability: target.capability }));
    query.refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    pending.value = "";
    confirmTarget.value = undefined;
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      :title="$t('settings.capabilities.title')"
      :description="$t('settings.capabilities.description')"
    />

    <MetricStrip :metrics="summary" :columns="3" />

    <Card>
      <CardHeader>
        <CardTitle>{{ $t('settings.capabilities.gatesTitle') }}</CardTitle>
        <CardDescription>{{ $t('settings.capabilities.gatesDescription') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="query.loading.value"
          :error="query.error.value"
          :has-data="query.data.value !== undefined"
          :is-empty="capabilities.length === 0"
          :empty-description="$t('settings.capabilities.empty')"
          :skeleton-rows="4"
          @retry="query.refresh"
        >
          <div class="divide-y divide-border/60">
            <div
              v-for="capability in ordered"
              :key="capability.capability"
              class="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0"
            >
              <div class="min-w-0 flex-1">
                <p class="truncate font-mono text-sm">{{ capability.capability }}</p>
                <p class="text-xs text-muted-foreground">
                  {{ capability.mutates
                    ? $t('settings.capabilities.mutates')
                    : $t('settings.capabilities.reads') }}
                  <!-- Only meaningful for a capability that defaults to
                       refusing. A read defaults to allowing, so having nothing
                       to infer from costs it nothing. -->
                  <template v-if="capability.mutates && !capability.derived">
                    · {{ $t('settings.capabilities.noDerivation') }}
                  </template>
                </p>
              </div>

              <!-- The impact, on the row. A capability that would refuse the
                   whole fleet says so here rather than after the switch. -->
              <p
                :class="cn(
                  'shrink-0 text-xs tabular',
                  !capability.enforced && capability.refuse_count > 0 && capability.allow_count === 0
                    ? 'text-warning'
                    : 'text-muted-foreground',
                )"
              >
                {{ $t('settings.capabilities.impact', {
                  allow: capability.allow_count,
                  refuse: capability.refuse_count,
                }) }}
              </p>

              <Badge class="shrink-0" :variant="capability.enforced ? 'success' : 'outline'">
                {{ capability.enforced
                  ? $t('settings.capabilities.state.enforced')
                  : $t('settings.capabilities.state.open') }}
              </Badge>

              <Button
                class="shrink-0"
                size="sm"
                :variant="capability.enforced ? 'ghost' : 'outline'"
                :disabled="!canAdmin || pending === capability.capability"
                @click="requestToggle(capability)"
              >
                {{ capability.enforced
                  ? $t('settings.capabilities.turnOff')
                  : $t('settings.capabilities.turnOn') }}
              </Button>
            </div>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmTarget?.enforced
        ? $t('settings.capabilities.confirm.disableTitle')
        : $t('settings.capabilities.confirm.enableTitle')"
      :description="confirmBody"
      :confirm-label="confirmTarget?.enforced
        ? $t('settings.capabilities.turnOff')
        : $t('settings.capabilities.turnOn')"
      :variant="confirmTarget?.enforced ? 'destructive' : 'default'"
      :pending="!!pending"
      @confirm="applyToggle"
    >
      <!-- Name the nodes, not just the count. Whether the answer is "the three
           I excluded" or "everything" is the difference between a fine change
           and a fleet-wide outage. -->
      <ul
        v-if="!confirmTarget?.enforced && confirmTarget?.refused?.length"
        class="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs"
      >
        <li v-for="node in confirmTarget.refused" :key="node.node_id" class="flex items-start gap-2">
          <TriangleAlert class="mt-0.5 size-3 shrink-0 text-warning" aria-hidden="true" />
          <span class="min-w-0">
            <span class="font-medium">{{ node.name || node.node_id }}</span>
            <span v-if="node.reason" class="text-muted-foreground"> — {{ node.reason }}</span>
          </span>
        </li>
      </ul>
    </ConfirmDialog>
  </div>
</template>
