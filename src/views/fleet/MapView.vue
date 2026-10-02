<script setup lang="ts">
/**
 * The fleet map (design 23, 4.2): where the nodes are, as status clusters
 * with counts, and a click that opens the node.
 *
 *   observed 4s ago · 31 of 34 located · 2 not reporting · 3 unlocated
 *   [map: clusters coloured by their worst member, a red count of the down]
 *   On one spot: 13 nodes in Los Angeles      Unlocated: 3 nodes [Set location]
 *
 * A cluster that a zoom can split zooms in; one node opens the node sheet on
 * ?open=; several mostly on one spot are listed on the first click, in a
 * panel beside the cluster (under the map on a phone), non-reporting first,
 * with focus moved into it. Editing a location
 * moved to the node's Settings, so the map no longer opens an editor, and
 * the trackpad hint is for pointers that have a trackpad, not phones.
 */
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { toast } from "vue-sonner";
import { RotateCw } from "lucide-vue-next";

import { api, unwrap, type Node, type NodeGeoResolveResult } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useAuthStore } from "@/stores/auth";
import { countryName } from "@/lib/fleet";
import { compareByAttention, describeNodeStatus, isReporting, nodeStatus } from "@/lib/nodeStatus";
import { useMediaQuery } from "@/composables/useMediaQuery";
import { clusterPlace } from "./fleetMapModel";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import DataState from "@/components/common/DataState.vue";
import FleetMap from "@/components/fleet/FleetMap.vue";
import NodeSheet from "@/components/fleet/NodeSheet.vue";
import { Button } from "@/components/ui/button";

const auth = useAuthStore();
const { t, locale } = useI18n();
const canAdminNodes = computed(() => auth.can("node:admin"));

const nodesQuery = useAsyncData<Node[]>((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 10_000,
});
const nodes = computed(() => nodesQuery.data.value ?? []);
const proof = useProof(nodesQuery);

const owned = useOwnedRoute();
const sheet = bindRouteOpen(owned);

function located(node: Node): boolean {
  return typeof node.geo?.lat === "number" && typeof node.geo?.lon === "number";
}
const locatedNodes = computed(() => nodes.value.filter(located));
const unlocated = computed(() => nodes.value.filter((node) => !located(node)));
const down = computed(() => nodes.value.filter((node) => ["offline", "never_reported"].includes(nodeStatus(node))));

const proofSegments = computed<ProofSegment[]>(() => {
  const out: ProofSegment[] = [{ key: "located", text: t("fleet.map.proof.located", { located: locatedNodes.value.length, total: nodes.value.length }) }];
  if (down.value.length) out.push({ key: "down", text: t("fleet.map.proof.down", { n: down.value.length }), tone: "destructive", to: { name: "nodes", query: { status: "offline" } } });
  if (unlocated.value.length) out.push({ key: "unlocated", text: t("fleet.map.proof.unlocated", { n: unlocated.value.length }), tone: "muted" });
  return out;
});

/* ------------------------------ locate missing ------------------------------ */

const resolving = ref(false);

async function locateMissing(): Promise<void> {
  resolving.value = true;
  try {
    const response = await api.nodes.resolveGeo({ all: true, missing_only: true });
    report(response.results ?? []);
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.resolveFailed"));
  } finally {
    resolving.value = false;
  }
}

function report(results: NodeGeoResolveResult[]): void {
  if (results.some((result) => result.status === "resolver_disabled")) {
    toast.error(t("fleet.map.toast.resolverDisabled"));
    return;
  }
  const updated = results.filter((result) => result.status === "updated").length;
  const unresolved = results.filter((result) => ["lookup_failed", "store_failed", "no_public_ip"].includes(result.status)).length;
  if (updated > 0 && unresolved > 0) toast.warning(t("fleet.map.toast.resolvedWithFailures", { count: updated, failed: unresolved }));
  else if (updated > 0) toast.success(t("fleet.map.toast.resolved", { count: updated }));
  else if (unresolved > 0) toast.error(t("fleet.map.toast.resolveNoPublicIp", { count: unresolved }));
  else toast.info(t("fleet.map.toast.resolveNoop"));
}

const attention = computed<AttentionItem[]>(() => {
  if (!unlocated.value.length) return [];
  const names = unlocated.value.slice(0, 3).map((node) => node.name || node.id).join(", ");
  return [
    {
      key: "unlocated",
      tone: "info",
      claim: t("fleet.map.attention.unlocated", { n: unlocated.value.length }, unlocated.value.length),
      proof: unlocated.value.length > 3 ? `${names} +${unlocated.value.length - 3}` : names,
      action: canAdminNodes.value ? { label: t("fleet.map.actions.resolveMissing"), run: () => void locateMissing() } : undefined,
    },
  ];
});

