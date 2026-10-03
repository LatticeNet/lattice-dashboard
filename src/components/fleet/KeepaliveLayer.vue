<script setup lang="ts">
/**
 * Monitoring's Keepalive layer: the incidents the server holds (pending,
 * open, acknowledged, recent resolved), filtered in the address, with the
 * maintenance windows that hold their messages.
 *
 *   [banner per active window]                                [End now] [Edit]
 *   [State: Active 5 v] [Kind v] [search........]      [New maintenance window]
 *   (!) sing-box down on DMIT-4        14 min    [Acknowledge] [Snooze v] [Open]
 *       Paged 14:02 · not acknowledged
 *   Maintenance windows
 *   kernel upgrade · vultr-sg, edge · until 15:00                 [Edit] [Delete]
 *
 * The incident list belongs to MonitoringView (its count rides on the layer
 * tab); this component reads the windows and groups itself.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Wrench } from "lucide-vue-next";

import { api, type GroupView, type IncidentListResponse, type MaintenanceWindow, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useIncidentActions } from "@/composables/useIncidentActions";
import { bindQueryParam } from "@/composables/useQueryParam";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import { useAuthStore } from "@/stores/auth";
import { toast } from "@/lib/toast";
import { proofReason } from "@/components/common/proofModel";
import {
  INCIDENT_FILTERS,
  endWindowInput,
  filterCounts,
  kindsPresent,
  knownKind,
  listedWindows,
  parseIncidentFilter,
  visibleIncidents,
  windowCoverage,
  windowPhase,
  type IncidentFilter,
} from "@/views/fleet/incidentsModel";
import IncidentList from "@/components/fleet/IncidentList.vue";
import MaintenanceBanner from "@/components/fleet/MaintenanceBanner.vue";
import MaintenanceWindowSheet from "@/components/fleet/MaintenanceWindowSheet.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const props = defineProps<{
  owned: OwnedRoute;
  response?: IncidentListResponse;
  error?: unknown;
  loading: boolean;
  nodes: Node[];
  /** Monitor names by id, for failing monitors' claims. */
  monitorNames?: ReadonlyMap<string, string>;
  now: number;
}>();
const emit = defineEmits<{ refresh: [] }>();

const { t, locale } = useI18n();
const auth = useAuthStore();
const canAdmin = computed(() => auth.can("monitor:admin"));
const confined = computed(() => (auth.principal?.server_allowlist ?? []).some((id) => id !== "*") && !(auth.principal?.server_allowlist ?? []).includes("*"));

const filter = bindQueryParam<IncidentFilter>(props.owned, "state", {
  parse: (raw) => parseIncidentFilter(raw),
  format: (value) => (value === "active" ? undefined : value),
});
const kind = bindQueryParam<string>(props.owned, "kind", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => value || undefined,
});
const search = bindQueryParam<string>(props.owned, "q", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => value || undefined,
});

const windowsQuery = useAsyncData((signal) => api.maintenance.list({ signal }).then((r) => r.windows ?? []), { pollInterval: 30_000 });
const groupsQuery = useAsyncData<GroupView[]>(
  (signal) => (auth.can("group:read") ? api.groups.list({ signal }).then((r) => r.groups ?? []) : Promise.resolve([])),
  { pollInterval: 0 },
);

const incidents = computed(() => props.response?.incidents ?? []);
const counts = computed(() => filterCounts(incidents.value, props.now));
const kinds = computed(() => kindsPresent(incidents.value));
const actions = useIncidentActions(() => emit("refresh"));
const rows = computed(() => visibleIncidents(incidents.value, { filter: filter.value, kind: kind.value, search: search.value }, props.now, actions.held.value));

const nodeNames = computed(() => new Map(props.nodes.map((n) => [n.id, n.name || n.id])));
const groupNames = computed(() => new Map((groupsQuery.data.value ?? []).map((g) => [g.id, g.name])));
const activeWindows = computed(() => props.response?.windows ?? (windowsQuery.data.value ?? []).filter((w) => windowPhase(w, props.now) === "active"));
const listed = computed(() => listedWindows(windowsQuery.data.value ?? [], props.now));

function kindLabel(value: string): string {
  const known = knownKind(value);
  return known ? t(`fleet.keepalive.kind.${known.replace(".", "_")}`) : value;
}

