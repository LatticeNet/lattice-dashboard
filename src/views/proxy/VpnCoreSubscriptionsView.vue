<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Link2, Store, ArrowUpRight } from "lucide-vue-next";
import { api } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { cn } from "@/lib/utils";
import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface SubscriptionSummary {
  user_id: string;
  email?: string;
  enabled: boolean;
  eligible: boolean;
  has_sub_token: boolean;
  binding_count: number;
  credential_count: number;
  expires_at?: string;
}

const { t } = useI18n();
const query = useAsyncData(
  () => api.plugins.call<{ subscriptions: SubscriptionSummary[]; count: number; publisher: string }>("latticenet.vpn-core", "latticenet.vpn-core/subscriptions", "query"),
  { pollInterval: 20000 },
);
const subs = computed<SubscriptionSummary[]>(() => query.data.value?.subscriptions ?? []);
const eligibleCount = computed(() => subs.value.filter((s) => s.eligible).length);
const publisher = computed(() => query.data.value?.publisher ?? "latticenet.sub-store");
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('vpnSubs.title')" :description="$t('vpnSubs.description')">
      <template #status>
        <FreshnessLabel :last-updated="query.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="query.refreshing.value" @click="query.refresh">
          <RefreshCw :class="cn('size-4', query.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- producer/publisher boundary banner (design-12 S5) -->
    <div class="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
      <Store class="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div class="space-y-1">
        <p>{{ $t('vpnSubs.boundary') }}</p>
        <RouterLink
          :to="{ name: 'plugin-view', params: { pluginId: publisher, route: 'sub-store' } }"
          class="inline-flex items-center gap-1 text-primary hover:underline"
        >
          {{ $t('vpnSubs.openSubStore') }} <ArrowUpRight class="size-3.5" aria-hidden="true" />
        </RouterLink>
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <StatCard :label="$t('vpnSubs.kpiIdentities')" :value="subs.length" :icon="Link2" />
      <StatCard :label="$t('vpnSubs.kpiEligible')" :value="eligibleCount" :icon="Link2" tone="success" />
    </div>

    <DataState
      :loading="query.loading.value"
      :error="query.error.value"
      :has-data="query.data.value !== undefined"
      :is-empty="subs.length === 0"
      :empty-title="$t('vpnSubs.emptyTitle')"
      :empty-description="$t('vpnSubs.emptyDescription')"
      @retry="query.refresh"
    >
      <Card>
        <CardContent class="p-0">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('vpnSubs.colEmail') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('vpnSubs.colEligible') }}</th>
                  <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('vpnSubs.colToken') }}</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('vpnSubs.colCreds') }}</th>
                  <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('vpnSubs.colBindings') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in subs" :key="s.user_id" class="border-b border-border last:border-0 hover:bg-muted/40">
                  <td class="px-3 py-3 font-medium">{{ s.email || s.user_id }}</td>
                  <td class="px-3 py-3">
                    <Badge :variant="s.eligible ? 'success' : 'secondary'">
                      {{ s.eligible ? $t('vpnSubs.eligible') : $t('vpnSubs.ineligible') }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3">
                    <Badge :variant="s.has_sub_token ? 'outline' : 'secondary'" class="text-[11px]">
                      {{ s.has_sub_token ? $t('vpnSubs.tokenSet') : $t('vpnSubs.tokenNone') }}
                    </Badge>
                  </td>
                  <td class="px-3 py-3 text-right tabular-nums">{{ s.credential_count }}</td>
                  <td class="px-3 py-3 text-right tabular-nums">{{ s.binding_count }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </DataState>
  </div>
</template>