/* --------------------------- a cluster on one spot --------------------------- */

/**
 * Members of a cluster that a zoom would not split. From 768 px they open in
 * a panel beside the cluster, over the map; on a phone, under the map,
 * scrolled into view. Either way focus moves to the list's heading, and
 * Escape or Close gives it back to the cluster. Non-reporting members come
 * first: the offline node was eighth of twelve.
 */
const listedIds = ref<string[]>([]);
const listed = computed(() =>
  listedIds.value
    .map((id) => nodes.value.find((node) => node.id === id))
    .filter((node): node is Node => !!node)
    .sort((a, b) => compareByAttention(a, b) || (a.name || a.id).localeCompare(b.name || b.id)),
);
const listedPlace = computed(() => {
  const where = clusterPlace(listed.value.map((node) => node.geo));
  switch (where.kind) {
    case "city":
      return [where.city, where.country].filter(Boolean).join(", ");
    case "country":
      return countryName(where.country, locale.value);
    case "places":
      return t("fleet.map.cluster.places", { n: where.count });
    default:
      return "";
  }
});
const wide = useMediaQuery("(min-width: 768px)");
const mapWrap = ref<HTMLElement | null>(null);
const listHeading = ref<HTMLElement | null>(null);
let listOpener: Element | null = null;
/** Where the cluster sits inside the map, for the panel beside it. */
const anchor = ref<{ left: number; top: number; width: number; height: number } | null>(null);
const PANEL_W = 320;
const panelStyle = computed(() => {
  const at = anchor.value;
  if (!at) return {};
  const maxHeight = Math.max(160, Math.min(360, at.height - 16));
  const right = at.left + 24 + PANEL_W <= at.width - 8;
  const left = right ? at.left + 24 : Math.max(8, at.left - 24 - PANEL_W);
  const top = Math.min(Math.max(8, at.top - 28), Math.max(8, at.height - maxHeight - 8));
  return { left: `${left}px`, top: `${top}px`, width: `${PANEL_W}px`, maxHeight: `${maxHeight}px` };
});

function onSelect(ids: string[], opener: Element): void {
  if (ids.length === 1) {
    closeList(false);
    sheet.open(ids[0]!, opener as HTMLElement);
    return;
  }
  listOpener = opener;
  const wrap = mapWrap.value?.getBoundingClientRect();
  const mark = opener.getBoundingClientRect();
  anchor.value = wrap
    ? { left: mark.left + mark.width / 2 - wrap.left, top: mark.top + mark.height / 2 - wrap.top, width: wrap.width, height: wrap.height }
    : null;
  listedIds.value = ids;
  void nextTick(() => {
    const heading = listHeading.value;
    if (!heading) return;
    heading.focus({ preventScroll: wide.value });
    if (!wide.value) heading.scrollIntoView({ block: "nearest" });
  });
}

function closeList(returnFocus = true): void {
  listedIds.value = [];
  anchor.value = null;
  const opener = listOpener;
  listOpener = null;
  if (returnFocus && (opener instanceof HTMLElement || opener instanceof SVGElement)) opener.focus();
}

/** Why the node read failed, for the sheet; null while a first read retries, so the sheet shows it loading. */
const sheetError = computed(() => (nodesQuery.error.value && !nodesQuery.loading.value ? proofReason(nodesQuery.error.value) : null));

function openTerminal(node: Node): void {
  if (!auth.can("terminal:open") || !isReporting(node)) return;
  window.open(`/terminal?node_id=${encodeURIComponent(node.id)}&connect=1`, "_blank", "noopener");
}