/* --------------------------- maintenance windows --------------------------- */

const sheetOpen = ref(false);
const editing = ref<MaintenanceWindow | undefined>();
const ending = ref<string | null>(null);
const deleting = ref<MaintenanceWindow | undefined>();
const deletePending = ref(false);

function newWindow(): void {
  editing.value = undefined;
  sheetOpen.value = true;
}

function editWindow(window: MaintenanceWindow): void {
  editing.value = window;
  sheetOpen.value = true;
}

function onSaved(): void {
  sheetOpen.value = false;
  void windowsQuery.refresh();
  emit("refresh");
}

async function endWindow(window: MaintenanceWindow): Promise<void> {
  ending.value = window.id;
  try {
    await api.maintenance.upsert(endWindowInput(window, Date.now()));
    toast.success(t("fleet.keepalive.maintenance.toast.ended", { name: window.name }));
    void windowsQuery.refresh();
    emit("refresh");
  } catch (error) {
    toast.error(error instanceof Error && error.message ? error.message : t("fleet.keepalive.maintenance.toast.saveFailed"));
  } finally {
    ending.value = null;
  }
}

async function confirmDelete(): Promise<void> {
  const window = deleting.value;
  if (!window || deletePending.value) return;
  deletePending.value = true;
  try {
    await api.maintenance.delete(window.id);
    toast.success(t("fleet.keepalive.maintenance.toast.deleted", { name: window.name }));
    deleting.value = undefined;
    void windowsQuery.refresh();
    emit("refresh");
  } catch (error) {
    toast.error(error instanceof Error && error.message ? error.message : t("fleet.keepalive.maintenance.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}

function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date(props.now).toDateString();
  return d.toLocaleString(locale.value, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function coverageText(window: MaintenanceWindow): string {
  const c = windowCoverage(window, nodeNames.value, groupNames.value);
  return [...c.nodes, ...c.groups.map((g) => t("fleet.keepalive.maintenance.groupName", { name: g }))].join(", ");
}
</script>

<template>
  <div class="space-y-4" data-testid="keepalive-layer">
    <MaintenanceBanner
      :windows="activeWindows"
      :now="now"
      :node-names="nodeNames"
      :group-names="groupNames"
      :can-edit="canAdmin"
      :busy="ending"
      @end="endWindow"
      @edit="(w) => editWindow((windowsQuery.data.value ?? []).find((x) => x.id === w.id) ?? w)"
    />

    <div class="flex flex-wrap items-center gap-2">
      <Select v-model="filter">
        <!-- The trigger names the filter and its live count itself: SelectValue
             would keep the count the item showed when it was chosen. -->
        <SelectTrigger class="h-8 w-auto min-w-0 pointer-coarse:h-11" :aria-label="$t('fleet.keepalive.filter.state')">
          <span>{{ $t(`fleet.keepalive.filter.${filter}`) }} <span v-if="response" class="ms-1 font-mono text-xs text-muted-foreground tabular">{{ counts[filter] }}</span></span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="f in INCIDENT_FILTERS" :key="f" :value="f">
            {{ $t(`fleet.keepalive.filter.${f}`) }} <span v-if="response" class="ms-1 font-mono text-xs text-muted-foreground tabular">{{ counts[f] }}</span>
          </SelectItem>
        </SelectContent>
      </Select>
      <Select :model-value="kind || '*'" @update:model-value="(v) => (kind = v === '*' ? '' : String(v))">
        <SelectTrigger class="h-8 w-auto min-w-0 max-w-[14rem] pointer-coarse:h-11" :aria-label="$t('fleet.keepalive.filter.kind')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="*">{{ $t('fleet.keepalive.filter.allKinds') }}</SelectItem>
          <SelectItem v-for="k in kinds" :key="k" :value="k">{{ kindLabel(k) }}</SelectItem>
        </SelectContent>
      </Select>
      <Input v-model="search" type="search" class="h-8 w-full min-w-0 sm:w-56 pointer-coarse:h-11" :placeholder="$t('fleet.keepalive.filter.search')" :aria-label="$t('fleet.keepalive.filter.search')" />
      <Button v-if="canAdmin" variant="outline" size="sm" type="button" class="ms-auto pointer-coarse:h-11" @click="newWindow">
        <Plus aria-hidden="true" />
        {{ $t('fleet.keepalive.maintenance.new') }}
      </Button>
    </div>

    <section class="overflow-hidden rounded-lg border border-border bg-card" :aria-label="$t('fleet.keepalive.listLabel')">
      <div v-if="error && !response" class="flex flex-wrap items-center gap-3 px-4 py-6 text-sm text-muted-foreground">
        <span class="min-w-0 break-words">{{ $t('fleet.keepalive.readFailed', { reason: proofReason(error) }) }}</span>
        <Button variant="outline" size="sm" type="button" @click="emit('refresh')">{{ $t('common.actions.retry') }}</Button>
      </div>
      <p v-else-if="!response && loading" class="px-4 py-6 text-sm text-muted-foreground">{{ $t('fleet.keepalive.reading') }}</p>
      <template v-else>
        <IncidentList
          v-if="rows.length"
          :incidents="rows"
          :now="now"
          :can-admin="canAdmin"
          :busy="actions.busy.value"
          :node-names="nodeNames"
          :monitor-names="monitorNames"
          :focus-request="actions.focusRequest.value"
          @ack="actions.ack"
          @snooze="actions.snooze"
          @focused="actions.focusDone"
        />
        <div v-else class="space-y-1 px-4 py-6">
          <p class="text-sm">{{ filter === 'active' && !kind && !search ? $t('fleet.keepalive.empty.active') : $t('fleet.keepalive.empty.filtered') }}</p>
          <p v-if="filter === 'active'" class="text-xs text-muted-foreground">{{ $t('fleet.keepalive.empty.explain') }}</p>
        </div>
        <p v-if="response && !response.durable" class="border-t border-border px-4 py-2 text-xs text-muted-foreground">{{ $t('fleet.keepalive.notDurable') }}</p>
      </template>
    </section>

    <section v-if="listed.length" class="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="keepalive-windows">
      <h2 id="keepalive-windows" class="flex items-center gap-2 border-b border-border px-3.5 py-2 text-xs font-medium text-muted-foreground">
        <Wrench class="size-3.5" aria-hidden="true" />
        {{ $t('fleet.keepalive.maintenance.listTitle') }}
      </h2>
      <ul class="divide-y divide-border">
        <li v-for="window in listed" :key="window.id" class="flex flex-col gap-2 px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-sm">
              <span class="min-w-0 break-words font-medium">{{ window.name }}</span>
              <Badge :variant="windowPhase(window, now) === 'active' ? 'info' : 'outline'" class="font-normal">
                {{ $t(`fleet.keepalive.maintenance.phase.${windowPhase(window, now)}`) }}
              </Badge>
            </p>
            <p class="mt-0.5 break-words text-xs text-muted-foreground">
              {{ $t('fleet.keepalive.maintenance.row', { covers: coverageText(window), from: clock(window.starts_at), to: clock(window.ends_at) }) }}
              <template v-if="window.reason"> · {{ window.reason }}</template>
            </p>
          </div>
          <div v-if="canAdmin" class="flex shrink-0 gap-1.5">
            <Button variant="ghost" size="sm" type="button" class="pointer-coarse:h-11" @click="editWindow(window)">{{ $t('common.actions.edit') }}</Button>
            <Button variant="ghost" size="sm" type="button" class="text-destructive pointer-coarse:h-11" @click="deleting = window">{{ $t('common.actions.delete') }}</Button>
          </div>
        </li>
      </ul>
    </section>

    <MaintenanceWindowSheet
      :open="sheetOpen"
      :window="editing"
      :nodes="nodes.map((n) => ({ id: n.id, name: n.name || n.id }))"
      :groups="(groupsQuery.data.value ?? []).map((g) => ({ id: g.id, name: g.name }))"
      :allow-groups="!confined"
      @close="sheetOpen = false"
      @saved="onSaved"
    />
    <ConfirmDialog
      :open="!!deleting"
      :title="$t('fleet.keepalive.maintenance.deleteTitle', { name: deleting?.name ?? '' })"
      :description="$t('fleet.keepalive.maintenance.deleteDescription')"
      :confirm-label="$t('common.actions.delete')"
      variant="destructive"
      :pending="deletePending"
      @update:open="(v) => { if (!v) deleting = undefined; }"
      @confirm="confirmDelete"
    />
  </div>
</template>
