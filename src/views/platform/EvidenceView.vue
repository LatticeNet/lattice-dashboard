<script setup lang="ts">
/**
 * Evidence: what the nodes actually did, at two levels of structure.
 *
 * Connections is the trace the server assembles from the sing-box log store;
 * Raw log is the line tail those connections were assembled from. They were
 * two nav entries that read the same store and answered consecutive
 * questions, so they are one area with two lenses. The lens lives in the URL
 * under its own key, because the Connections lens has tabs of its own on the
 * default key, and a filter set on one lens (`node_id`) is meant to survive a
 * switch to the other.
 */
import PageHeader from "@/components/common/PageHeader.vue";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouteTab } from "@/composables/useRouteTab";

import ConnectionTraceView from "./ConnectionTraceView.vue";
import LogsView from "./LogsView.vue";

export const EVIDENCE_LENSES = ["connections", "log"] as const;
export type EvidenceLens = (typeof EVIDENCE_LENSES)[number];

const lens = useRouteTab<EvidenceLens>(() => EVIDENCE_LENSES, () => "connections", "lens");
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('platform.evidence.title')" :description="$t('platform.evidence.description')" />

    <Tabs v-model="lens">
      <TabsList class="w-full sm:w-auto">
        <TabsTrigger value="connections">{{ $t('platform.evidence.lensConnections') }}</TabsTrigger>
        <TabsTrigger value="log">{{ $t('platform.evidence.lensLog') }}</TabsTrigger>
      </TabsList>
    </Tabs>

    <ConnectionTraceView v-if="lens === 'connections'" embedded />
    <LogsView v-else embedded />
  </div>
</template>