const STATUS_TEXT: Record<string, string> = {
  success: "text-muted-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.map.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.map.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="nodesQuery.refresh" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" type="button" :disabled="nodesQuery.refreshing.value" @click="nodesQuery.refresh">
          <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <EmptyState
      v-if="nodesQuery.data.value !== undefined && nodes.length === 0"
      :title="$t('fleet.map.emptyTitle')"
      :description="$t('fleet.map.emptyDescription')"
    />
    <template v-else-if="nodesQuery.data.value !== undefined">
      <div class="min-w-0 space-y-2">
        <div ref="mapWrap" class="relative">
          <FleetMap :nodes="nodes" :active-ids="sheet.openId.value ? [sheet.openId.value] : listedIds" @select="onSelect" />
          <!-- From 768 px: the members beside the cluster they came from. -->
          <section
            v-if="listed.length && wide"
            class="absolute z-20 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
            :style="panelStyle"
            aria-labelledby="map-listed"
            data-testid="map-listed-panel"
            @keydown.esc.stop.prevent="closeList()"
          >
            <header class="flex items-center gap-2 border-b border-border px-3 py-2">
              <h2 id="map-listed" ref="listHeading" tabindex="-1" class="min-w-0 truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {{ $t('fleet.map.listed.title', { n: listed.length, place: listedPlace || $t('fleet.map.cluster.somewhere') }) }}
              </h2>
              <Button variant="ghost" size="sm" class="ms-auto shrink-0" type="button" @click="closeList()">{{ $t('common.actions.close') }}</Button>
            </header>
            <ul class="min-h-0 divide-y divide-border overflow-y-auto">
              <li v-for="node in listed" :key="node.id">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
                  @click="sheet.open(node.id, $event.currentTarget as HTMLElement)"
                >
                  <StatusDot :status="describeNodeStatus(node).health" :pulse="false" />
                  <span class="min-w-0 truncate font-medium">{{ node.name || node.id }}</span>
                  <span
                    v-if="nodeStatus(node) !== 'online'"
                    :class="cn('ms-auto shrink-0 text-xs', STATUS_TEXT[describeNodeStatus(node).tone])"
                  >{{ $t(describeNodeStatus(node).labelKey) }}</span>
                </button>
              </li>
            </ul>
          </section>
        </div>
        <p class="hidden text-xs text-muted-foreground pointer-fine:block">{{ $t('fleet.map.canvasHint') }}</p>
      </div>

      <div class="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <!-- On a phone: the members under the map, scrolled into view. -->
        <section
          v-if="listed.length && !wide"
          class="overflow-hidden rounded-lg border border-border bg-card"
          aria-labelledby="map-listed"
          data-testid="map-listed-panel"
          @keydown.esc.stop.prevent="closeList()"
        >
          <header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <h2 id="map-listed" ref="listHeading" tabindex="-1" class="rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {{ $t('fleet.map.listed.title', { n: listed.length, place: listedPlace || $t('fleet.map.cluster.somewhere') }) }}
            </h2>
            <Button variant="ghost" size="sm" class="ms-auto" type="button" @click="closeList()">{{ $t('common.actions.close') }}</Button>
          </header>
          <ul class="divide-y divide-border">
            <li v-for="node in listed" :key="node.id">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
                @click="sheet.open(node.id, $event.currentTarget as HTMLElement)"
              >
                <StatusDot :status="describeNodeStatus(node).health" />
                <span class="min-w-0 truncate font-medium">{{ node.name || node.id }}</span>
                <span
                  v-if="nodeStatus(node) !== 'online'"
                  :class="cn('ms-auto shrink-0 text-xs', STATUS_TEXT[describeNodeStatus(node).tone])"
                >{{ $t(describeNodeStatus(node).labelKey) }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- Nodes without coordinates: where to set them. -->
        <section v-if="unlocated.length" class="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="map-unlocated">
          <header class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <h2 id="map-unlocated" class="text-sm font-medium">{{ $t('fleet.map.unlocated.title') }}</h2>
            <span v-if="canAdminNodes" class="text-xs text-muted-foreground">{{ $t('fleet.map.unlocated.hint') }}</span>
          </header>
          <ul class="divide-y divide-border">
            <li v-for="node in unlocated" :key="node.id" class="flex items-center gap-2 px-4 py-2 text-sm">
              <StatusDot :status="describeNodeStatus(node).health" />
              <button
                type="button"
                class="min-w-0 truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                @click="sheet.open(node.id, $event.currentTarget as HTMLElement)"
              >
                {{ node.name || node.id }}
              </button>
              <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ node.public_ip || $t('fleet.map.unlocated.noIp') }}</span>
              <RouterLink
                v-if="canAdminNodes"
                :to="{ name: 'node-detail', params: { id: node.id }, query: { view: 'settings' }, hash: '#node-geo' }"
                class="ms-auto shrink-0 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                {{ $t('fleet.map.unlocated.set') }}
              </RouterLink>
            </li>
          </ul>
        </section>
      </div>
    </template>
    <div v-else-if="nodesQuery.loading.value" class="grid aspect-[2/1] place-items-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
      {{ $t('common.proof.reading') }}
    </div>
    <!-- The first read failed: no map is drawn from nothing. -->
    <DataState v-else :loading="false" :error="nodesQuery.error.value ?? null" @retry="nodesQuery.refresh" />

    <NodeSheet
      :node-id="sheet.openId.value"
      :nodes="nodesQuery.data.value"
      :error="sheetError"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
      @terminal="openTerminal"
      @retry="nodesQuery.refresh"
    />
  </div>
</template>
