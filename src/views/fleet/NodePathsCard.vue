<script setup lang="ts">
/**
 * The Paths card on a node's page (design 29 D7): the paths that end at the
 * node ("reached by") and the paths that start from it ("reaches"), each
 * with its window p50 or, when it is not up, why, and a link to that path's
 * sheet in Monitoring. It reads the same matrix Monitoring draws, so a server
 * from before design 29 answers through the latency plan, as there.
 *
 * It replaces the latency card, which read the same paths with its own
 * windows; one card, one window control.
 */
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { Route } from "lucide-vue-next";

import { api, unwrap, type MonitorView, type MonitorWindow, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";

import DataState from "@/components/common/DataState.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import WindowControl from "./WindowControl.vue";
import NodePathList from "./NodePathList.vue";
import { NODE_PATHS_SHOWN, NODE_PATH_DEFAULT_WINDOW, NODE_PATH_WINDOWS, monitoringQuery, nodePaths } from "./nodePathsModel";
import type { PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import { usePathsData } from "./usePathsData";

const props = defineProps<{ node: Pick<Node, "id" | "name">; nodes?: Node[] }>();

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("monitor:read"));
const { windowLong } = usePathsCopy();

const requested = ref<MonitorWindow>(NODE_PATH_DEFAULT_WINDOW);
const nodeName = (id: string) => props.nodes?.find((n) => n.id === id)?.name;
// The checks' names, for the paths of checks that start or end here; the matrix names only nodes.
const monitorsQuery = useAsyncData<MonitorView[]>(
  (signal) => (canRead.value ? api.monitors.list({ signal }).then((r) => unwrap(r, "monitors")) : Promise.resolve([])),
  { pollInterval: 60000, immediate: canRead.value },
);
const checkName = (id: string) => monitorsQuery.data.value?.find((m) => m.id === id)?.name || undefined;
const data = usePathsData({
  requested,
  canRead,
  checkName,
  nodeName,
  controlPlane: () => t("fleet.monitoring.result.controlPlane"),
  extras: false,
});
const offered = computed(() => NODE_PATH_WINDOWS.filter((w) => data.offered.value.includes(w)));
const lists = computed(() => nodePaths(data.matrix.value, props.node.id));
const involved = computed(() => lists.value.reachedBy.length > 0 || lists.value.reaches.length > 0);
const displayName = computed(() => props.node.name || props.node.id);

function pathLink(path: PathItem) {
  return { name: "monitoring", query: { view: "network", as: "list", path: path.key, window: data.window.value } };
}

const STEP = "text-xs font-medium text-muted-foreground";
</script>

<template>
  <Card v-if="canRead" data-testid="node-paths">
    <CardHeader>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <CardTitle class="flex items-center gap-2">
          <Route class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('fleet.monitoring.nodePaths.title') }}
        </CardTitle>
        <WindowControl v-if="offered.length > 1" v-model="requested" :offered="offered" :label="$t('fleet.monitoring.nodePaths.windowLabel')" />
      </div>
      <CardDescription>{{ $t('fleet.monitoring.nodePaths.description', { window: windowLong(data.window.value) }) }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4 text-sm">
      <DataState
        :loading="data.pathsQuery.loading.value"
        :error="data.pathsQuery.error.value ?? null"
        :has-data="!!data.matrix.value"
        :skeleton-rows="3"
        @retry="data.pathsQuery.refresh"
      >
        <div class="space-y-4">
        <p v-if="!involved" class="text-muted-foreground" data-testid="node-paths-none">{{ $t('fleet.monitoring.nodePaths.notInvolved') }}</p>
        <template v-else>
          <section class="space-y-1.5" data-testid="node-reached-by">
            <h3 :class="STEP">{{ $t('fleet.monitoring.nodePaths.reachedBy') }} <span class="font-normal tabular">{{ lists.reachedBy.length }}</span></h3>
            <NodePathList v-if="lists.reachedBy.length" :paths="lists.reachedBy" side="reachedBy" :link-to="pathLink" />
            <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.nodePaths.noneReachedBy') }}</p>
            <p v-if="lists.reachedBy.length > NODE_PATHS_SHOWN" class="text-xs text-muted-foreground">
              {{ $t('fleet.monitoring.nodePaths.more', { n: lists.reachedBy.length - NODE_PATHS_SHOWN }) }}
              <RouterLink
                :to="{ name: 'monitoring', query: { view: 'network', as: 'list', 'paths.q': monitoringQuery('reachedBy', displayName), window: data.window.value } }"
                class="font-medium text-foreground underline underline-offset-2"
              >{{ $t('fleet.monitoring.nodePaths.open') }}</RouterLink>
            </p>
          </section>
          <section class="space-y-1.5" data-testid="node-reaches">
            <h3 :class="STEP">{{ $t('fleet.monitoring.nodePaths.reaches') }} <span class="font-normal tabular">{{ lists.reaches.length }}</span></h3>
            <NodePathList v-if="lists.reaches.length" :paths="lists.reaches" side="reaches" :link-to="pathLink" />
            <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.nodePaths.noneReaches') }}</p>
            <p v-if="lists.reaches.length > NODE_PATHS_SHOWN" class="text-xs text-muted-foreground">
              {{ $t('fleet.monitoring.nodePaths.more', { n: lists.reaches.length - NODE_PATHS_SHOWN }) }}
              <RouterLink
                :to="{ name: 'monitoring', query: { view: 'network', as: 'list', 'paths.q': monitoringQuery('reaches', displayName), window: data.window.value } }"
                class="font-medium text-foreground underline underline-offset-2"
              >{{ $t('fleet.monitoring.nodePaths.open') }}</RouterLink>
            </p>
          </section>
        </template>
        <p v-if="data.source.value === 'legacy'" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.nodePaths.legacy') }}</p>
        <RouterLink
          :to="{ name: 'monitoring', query: { view: 'network', window: data.window.value } }"
          class="inline-block text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
        >{{ $t('fleet.monitoring.nodePaths.openMonitoring') }}</RouterLink>
        </div>
      </DataState>
    </CardContent>
  </Card>
</template>
